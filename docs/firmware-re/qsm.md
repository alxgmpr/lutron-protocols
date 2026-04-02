# QSM Firmware Reverse Engineering Findings

Reverse-engineered from `QSM_8.015_434MHz.s19` extracted from Lutron Designer 26.0.2.100 MSIX.
MCU: Freescale HCS08 (MC9S08 family), banked flash with CALL/RTC instructions.
Radio: TI CC1101 433 MHz FSK transceiver, SPI-connected.

## Architecture

- 5 banked flash pages (0x0A, 0x12, 0x16, 0x1A, 0x1E) at 0x8000-0xBFFF + unpaged code
- Page 0x0A: CCA radio protocol, packet construction, pairing engine (326 functions)
- Page 0x12: 316 functions (TBD)
- Page 0x16: 503 functions (TBD - largest page)
- Page 0x1A: 376 functions (TBD)
- Page 0x1E: 65 functions (TBD - smallest)
- Unpaged: C startup, interrupt vectors, API trampoline table (269 functions)

## Frequency Hopping

CCA uses 10-channel frequency hopping:
- **10 channels**
- **Channel spacing: 21** (CC1101 CHANNR units)
- **Starting channel: 60** (0x3C)
- Channels: 60, 81, 102, 123, 144, 165, 186, 207, 228, 249
- Channel scan results sent as packet format 0x2D
- `func_0x2db5` samples RSSI per channel
- Zone status bitmap: 32 bytes (256 zones max)

## Base Image API (Trampoline Table)

| Address | Purpose |
|---------|---------|
| 0x0083 | memcpy/memset |
| 0x0094 | GPIO configure |
| 0x0095 | Allocate pairing slot (returns 0=success, 0xFE=full) |
| 0x0098 | Store device address |
| 0x0099 | Get protocol mode (returns 0,3,4,7,8,9,10) |
| 0x009A | Get zone/link type (returns 8, 0x10, 0x0E) |
| 0x009B | Get sequence number |
| 0x009F | Read device ID bytes (returns 2 bytes) |
| 0x0283 | **TX packet** (arg1=format, arg2=buffer) — universal transmitter |
| 0x0284 | Packet send (interrupt path) |
| 0x0286 | Send packet variant |
| 0x0288 | Send addressed packet (uses uRAM0782/0784 as source) |
| 0x028A | Send addressed packet with payload |
| 0x029C | Send packet (alternate network mode) |
| 0x02AA | Protocol state query |
| 0x02B7 | Database read |
| 0x02B8 | Database write |
| 0x02BE | Validate pairing state |
| 0x0487 | Get paired device address by index |
| 0x0489 | Register device in pairing table |
| 0x048A | Update device record |
| 0x048B | Unpair/remove device |
| 0x048C | Commit pairing |
| 0x0490 | Check pairing eligibility |
| 0x0492 | Verify pairing credentials |
| 0x04A8 | **SPI read byte** (CC1101) |
| 0x04A9 | **SPI write byte** (CC1101) |
| 0x04AA | SPI transaction end / CS deassert |
| 0x04BA | Handle QS Link command (type 0x32) |
| 0x0581 | Set device association flag |
| 0x0585 | **Get local device serial/ID** (4 bytes) |
| 0x0587 | Set/acknowledge pairing state |
| 0x058A | Lookup device by address |
| 0x058E | Get paired device record |
| 0x058F | Search device in pairing table |
| 0x0590 | Get device info |
| 0x0596 | Check if device already known |
| 0x0597 | Validate source address |
| 0x0598 | Validate destination |
| 0x059E | Transition pairing state |
| 0x05A0 | Start/prepare TX |
| 0x0680 | Initialize packet buffer |
| 0x0684 | Validate/finalize packet |
| 0x06A6 | Schedule deferred action (takes ms timeout) |
| 0x06AB | Get network/link state (returns 1 or 3) |
| 0x06AC | Copy/prepare data block |
| 0x06AD | Iterate linked devices (returns -1 when done) |
| 0x06AE | Get/set mode register |
| 0x06BD | Get paired device count |
| 0x0789 | Get device record pointer by index |
| 0x2DB5 | Sample channel RSSI |
| 0x2DC1 | CRC/length validation |
| 0x2EDA | Compute device address offset |
| 0x2F09 | Get device record |
| 0x2F5C | Get device status |
| 0x2F7D | Get device mode |

