"""
UDP Transport for CCA Packets

Receives CCA packets from ESP32 via UDP and dispatches to registered handlers.

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
from typing import Callable, Optional
from dataclasses import dataclass


@dataclass
class CCAPacket:
    """Received CCA packet with metadata."""
    data: bytes
    rssi: int
    timestamp: float


class UDPTransport:
    """
    Async UDP transport for receiving CCA packets from ESP32.

    The ESP32 streams decoded CCA packets over UDP for low-latency,
    reliable packet delivery without the overhead of log parsing.
    """

    DEFAULT_PORT = 9433

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
        self._task: Optional[asyncio.Task] = None

        # Callback for received packets
        self.on_packet: Optional[Callable[[bytes, int], None]] = None

        # Stats
        self.packets_received = 0
        self.bytes_received = 0

    async def start(self):
        """Start listening for UDP packets."""
        if self._running:
            return

        # Create UDP socket - use blocking mode, we'll use asyncio's sock_recvfrom
        self._socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._socket.setblocking(False)
        self._socket.bind((self.bind_address, self.port))

        self._running = True
        self._task = asyncio.create_task(self._receive_loop())

        print(f"[UDP] Listening on {self.bind_address}:{self.port}")

    async def stop(self):
        """Stop listening for UDP packets."""
        self._running = False

        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

        if self._socket:
            self._socket.close()
            self._socket = None

        print(f"[UDP] Stopped (received {self.packets_received} packets, {self.bytes_received} bytes)")

    async def _receive_loop(self):
        """Main receive loop."""
        loop = asyncio.get_event_loop()

        while self._running:
            try:
                # Use asyncio's native UDP socket handling
                data, addr = await loop.sock_recvfrom(self._socket, 256)
                self._handle_packet(data, addr)

            except asyncio.CancelledError:
                break
            except Exception as e:
                if self._running:
                    print(f"[UDP] Error receiving: {e}")
                    await asyncio.sleep(0.1)

    def _handle_packet(self, data: bytes, addr: tuple):
        """Parse and dispatch a received UDP packet.

        Packet format: [FLAGS:1][LEN:1][DATA:N]
        FLAGS: bit 7 = direction (0=RX, 1=TX), bits 0-6 = |RSSI| for RX
        """
        if len(data) < 2:
            return  # Too short

        # Parse header - new format with direction flag
        flags = data[0]
        length = data[1]

        if len(data) < 2 + length:
            print(f"[UDP] Truncated packet: expected {length} bytes, got {len(data) - 2}")
            return

        packet_data = data[2:2 + length]

        # Extract direction and RSSI from flags
        is_tx = (flags & 0x80) != 0
        if is_tx:
            rssi = 0  # No RSSI for TX
            direction = 'tx'
        else:
            # RSSI is stored as magnitude (positive), convert back to negative
            rssi = -(flags & 0x7F)
            direction = 'rx'

        # Update stats
        self.packets_received += 1
        self.bytes_received += len(data)

        # Dispatch to callback with direction
        if self.on_packet:
            try:
                self.on_packet(packet_data, rssi, direction)
            except Exception as e:
                print(f"[UDP] Callback error: {e}")

    def get_stats(self) -> dict:
        """Get transport statistics."""
        return {
            "packets_received": self.packets_received,
            "bytes_received": self.bytes_received,
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
    import time

    def on_packet(data: bytes, rssi: int):
        hex_str = ' '.join(f'{b:02X}' for b in data)
        print(f"[{time.time():.3f}] RSSI={rssi:3d} LEN={len(data):2d} | {hex_str}")

    transport = UDPTransport(port=9433)
    transport.on_packet = on_packet

    await transport.start()

    print("Listening for CCA packets... Press Ctrl+C to stop")
    try:
        while True:
            await asyncio.sleep(10)
            stats = transport.get_stats()
            print(f"[STATS] Packets: {stats['packets_received']}, Bytes: {stats['bytes_received']}")
    except KeyboardInterrupt:
        pass
    finally:
        await transport.stop()


if __name__ == "__main__":
    asyncio.run(main())
