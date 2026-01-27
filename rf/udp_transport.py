"""
UDP Transport for CCA Packets

Receives CCA packets from ESP32 via UDP and dispatches to registered handlers.
Uses an internal queue to prevent packet loss during handler processing.

Packet format from ESP32:
  Byte 0: RSSI (signed int8)
  Byte 1: Packet length
  Bytes 2+: Raw CCA packet data

Usage:
    transport = UDPTransport(port=9433)
    transport.on_packet = lambda data, rssi: print(f"Got packet: {data.hex()}")
    await transport.start()
"""

import asyncio
import socket
import struct
import time
from typing import Callable, Optional
from dataclasses import dataclass
from collections import deque
import threading


@dataclass
class CCAPacket:
    """Received CCA packet with metadata."""
    data: bytes
    rssi: int
    direction: str
    timestamp: float


class UDPTransport:
    """
    Async UDP transport for receiving CCA packets from ESP32.

    The ESP32 streams decoded CCA packets over UDP for low-latency,
    reliable packet delivery without the overhead of log parsing.

    Uses an internal queue to buffer packets and prevent loss during
    handler processing.
    """

    DEFAULT_PORT = 9433
    QUEUE_MAX_SIZE = 10000  # Max packets to buffer

    def __init__(self, port: int = DEFAULT_PORT, bind_address: str = "0.0.0.0"):
        """
        Initialize UDP transport.

        Args:
            port: UDP port to listen on (default: 9433)
            bind_address: Address to bind to (default: 0.0.0.0 for all interfaces)
        """
        self.port = port
        self.bind_address = bind_address
        self._socket: Optional[socket.socket] = None
        self._running = False
        self._receive_task: Optional[asyncio.Task] = None
        self._process_task: Optional[asyncio.Task] = None

        # Packet queue for buffering - thread-safe deque with maxlen
        self._packet_queue: deque = deque(maxlen=self.QUEUE_MAX_SIZE)
        self._queue_lock = threading.Lock()
        self._queue_event: Optional[asyncio.Event] = None

        # Callback for received packets
        self.on_packet: Optional[Callable[[bytes, int, str], None]] = None

        # Stats
        self.packets_received = 0
        self.packets_processed = 0
        self.packets_dropped = 0
        self.bytes_received = 0
        self.queue_high_water = 0

    async def start(self):
        """Start listening for UDP packets."""
        if self._running:
            return

        # Create UDP socket
        self._socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        # Increase socket buffer size to reduce kernel drops
        self._socket.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1024 * 1024)
        self._socket.setblocking(False)
        self._socket.bind((self.bind_address, self.port))

        self._running = True
        self._queue_event = asyncio.Event()

        # Start both receive and process tasks
        self._receive_task = asyncio.create_task(self._receive_loop())
        self._process_task = asyncio.create_task(self._process_loop())

        print(f"[UDP] Listening on {self.bind_address}:{self.port} (queue size: {self.QUEUE_MAX_SIZE})")

    async def stop(self):
        """Stop listening for UDP packets."""
        self._running = False

        # Signal process loop to wake up and exit
        if self._queue_event:
            self._queue_event.set()

        for task in [self._receive_task, self._process_task]:
            if task:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

        self._receive_task = None
        self._process_task = None

        if self._socket:
            self._socket.close()
            self._socket = None

        print(f"[UDP] Stopped (received={self.packets_received}, processed={self.packets_processed}, dropped={self.packets_dropped})")

    async def _receive_loop(self):
        """Main receive loop - fast path, just enqueue packets."""
        loop = asyncio.get_event_loop()

        while self._running:
            try:
                # Use asyncio's native UDP socket handling
                data, addr = await loop.sock_recvfrom(self._socket, 256)
                self._enqueue_packet(data)

            except asyncio.CancelledError:
                break
            except Exception as e:
                if self._running:
                    print(f"[UDP] Error receiving: {e}")
                    await asyncio.sleep(0.01)

    def _enqueue_packet(self, data: bytes):
        """Parse and enqueue a received UDP packet (fast path).

        Packet format: [FLAGS:1][LEN:1][DATA:N]
        FLAGS: bit 7 = direction (0=RX, 1=TX), bits 0-6 = |RSSI| for RX
        """
        if len(data) < 2:
            return  # Too short

        # Parse header - new format with direction flag
        flags = data[0]
        length = data[1]

        if len(data) < 2 + length:
            return  # Truncated

        packet_data = data[2:2 + length]

        # Extract direction and RSSI from flags
        is_tx = (flags & 0x80) != 0
        if is_tx:
            rssi = 0
            direction = 'tx'
        else:
            rssi = -(flags & 0x7F)
            direction = 'rx'

        # Update receive stats
        self.packets_received += 1
        self.bytes_received += len(data)

        # Create packet and enqueue (thread-safe, O(1))
        packet = CCAPacket(
            data=packet_data,
            rssi=rssi,
            direction=direction,
            timestamp=time.time()
        )

        with self._queue_lock:
            # deque with maxlen automatically drops oldest if full
            old_len = len(self._packet_queue)
            self._packet_queue.append(packet)
            new_len = len(self._packet_queue)

            # Track if we dropped a packet (queue was full)
            if new_len == old_len:
                self.packets_dropped += 1

            # Track high water mark
            if new_len > self.queue_high_water:
                self.queue_high_water = new_len

        # Signal the process loop
        if self._queue_event:
            self._queue_event.set()

    async def _process_loop(self):
        """Process packets from queue - slower path with callbacks."""
        while self._running:
            try:
                # Wait for packets
                await self._queue_event.wait()
                self._queue_event.clear()

                # Process all queued packets
                while True:
                    packet = None
                    with self._queue_lock:
                        if self._packet_queue:
                            packet = self._packet_queue.popleft()

                    if packet is None:
                        break

                    # Dispatch to callback
                    if self.on_packet:
                        try:
                            self.on_packet(packet.data, packet.rssi, packet.direction)
                        except Exception as e:
                            print(f"[UDP] Callback error: {e}")

                    self.packets_processed += 1

                    # Yield periodically to not block the event loop
                    if self.packets_processed % 100 == 0:
                        await asyncio.sleep(0)

            except asyncio.CancelledError:
                break
            except Exception as e:
                if self._running:
                    print(f"[UDP] Process error: {e}")
                    await asyncio.sleep(0.01)

    def get_stats(self) -> dict:
        """Get transport statistics."""
        with self._queue_lock:
            queue_size = len(self._packet_queue)
        return {
            "packets_received": self.packets_received,
            "packets_processed": self.packets_processed,
            "packets_dropped": self.packets_dropped,
            "bytes_received": self.bytes_received,
            "queue_size": queue_size,
            "queue_high_water": self.queue_high_water,
            "running": self._running,
            "port": self.port
        }