## Packet Format Codes (via func_0x0283)

All TX calls are in page 0x0A. First argument to func_0x0283 is the format code.

| Format | Count | Purpose | Status |
|--------|-------|---------|--------|
| 0x01 | 1 | Unknown | NEW |
| 0x04 | 1 | Short control packet (3 bytes) | NEW |
| 0x05 | 2 | Button/device press (device_hi, device_lo, button_code) | NEW |
| 0x07 | 1 | Zone status (type 0x06 + 2 data + 0x16 + param) | NEW |
| 0x08 | 1 | Simple control/heartbeat | NEW |
| 0x09 | 4 | UNPAIR_PREP / Config | known |
| 0x0A | 2 | Short control with 0xFE+0x01+0x61 | NEW |
| 0x0B | 2 | SENSOR_LEVEL / Extended query | known |
| 0x0C | 2 | UNPAIR / Level-zone | known |
| 0x0D | 5 | Short SET_LEVEL (type 0x10 devices, 3 data bytes) | NEW |
| 0x0E | 1 | SET_LEVEL standard (type 0x38 devices) | known |
| 0x0F | 6 | Extended SET_LEVEL (type 0x37 devices, 5 data bytes) | NEW |
| 0x10 | 2 | Group/scene config (sub-type 8) | NEW |
| 0x11 | 8 | LED_CONFIG / Generic device control | known, most frequent |
| 0x12 | 1 | Device config (short, param_9=2) | known |
| 0x14 | 4 | FUNC_MAP / Device config (long) | known |
| 0x2C | 1 | Unknown high format | NEW |
| 0x2D | 1 | Channel scan / zone bitmap (32 bytes) | NEW |

## Device Type → Format Selection

FUN_82e8 selects packet format based on device type:
- Device type 0x10 → format 0x0D, 3-byte address
- Device type 0x38 → format 0x0E, standard SET_LEVEL (4-byte + level16)
- Device type 0x37 → format 0x0F, extended (5-byte + level16)

## RX Packet Handler Dispatch (FUN_a12f)

Dispatches on byte[6] of received packet:
- 0x06: Zone control command
- 0x08: Group/scene command
- 0x12: Device config (long)
- 0x13: Device config (short)
- 0x18: Extended command
- 0x1B: Query/status request
- 0x26: Association response (key pairing packet)
- 0x33: Type with sub-dispatch on byte[9] range
- 0x36: Special long association

## Command Dispatch (byte[9] of RX packets)

- 0x01: Device control — if byte[8] < 5, set level via func_0x048A
- 0x42 ('B'): Blind/shade — if byte[7:8] == 0x32, shade control
- 0x21 ('!'): Pairing — if byte[7:8] == 0x35 and byte[11] == 0x01

## Button Codes

- 0x2B = button press
- 0x06 = button release

## Retransmission Timing

| Context | Interval (ms) | Retries |
|---------|--------------|---------|
| Pair request | 25,000 | 10 |
| Scene recall | 30,000 | 10 |
| Zone report | 60,000 | 10 |
| Default command | 10,240 (0x27C0) | 5 |
| TX retry | starts at 3 | decrements per failure |

## QS Link Device Types

Pairing engine handles: 0x40, 0x41, 0x42, 0x9A, 0x9B, 0x9C, 0x100, 0x107

Link type address table:
- 0x40, 0x41, 0x42: Both zero (broadcast)
- 0x9B: uRAM0773, uRAM0771
- 0x9C: uRAM0775, uRAM0773
- 0x9A, 0x100, 0x107: uRAM0777, uRAM0775

## Pairing Protocol Details

- Byte[5]==0x05 && byte[6]==0x0A triggers pairing
- Byte[7]==0x01: pair request (stores sRAM0758, sets uRAM0755=1)
- Byte[7]==0x00: unpair request (clears uRAM0755)
- Device ID at bytes[8:9], validated against range 0x29-0x2C
- Pairing slot allocation: func_0x0095 returns 0=success, 0xFE=full
- Database stores 4-byte serial numbers per device

## SPI / CC1101 Communication

TX FIFO write pattern (FUN_83d3):
1. `func_0x04a9(command)` — write address/strobe
2. `func_0x2dc1(length+3)` — validate CRC/length
3. Write length byte + header bytes via SPI
4. Loop: write payload bytes
5. `func_0x04a9(strobe)` — TX strobe

