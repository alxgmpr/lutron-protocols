# Architecture Rework: ESP32 Firmware & Transport

## Problem Statement

The current stack uses ESPHome as the ESP32 framework and WiFi/UDP as the transport
between the ESP32 and the Bun backend. Both choices made sense early on but have become
liabilities as the project grew.

**ESPHome provides ~200 lines of value** (WiFi, OTA, SPI bus, logging) while imposing
significant costs on ~7,000 lines of custom code:

- 550 lines of C++ live inside YAML string literals — no syntax highlighting, no
  autocomplete, no debugger, no git blame
- 30 Home Assistant API service definitions duplicate the UDP JSON command interface
  one-for-one — pure boilerplate
- ESPHome's Python codegen + PlatformIO build pipeline adds layers of indirection for
  zero benefit
- The component model (sensors, switches, lights) doesn't fit a bidirectional radio
  transceiver with complex pairing state machines

**WiFi/UDP adds latency and fragility:**

- WiFi stack contention causes 1-5ms jitter on packet sends (tracked by `slow_sends`
  counter); occasional sends exceed 5ms
- UDP provides no delivery guarantee — command packets can silently drop
- WiFi reconnection adds seconds of downtime after AP hiccups
- The ESP32 needs WiFi credentials, mDNS, and a routable IP — configuration overhead
  for a device that sits on a desk next to the backend machine

## Proposed Architecture

```
CC1101 ←─SPI──→ ESP32 ←─USB Serial──→ Backend (Bun) ←─SSE──→ Web UI
         4MHz         921600 baud           :5001          browser
```

Two changes:

1. **Replace ESPHome with plain PlatformIO firmware** (Arduino framework)
2. **Replace WiFi/UDP with USB serial (UART)**

Everything else stays the same: the Rust FFI library, the CC1101 radio driver, the
pairing state machines, the backend HTTP API, the SSE packet stream, the React frontend.

## What Changes

### ESP32 Firmware

#### Drop ESPHome, keep the C++

The custom component code (`cc1101_cca.cpp`, `cc1101_radio.cpp`, `lutron_pairing.cpp`)
is already plain C++ with minimal ESPHome coupling. The migration:

| ESPHome concept | Plain replacement |
|---|---|
| `esphome::Component` base class | Remove. Call `setup()` from `main()`, `loop()` from `loop()` |
| `GPIOPin` abstraction | `pinMode()` / `digitalRead()` / `attachInterrupt()` |
| `ESP_LOGI/W/E/D` macros | These come from ESP-IDF, not ESPHome — they keep working |
| `esphome::spi::SPIDevice` | Direct SPI via Arduino `SPI.h` (already close to what `cc1101_radio.cpp` does) |
| `on_packet` / `on_tx` triggers | Direct callback functions (already how the code works internally) |
| `id(cca_radio)` globals | Normal C++ globals or singleton |

The 550-line YAML lambda block becomes a normal `command_handler.cpp` that parses JSON
and calls radio functions — same logic, real C++ file.

The 30 HA API service definitions get deleted entirely. The JSON command path already
covers every command.

#### New file structure

```
firmware/
├── platformio.ini          # Build config (ESP32, Arduino framework)
├── src/
│   ├── main.cpp            # setup() + loop(), wires everything together
│   ├── cc1101_radio.cpp    # CC1101 SPI driver (nearly unchanged)
│   ├── cc1101_radio.h
│   ├── cc1101_cca.cpp      # Protocol logic, pairing, commands (nearly unchanged)
│   ├── cc1101_cca.h
│   ├── lutron_pairing.cpp  # Pairing sequences (unchanged)
│   ├── lutron_pairing.h
│   ├── command_handler.cpp # JSON command dispatch (extracted from YAML)
│   ├── command_handler.h
│   ├── serial_stream.cpp   # Serial framing + send/receive (replaces udp_stream.h)
│   ├── serial_stream.h
│   ├── packet_buffer.h     # Ring buffer (unchanged)
│   └── ffi/
│       ├── lutron_decoder.h  # Rust FFI (unchanged)
│       └── lutron_protocol.h
├── lib/
│   └── libcca.a            # Pre-compiled Rust library
└── rust_build.sh           # Script to cross-compile Rust for ESP32
```