class UDPTransportSync:
    """
    Synchronous wrapper for UDP transport.

    Runs the async transport in a background thread for use with
    synchronous code.
    """

    def __init__(self, port: int = UDPTransport.DEFAULT_PORT):
        self.port = port
        self._transport: Optional[UDPTransport] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._thread: Optional[asyncio.Thread] = None

        # Callback - will be forwarded to async transport
        self.on_packet: Optional[Callable[[bytes, int], None]] = None

    def start(self):
        """Start the transport in a background thread."""
        import threading

        def run_loop():
            self._loop = asyncio.new_event_loop()
            asyncio.set_event_loop(self._loop)

            self._transport = UDPTransport(self.port)
            self._transport.on_packet = self.on_packet

            try:
                self._loop.run_until_complete(self._transport.start())
                self._loop.run_forever()
            finally:
                self._loop.close()

        self._thread = threading.Thread(target=run_loop, daemon=True)
        self._thread.start()

    def stop(self):
        """Stop the transport."""
        if self._loop and self._transport:
            asyncio.run_coroutine_threadsafe(self._transport.stop(), self._loop)
            self._loop.call_soon_threadsafe(self._loop.stop)

        if self._thread:
            self._thread.join(timeout=2.0)


async def main():
    """Test the UDP transport."""

    def on_packet(data: bytes, rssi: int, direction: str = 'rx'):
        hex_str = ' '.join(f'{b:02X}' for b in data)
        dir_marker = 'TX' if direction == 'tx' else 'RX'
        print(f"[{time.time():.3f}] {dir_marker} RSSI={rssi:3d} LEN={len(data):2d} | {hex_str}")

    transport = UDPTransport(port=9433)
    transport.on_packet = on_packet

    await transport.start()

    print("Listening for CCA packets... Press Ctrl+C to stop")
    try:
        while True:
            await asyncio.sleep(10)
            stats = transport.get_stats()
            print(f"[STATS] rx={stats['packets_received']} proc={stats['packets_processed']} "
                  f"drop={stats['packets_dropped']} queue={stats['queue_size']}/{stats['queue_high_water']}")
    except KeyboardInterrupt:
        pass
    finally:
        await transport.stop()


if __name__ == "__main__":
    asyncio.run(main())