Burst TX FIFO write uses CC1101 register 0x3F.
Packet = length_byte + payload + 2_CRC_bytes (length+3 total).

## RAM State Map

| Range | Purpose |
|-------|---------|
| 0x0080-0x00FF | Hardware state flags |
| 0x0100-0x0127 | Protocol state (0x126=retransmit, 0x127=retry) |
| 0x066A-0x066E | Format-specific device ID |
| 0x0700-0x0790 | Active protocol state, device IDs, link addresses |
| 0x075E-0x0760 | Local source device ID |
| 0x0762-0x0765 | Received device ID (4 bytes) |
| 0x0782-0x0784 | TX source/peer addresses |
| 0x0786 | Packet counter (starts at 0x3A3) |
| 0x2400-0x2500 | Lookup tables, dispatch tables, device name strings |

## Lookup Tables

### Device name strings at 0x2484 (Unicode-16)
- QSM, Occ (occupancy), Photo (photosensor), IR, Pico

### Format index table at 0x2490
Maps sequential indices to CCA format codes:
01 02 03 04 05 06 07 08 09 11 12 13 14 15 16 10
(skips 0x0A-0x10, then 0x10 at end)

### Device type table at 0x24F0
04 05 03 06 07 08 09 0A 0B 0C 0D 0E 0F 10 11 12

### Dispatch table at 0x2418
3-byte entries (page:addr16) for CALL targets — packet type handlers.

## Ghidra Project

Location: `/Volumes/Secondary/lutron-tools/re/designer/ghidra_project3/qsm_final`
Patched HCS08 processor with CALL (0xAC) and RTC (0x8D) support in:
`/Users/alex/Downloads/ghidra_12.0.4_PUBLIC/Ghidra/Processors/HCS08/data/languages/HCS_HC.sinc`

## N81 Codec (page_0A: FUN_8e4d-FUN_909c)

### Encoder (FUN_8e4f)
Located at 0x8E4F in page 0x0A. Uses bit-shift chains across byte boundaries to pack
8-bit data into 10-bit N81 frames (start bit + 8 data bits + stop bit):
- `<< 1` with `>> 7` extracts carry bits across byte boundaries
- Device addresses (3 bytes) are packed into bit-stream format
- `param_2 & 7 | bVar7 << 3` — masks lower 3 bits and shifts for alignment

### Decoder (FUN_9068/909c)
Located at 0x9068/0x909C. Extracts individual bits from received bitstream:
- Creates single-bit mask by shifting 1 left by position count
- `* 8` converts byte index to bit offset
- Decoded values indexed into tables at 0x240D (values < 5) or device table (values 5-14)

### CRC Integration into Packet Framing
- `func_0x2e4d`: CRC-16 per-byte accumulator update (called per byte in loop)
- `func_0x04aa`: CRC finalize
- `func_0x2dc1`: Set packet length including 2-byte CRC
- `func_0x04a9(3, buffer)`: Write 3-byte header to CC1101 TX FIFO
- Packet format: length_byte + payload + 2_CRC_bytes (total = length + 3)

## Protocol Constants Confirmed

### Packet Type Markers
- 0x77, 0x88: Pairing/discovery packet markers
- 0xFE, 0x42: Level control (0xFE = assigned device, 0x42 = 'B' button/level)
- 0x45 ('E'): Execute/zone activation command

### Scene/Zone Control
- Message type 6 with sub-type 0x16 = scene/zone control command
- Format 0x07 packet: [0x06, source_hi, source_lo, 0x16, value]

### Device Registration
- 4 variants for different device classes (dimmer, switch, shade, keypad)
- Offsets +0x0F/+0x10 (two-stage) vs +0x11/+0x12 (single-stage)
- 3 retries, error 0xFE = pairing table full

### Dynamic Format Computation
- Some format codes are computed: format = base + data_length
- Base 0x0C: short format (12 + N)
- Base 0x0D: standard format (13 + N)

### RX Device Type Correction (FUN_9efc)
When receiving packets, device type byte is corrected:
- If < 0x40 and > 0x10: forced to 0x18
- If >= 0x40: subtract 0x2F
- Corrected type indexes dispatch table at 0x2417 (24 entries × 3 bytes)

## CRC-16 Verified