### Serial Transport

#### Framing protocol

Keep the existing binary format, add a frame delimiter for reliable sync on the
byte-stream serial link:

```
Frame: [START:1] [FLAGS:1] [LEN:1] [DATA:N] [CRC8:1]

START  = 0x7E (frame delimiter)
FLAGS  = bit 7: direction (0=RX from radio, 1=TX to radio)
         bit 6: 1=JSON command (LEN/DATA is a JSON string)
         bits 0-5: |RSSI| for RX packets
LEN    = payload length (1-64)
DATA   = raw packet bytes or JSON command string
CRC8   = CRC-8 over FLAGS+LEN+DATA (catches serial corruption)
```

Byte stuffing for `0x7E` in payload: escape with `0x7D` + XOR `0x20` (HDLC standard).
This is simple, battle-tested, and adds < 1% overhead for typical CCA packets.

**Heartbeat**: Send `[0x7E, 0xFF, 0x00, CRC8]` every 5 seconds (same semantic as today).

**JSON commands** (backend → ESP32) use the same frame with FLAGS bit 6 set:
```
0x7E  0x40  0x1F  {"cmd":"button","device":"0x1185E68D","button":"0x02"}  CRC8
```

This unifies binary packets and JSON commands on one serial link without needing two
UDP ports.

#### ESP32 serial_stream

```cpp
// Pseudocode — same architecture as udp_stream.h
class SerialStream {
  void begin(unsigned long baud = 921600);

  // Called from radio RX callback — pushes to ring buffer
  void send_packet(const uint8_t* data, size_t len, int8_t rssi);
  void send_tx_echo(const uint8_t* data, size_t len);

  // Called from loop() — reads serial, dispatches commands
  void poll();

  // Callbacks
  void set_tx_callback(TxCallback cb);
  void set_json_command_callback(JsonCommandCallback cb);

private:
  PacketRingBuffer<256> tx_buffer_;  // Radio→Serial (async)
  uint8_t rx_buf_[512];             // Serial→Radio (accumulated)
  size_t rx_pos_ = 0;
};
```

The FreeRTOS send task stays — serial writes can still block briefly, so decoupling
the radio callback from the serial write remains important.

#### Backend serial port

Replace the two UDP sockets with one serial port:

```typescript
// backend/src/serial.ts
import { SerialPort } from "serialport";  // or Bun's native File for /dev/ttyUSBx

class ESP32Serial {
  private port: SerialPort;
  private rxBuffer = Buffer.alloc(0);

  constructor(path: string, baud = 921600) {
    this.port = new SerialPort({ path, baudRate: baud });
    this.port.on("data", (chunk) => this.onData(chunk));
  }

  // Parse frames from byte stream
  private onData(chunk: Buffer) {
    this.rxBuffer = Buffer.concat([this.rxBuffer, chunk]);
    while (this.extractFrame()) {}
  }

  // Send JSON command to ESP32
  send(cmd: string, params: Record<string, unknown>) {
    const json = JSON.stringify({ cmd, ...params });
    const frame = this.buildFrame(0x40, Buffer.from(json));
    this.port.write(frame);
  }
}
```

The rest of the backend (`handlePacket()`, SSE broadcast, HTTP API, recording) is
**completely unchanged** — it receives parsed packet objects from the transport layer
regardless of whether they arrived via UDP or serial.

### What Stays Exactly The Same

- **Rust FFI library** (`cca/`) — cross-compiled to ESP32, called via C API
- **CC1101 radio driver** (`cc1101_radio.cpp`) — SPI register access, RX/TX state machine
- **Protocol logic** (`cc1101_cca.cpp`) — all 4,000 lines of pairing, config, commands
- **Ring buffer** (`packet_buffer.h`) — lock-free producer/consumer
- **Backend HTTP API** — all `/api/*` endpoints
- **SSE packet stream** — real-time browser updates
- **React frontend** — no changes
- **Protocol definitions** (`cca.yaml`, codegen) — no changes
- **Packet recording** (CSV sessions) — no changes
- **Tools** (`packet-analyzer.ts`, `rtlsdr-cca-decode.ts`) — no changes

## Migration Path