Polynomial 0xCA0F confirmed. Full 256-entry lookup table at linear address 0x5D5E25
(SB page 0x175, offset 0x1E25). All 256 entries match our implementation exactly.

## Page 0x16 Analysis (503 functions — largest page)

Page_16 is the main CCA protocol engine. Contains packet builders, format handlers,
and the primary command dispatcher.

### New Packet Types
- 0x90 (short), 0x97 (short), 0x99 (short — ACK/heartbeat, 3 locations)
- 0xA5 (long), 0xA8 (long), 0xBA (long), 0xBE (long)

### Format Codes in Page_16
0x04, 0x06, 0x08, 0x0B, 0x0C, 0x0D, 0x0E, 0x12, 0x13, 0x15, 0x1E

### Payload Encoding
Generic addressed packets use 3-byte-per-item encoding:
- Header: 8 bytes (type + addressing)
- Each payload item: 3 bytes
- Total length: (item_count × 3) + 8
- Broadcast: address bytes = 0xFF, unicast marker = 0xFE

### Main Command Dispatcher (FUN_ae6f, byte[6])
- '0' (0x30): Init/reset (120-tick timeout)
- 'P' (0x50): Pair (device type validation, association table)
- 'H' (0x48): Heartbeat/hello (status response)

### Pairing Model
Press/release pattern:
- Press (byte[7]=1): Start pairing, store device ID in sRAM0758, set uRAM0755=1
- Release (byte[7]=0): Complete pairing, 104-tick delay, clear uRAM0755
- Valid pairing device IDs: 0x29-0x2C (41-44)

### Device Type → Address Table
- 0x40-0x42 (Maestro): local only, no remote address
- 0x9A (Pico): RAM 0x0775/0x0777
- 0x9B (Sensor): RAM 0x0771/0x0773
- 0x9C (Daylight): RAM 0x0773/0x0775
- 0x100, 0x107 (Extended): RAM 0x0775/0x0777

### Device Type Remapping
Types 0x9A-0x9C → (type - 0x9A) + 0x66 = 0x66-0x68

### Special Device Type 0x36
Processor/repeater — triggers CRC validation, 12-byte copy, special handling

### Hex-ASCII Converter (FUN_93A7)
Called 11 times. Converts 8-byte device IDs to hex strings using table at 0x248F.
Used for serial debug output or QS Link addressing.

### Per-Zone Level Table
RAM 0x0766+ stores per-zone level data, indexed by zone number.
Used in device status reporting.

### Kernel API Call Frequency (page_16)
- func_0x0083: 42 calls (memcpy/buffer write)
- func_0x0081: 40 calls (buffer init)
- func_0x05A7: 38 calls (timer/delay)
- func_0x05B6: 34 calls (timer-related)
- func_0x009D: 33 calls (packet send/queue)
- func_0x0099: 23 calls (state machine query)
- func_0x059E: 22 calls (timer set, arg=5)

## TDMA Slot Timing

CCA uses time-division multiple access with variable frame sizes.
Sequence byte low bits determine which time slot a device transmits in.

### Slot Frame Sizes
| Mask | Slots | Usage |
|------|-------|-------|
| AND #3 | 4 | Fast response (radio driver) |
| AND #7 | 8 | Standard CCA operation (most common) |
| AND #15 | 16 | Larger networks, pairing |
| AND #31 | 32 | Dense networks |
| AND #63 | 64 | Maximum frame (base timer config) |

### Slot Calculation
slot_number = sequence_byte AND slot_mask
tx_delay = slot_number × slot_duration

Devices self-organize: each chooses a sequence byte whose low bits
give it a unique slot. Reply devices use slot +1 from the originator.

### Timer Configuration
- TPM1: Slot frame timer (period masked to 6 bits = 64 max)
- TPM2: Secondary timing
- TPM3: CC1101 RF bit timing ($1860-$1877)
- Slot duration multipliers: 0x40 (64), 0x42 (66), 0x44 (68) timer ticks
- RAM 0x0143-0x0144: Current slot position

### TDMA Frame Timing Constants
- 10,240 ms (0x27C0): Default command frame
- 25,000 ms: Pair request timeout
- 30,000 ms: Scene recall timeout
- 60,000 ms: Zone report timeout

## Base Image Architecture

### Dynamic Dispatch (NOT Static Trampolines)
CALL targets (0x0283, 0x04A8, etc.) are erased flash slots filled
dynamically when banked pages load. 101 unique CALL targets in 7 groups.