### Phase 1: Extract from ESPHome (firmware only, keep UDP)

Move the custom component into a standalone PlatformIO project. Keep WiFi and UDP
so the backend doesn't need to change yet.

1. Create `firmware/platformio.ini` targeting ESP32 + Arduino
2. Copy `cc1101_*.cpp/h`, `lutron_pairing.cpp/h`, `packet_buffer.h` into `firmware/src/`
3. Extract the YAML lambda into `command_handler.cpp`
4. Copy `udp_stream.h` as-is
5. Write `main.cpp`: init WiFi, init SPI, init radio, init UDP stream, run loop
6. Build and flash via PlatformIO
7. Verify: backend still works identically (same UDP protocol)

**Risk**: Low. The C++ is already standalone; ESPHome just wraps it.
**Validation**: All existing backend API endpoints work, packets stream, commands execute.

### Phase 2: Add serial transport (backend + firmware)

Add serial as an alternative transport alongside UDP.

1. Write `serial_stream.cpp/h` with HDLC framing
2. Add `backend/src/serial.ts` with frame parser
3. Backend auto-detects transport: if `--serial /dev/ttyUSBx` flag is passed, use
   serial; otherwise fall back to UDP
4. Wire serial into `main.cpp` as an alternative to UDP stream
5. Compile two firmware variants: `firmware-wifi.bin` and `firmware-serial.bin`
   (or a runtime flag)

**Risk**: Low. Serial and UDP coexist; nothing breaks if serial has bugs.
**Validation**: Same test suite — all commands and packet streaming work over serial.

### Phase 3: Remove UDP/WiFi (optional, cleanup)

Once serial is proven stable:

1. Remove `udp_stream.h` and WiFi init from firmware
2. Remove UDP socket code from backend
3. Remove WiFi credentials from secrets
4. Firmware binary shrinks, boot time drops to <1s (no WiFi association)

**Risk**: Irreversible in the sense that WiFi capability is gone. Keep the UDP code
in git history. Could also keep both transports permanently — the abstraction is clean.

## Comparison

| | Current (ESPHome + UDP) | Proposed (PlatformIO + Serial) |
|---|---|---|
| **Firmware framework** | ESPHome (95% unused) | PlatformIO/Arduino (use what you need) |
| **Transport** | WiFi → UDP (2 ports) | USB serial (1 link) |
| **Latency** | 1-5ms (WiFi jitter) | <1ms deterministic |
| **Reliability** | UDP drops possible | Byte-level reliable + CRC8 |
| **Boot time** | ~3-5s (WiFi association) | <1s |
| **C++ DX** | Embedded in YAML strings | Normal `.cpp` files with full IDE support |
| **Build** | ESPHome Python → PlatformIO | PlatformIO directly |
| **Lines of code** | ~7,500 custom + ~200 ESPHome | ~6,500 (delete 30 HA services + YAML glue) |
| **Dependencies** | ESPHome, Arduino, ArduinoJson, WiFi | Arduino, ArduinoJson |
| **Wireless** | Yes | No (USB cable required) |
| **OTA** | ESPHome OTA | USB flash (or add ESP-IDF OTA later) |
| **Multi-host** | Backend can be anywhere on LAN | Backend must be USB-connected |

## Open Questions

1. **Baud rate**: 921600 is standard and gives ~90 KB/s throughput. CCA packets are
   ≤53 bytes at ~10/sec = 530 bytes/sec — massive headroom. Could go lower (115200)
   for compatibility, but 921600 works fine on ESP32 + USB-UART bridges.

2. **Serial library for Bun**: Bun doesn't have a native serial port API. Options:
   - `serialport` npm package (Node native addon — may need compatibility check with Bun)
   - Raw file I/O on `/dev/ttyUSBx` with `stty` for baud config (works on macOS/Linux)
   - Spawn a small helper process that bridges serial ↔ stdin/stdout

3. **Dual transport**: Worth keeping both WiFi and serial as selectable transports in
   the firmware? Adds ~50 lines but gives flexibility for future wireless use cases.

4. **USB power**: The ESP32 dev board draws ~250mA with radio active. USB 2.0 provides
   500mA — fine. USB 3.0 provides 900mA. No power concerns.