### SPI / CC1101 Driver (0x8001-0x80DD)
Lives in unpaged high flash (always visible):
- SPI: SPIS=$2B, SPID=$2D, SPIC1=$28, SPIC2=$29, SPIBR=$2A
- CC1101 chip select: bit 3 of port $08
- Poll: wait for SPIF (bit 7 of $2B)
- Functions: multi-byte transfer, register write, status read, init

### N81 Codec (0x8BCA)
Uses (LSRA; RORX) × 4 for nibble extraction — 4-bit-to-5-bit encoding.
Lookup tables are in paged flash.

### Key RAM Variables
| Address | Refs | Purpose |
|---------|------|---------|
| $0676 | 28 | Master radio state/packet control |
| $0675 | 9 | Secondary radio state |
| $04BE/$04BF | 9/4 | SPI state variables |
| $0143/$0144 | - | Current slot position |

### Command Dispatch Table (0xD020)
32 entries, 16-bit BE pointers. 13 active, 19 → RTS (0x2853).

## CC1101 Register Configuration (SB page_175 radio driver)

### Confirmed Base Register Values
| Register | Addr | Value | Notes |
|----------|------|-------|-------|
| IOCFG2 | 0x00 | 0x00 | GDO2 = CLK_XOSC/192 |
| IOCFG1 | 0x01 | 0x0D | GDO1 = Serial Clock (sync serial) |
| IOCFG0 | 0x02 | 0x00 | GDO0 = CLK_XOSC/192 |
| FIFOTHR | 0x03 | 0x71 | ADC retention, FIFO threshold=1 |
| SYNC1 | 0x04 | dynamic | Set per channel at runtime |
| SYNC0 | 0x05 | 0x60 base | Overridden per channel |
| PKTLEN | 0x06 | 0x08 | Fixed length = 8 bytes |
| PKTCTRL1 | 0x07 | 0xFD | PQT=7, CRC_AUTOFLUSH, APPEND_STATUS |
| PKTCTRL0 | 0x08 | 0x00 | No whitening, fixed len, no HW CRC |
| ADDR | 0x09 | 0x0F | Address filter value |
| FSCTRL1 | 0x0B | 0x0F | IF freq = 380 kHz |
| MDMCFG4 | 0x10 | 0x09 | Data rate E=9 → 1269.5 bps |
| MDMCFG0 | 0x14 | 0x14 | Channel spacing mantissa |
| MCSM2 | 0x16 | 0x74 | RX term on RSSI below threshold |
| MCSM1 | 0x17 | 0x40/0x80 | CCA mode, state transitions |
| MCSM0 | 0x18 | 0xF0 | FS_AUTOCAL=3, PO_TIMEOUT=3 |
| AGCCTRL0 | 0x1D | 0xFF | Max hysteresis/wait/freeze/filter |
| WOREVT0 | 0x1F | 0xFF | WOR event timeout |
| FREQ2 | 0x0D | 0x10 | 433 MHz band |
| FREQ1/0 | 0x0E/0x0F | from EEPROM | Per-device, loaded at runtime |
| TEST2 | 0x2C | 0xAC | Improved sensitivity mode |

### Key Findings
- PKTCTRL0=0x00: NO data whitening, NO HW CRC — confirmed for normal CCA
- Data rate: ~1270 bps (MDMCFG4 E=9)
- With N81 (10 bits/byte): effective ~127 bytes/sec
- Sync word is DYNAMIC — set per channel at runtime
- FREQ1/FREQ0 loaded from EEPROM (not compiled in)

### XOR 0xA7 Obfuscation
Three locations XOR packet data with 0xA7. May be part of N81 encoding or simple scrambling.

### Bit Timing
MTIMMOD = 0x30 (48 ticks) — sets RF bit timing period
TPM3 channels ($1860-$1877) handle CC1101 RF timing

### Packet Frame Buffer (RAM 0x0817-0x084A)
- 0x0817: Length byte (0, 4, 6, 7, 8, 9, 10, 11, 12)
- 0x0820+: Packet data bytes
- Length 4 = short packet, 8-12 = long packet

### SPI Interface
- SPID (data): 0x181C (read), 0x1800 (write)
- SPIS (status): 0x181E (poll bit 0)
- CS toggle: write 0xD1 to 0x1802, 0x80 to 0x1803
