# CCA Protocol Reference

Clear Connect Type A (CCA) is Lutron's proprietary 433 MHz radio protocol used by Picos, dimmers, switches, sensors, and hubs. Organized by topic. See [hardware/overview.md](../hardware/overview.md) for the system-level context.

## 1. RF Parameters

| Parameter | Value |
|-----------|-------|
| Frequency | 433.602844 MHz (channel 26, default) |
| Modulation | 2-FSK |
| Data Rate | 62.5 kBaud |
| Deviation | 41.2 kHz |
| Encoding | Async serial N81 (start=0, 8 data LSB first, stop=1) |

### Channel Table

**Formula:** `Frequency (MHz) = 431.0 + (channel × 0.1)`

15 channels available: 5, 14, 17, 20, 23, **26** (default), 29, 32, 38, 41, 44, 47, 50, 53, 56.

Multi-processor systems use different channels per processor. Two-way devices (dimmers, switches) auto-switch channels. One-way transmitters (Picos, sensors) must be manually re-channeled.

### CC1101 Register Configuration

```
FREQ2/1/0: 0x10 0xAD 0x52  (433.602844 MHz)
MDMCFG4/3: 0x0B 0x3B       (62.4847 kBaud)
MDMCFG2:   0x30            (2-FSK, no sync word)
DEVIATN:   0x45            (41.2 kHz deviation)
PKTCTRL0:  0x00            (Fixed length, no hardware CRC)
```

## 2. Packet Framing

### On-Air Structure

```
[Preamble 32 bits][Sync 0xFF][Prefix 0xFA 0xDE][N81-encoded payload][Trailing zeros]
```

Each byte becomes 10 bits: 1 start bit (0) + 8 data bits (LSB first) + 1 stop bit (1).

### CRC-16

Polynomial: **0xCA0F** (non-standard). Computed over all payload bytes excluding the CRC itself, stored big-endian.

```cpp
uint16_t calc_crc(const uint8_t *data, size_t len) {
    static uint16_t crc_table[256];
    static bool table_init = false;
    if (!table_init) {
        for (int i = 0; i < 256; i++) {
            uint16_t crc = i << 8;
            for (int j = 0; j < 8; j++)
                crc = (crc & 0x8000) ? ((crc << 1) ^ 0xCA0F) & 0xFFFF : (crc << 1) & 0xFFFF;
            crc_table[i] = crc;
        }
        table_init = true;
    }
    uint16_t crc_reg = 0;
    for (size_t i = 0; i < len; i++) {
        uint8_t upper = crc_reg >> 8;
        crc_reg = (((crc_reg << 8) & 0xFF00) + data[i]) ^ crc_table[upper];
    }
    return crc_reg;
}
```

## 3. Packet Types

| Type | Name | Size | Description |
|------|------|------|-------------|
| 0x81-0x83 | LEVEL | 24 | Level command or dimmer state report |
| 0x88-0x8B | BTN / SENSOR | 24 | Button press/release (fmt 0x04/0x0E) or sensor level (fmt 0x0B) / test (fmt 0x09) |
| 0x91-0x93 | BEACON | 24 | Bridge pairing mode beacon |
| 0xA1-0xA3 | CONFIG | 53 | Configuration commands (53 bytes with 0x00 padding + CRC) |
| 0xB0/0xB2 | DEVICE_ANNOUNCE | 53 | Device announcement during bridge pairing |
| 0xB8 | PAIR_REQ | 53 | Device pairing request (Vive) / bridge-only pairing (pico) |
| 0xB9 | PAIR_BEACON | 53 | Direct-pair capable / Vive beacon |
| 0xBA | PAIR_ACCEPT | 53 | Bridge-only pairing (pico) / Vive accept |
| 0xBB | PAIR_DIRECT | 53 | Direct-pair capable |
| 0xC1-0xE0 | HANDSHAKE | 24 | Bridge pairing handshake (dimmer=C1+6n, bridge=C2+6n, sensor echo=C5) |

### Size Rules

- **0x80-0x9F**: 24 bytes (22 data + 2 CRC)
- **0xA0-0xBF**: 53 bytes (51 data + 2 CRC) — must use 0x00 padding
- **0xC0-0xEF**: 24 bytes (handshake)

### Button A/B Alternation

Base 0x88 with two flag bits: bit 0 = action (0=press, 1=release), bit 1 = group (0=A, 1=B). Picos alternate A→B on successive events for double-tap detection.

## 4. Addressing

### Device ID Structure (4 bytes)

```
[Zone][SubnetLo][SubnetHi][Endpoint]
```

- **Zone** (byte 0): device number within subnet
- **Subnet** (bytes 1-2): RF subnet, little-endian in packet
- **Endpoint** (byte 3): 0x80=unicast, 0x8F=broadcast, 0x8C/0x8D=device-specific

### ID Relationships

| ID Type | Example | Description |
|---------|---------|-------------|
| Factory/Label ID | 06FDEFF4 | Printed on device, factory-assigned |
| Load ID | AF902C00 | Assigned by bridge during pairing |
| RF Transmit ID | 8F902C08 | `Load_ID XOR 0x20000008` |

### Vive Addressing

Vive uses **hub ID** (4 bytes) + **zone ID** (1 byte) instead of device IDs. Zone byte position varies by format (byte 12 for commands, byte 24 for format 0x12 config). Constant `0xEF` always follows the zone byte.

## 5. Commands

### Button Codes

**5-Button Pico (PJ2-3BRL):** ON=0x02, FAVORITE=0x03, OFF=0x04, RAISE=0x05, LOWER=0x06

**4-Button Pico (PJ2-4B):** Top=0x08, Up=0x09, Down=0x0A, Bottom=0x0B

**Special:** 0xFF = Reset/Unpair broadcast

### Button Press Packet (24 bytes)

**Short format** (byte 7 = 0x04): Bytes 0-11 are header + button code + action.

**Long format** (byte 7 = 0x0E): Includes repeated device ID at bytes 12-15 and command payload at bytes 17-21.

Long format bytes 17-21 by button:

| Button | Bytes 17-21 | Command Class |
|--------|-------------|---------------|
| ON | 40 00 20 00 00 | 0x40 (level) |
| FAVORITE | 40 00 21 00 00 | 0x40 (level) |
| OFF | 40 00 22 00 00 | 0x40 (level) |
| RAISE | 42 02 01 00 16 | 0x42 (dim) |
| LOWER | 42 02 00 00 43 | 0x42 (dim) |

### Command Class 0x40: Level Control

Used by bridge SET_LEVEL, Vive ON/OFF/level, and pico set-level.

**Bridge SET_LEVEL (format 0x0E, byte 8 = 0x00):**

```
Byte 9-12: Target device ID
Byte 14:   0x40 (command class)
Byte 15:   0x02 (SET_LEVEL subcommand)
Byte 16-17: Level (BE, 0x0000-0xFEFF)
Byte 18:   0x00
Byte 19:   Fade time (quarter-seconds: 0x01=250ms, 0x04=1s, 0x28=10s)
Byte 20-21: 0x00 0x00
```

**Vive SET_LEVEL (format 0x0E, byte 8 = 0x00):**

```
Byte 12:   Zone ID
Byte 13:   0xEF
Byte 14:   0x40 (command class)
Byte 15:   0x02 (SET_LEVEL)
Byte 16-17: Level (BE, 0x0000-0xFEFF)
Byte 19:   Fade time (quarter-seconds)
```

**Pico SET_LEVEL (format 0x0E, byte 8 = 0x03):**

```
Byte 8:    0x03 (MUST be 0x03 — pico framing)
Byte 12-15: Pico device ID (repeated, REQUIRED)
Byte 17:   0x40 (command class)
Byte 18:   0x02 (SET_LEVEL)
Byte 19-20: Level (BE, 0x0000-0xFEFF)
Byte 21:   Must be non-zero (0x00 causes rejection)
```

Pico set-level works but fade is always slow (~1-2 min) because the 5-byte pico payload has no room for a fade field. The dimmer applies its default ramp rate. See [lutron-rf-overview.md](lutron-rf-overview.md) for the OUTPUT vs DEVICE explanation.

**Fade encoding:** `byte19 = seconds × 4` (quarter-seconds). Shared between Vive and bridge.

**Level encoding:** `level16 = percent * 0xFEFF / 100`

### Command Class 0x42: Dimming

Two-phase dimming shared between Pico and Vive:

| Phase | Purpose | Pico Format | Vive Format |
|-------|---------|-------------|-------------|
| Hold-start | Initiate dim | 0x0C | 0x09 |
| Dim step | Actual dimming | 0x0E | 0x0B |

Both use `0x42, 0x00` for hold-start and `0x42, 0x02` for dim step. Direction encoding differs: Pico 0x01/0x00 (raise/lower), Vive 0x03/0x02.

Hold-start is **required** — without it, dim steps are silently ignored.

Transmission: 6 hold-start packets, then 10-12 dim step packets.

### Button Action Patterns

| Action | Method |
|--------|--------|
| Press | 6 short + 10 long format packets, ~70ms gaps |
| Hold-to-dim | 14 HOLD packets → wait → 14 RELEASE packets |
| Save favorite | 12 packets with format 0x0D, action byte 0x03 |
| Double-tap | Two press/release cycles with A→B type alternation |

### Dimmer State Report (24 bytes)

```
Byte 7:  0x08 (state report format)
Byte 11: Level (0x00-0xFE = 0-100%)
```

Dimmers send to both unicast (0x80) and broadcast (0x8F) endpoints.

## 6. Vive Variant

Vive uses the same CCA radio but addresses devices by hub ID + zone ID for room-level group control.

### Command Formats

| Command | Format | Key Fields |
|---------|--------|------------|
| ON/OFF/Level | 0x0E | zone@12, 0xEF@13, level@16-17, fade@19 |
| Hold-start | 0x09 | zone@12, 0x42@14, direction@16 |
| Dim step | 0x0B | zone@12, 0x42@14, direction@16 |

12 packets per command, type rotates 0x89/0x8A/0x8B, seq increments by 6.

### FCJS-010 Dimmer Specifics

| Field | Relay | Dimmer |
|-------|-------|--------|
| Format 0x28 byte 9 | 0x38 | 0x50 |
| Format 0x14 byte 22 | 0x00 | 0x02 |
| Format 0x13 | Not sent | Required |
| ON/OFF byte 19 | 0x00 | 0x01 |

## 7. Pairing

### Bridge Pairing (Caseta/RA3)

9-phase sequence (~60-70 seconds):

| Phase | Description |
|-------|-------------|
| 0 | Idle beacons (format 0x08, subcmd 0x01) |
| 1 | Active beacons (format 0x0C, subcmd 0x02) with load ID |
| 2 | Device announces (B0/B2, format 0x17, 53 bytes) |
| 3 | Bridge acknowledges: targeted beacon + config + unpair (0x82) |
| 4 | Brief beacon resume |
| 5 | Full config: 4 integration IDs + capabilities |
| 6 | Post-pairing beacons (subcmd 0x04 = "committed") |
| 7 | LED configuration (0x81, format 0x0A) |
| 8 | Handshake (C1-E0, 6 rounds challenge-response) |

**Critical implementation details:**

- **Handshake echo**: Bridge must echo device's exact challenge bytes with `type+1`, `seq+5`, `byte[5]=0xF0` (round 1 only), recalculated CRC. Hardcoded data = guaranteed failure.
- **Phase 3b field inversion**: Initial binding has `integ_id[0]` at bytes 9-12 and `device_id` at bytes 17-20 (opposite of all other phases).
- **Zone binding**: Byte 21 is always 0x20 regardless of round.
- **Retransmissions**: 6-12 per config packet, 500ms delays between phases.
- **Half-duplex timing**: Long RX windows (5s+) during handshake, minimal TX (3 packets max) between rounds.

**Switch vs dimmer**: Type 0x82/0x81 for switch, 0x83/0x83 for dimmer (unpair/LED). Dimmer needs format 0x15 config + multiple handshake cycles.

**Arbitrary subnets**: Any 16-bit subnet value works — devices don't validate.

### Vive Pairing

All packets are **53 bytes** (51 data + 2 CRC) with 0x00 padding.

| Phase | Packet | Direction | Description |
|-------|--------|-----------|-------------|
| 1 | B9 (format 0x11, timer=0x3C) | Hub → All | Beacon: pairing active |
| 2 | B8 (format 0x23) | Device → Hub | Device requests to pair |
| 3 | BA (format 0x10) | Hub → Device | Accept |
| 4-8 | A-type (formats 0x13, 0x28, 0x14, 0x12) | Hub → Device | Config sequence |
| 9 | B9 (format 0x11, timer=0x00) | Hub → All | Pairing ended |

**Key facts:**
- **B9** = Beacon (format 0x11, broadcast) — NOT BA
- **BA** = Accept (format 0x10, directed to device)
- Each config format needs **5+ retransmissions** with varying type bytes
- Device sends B8 retries throughout config — absence = config not received
- Format 0x12 byte 24 is the authoritative zone assignment

### Pico Direct Pairing

53-byte packets alternating B9/BB (direct-pair) or B8/BA (bridge-only). Contains device ID (3 instances), button scheme byte (0x04=5-button, 0x0B=4-button), and capability/engraving bytes.

| Pico Type | Pair Types | Engraving (byte 38) |
|-----------|------------|---------------------|
| 5-button | B9/BB | 0x06 |
| 4-button R/L | B9/BB | 0x21 |
| 4-button Scene (Relax) | B8/BA | 0x27 |
| 2-button ON/OFF | B9/BB | 0x01 |

### CCA Transfer / Device Programming

CCA activation mode is a **global transfer** — not device-specific pairing. The processor broadcasts the **complete CCA device table** to all devices on the channel. This is the CCA equivalent of CCX CoAP programming during Designer transfer.

**Sensor announcement (PAIR_BA format 0x17):**

Sensors announce themselves with PAIR_BA before transfer begins. Device type 0x0D (IREYE) identifies sensor devices.

| Byte | Value | Notes |
|------|-------|-------|
| 0 | 0xBA | Bridge-only announcement |
| 2-5 | serial | Device ID (BE) |
| 7 | 0x17 | Sensor-specific format |
| 9-13 | FF×5 | Broadcast |
| 14 | 0x0D | Device type = IREYE (sensor) |
| 15 | 0x05 | Capabilities |
| 16-19 | serial | Repeat 1 |
| 20-23 | serial | Repeat 2 |
| 28 | 0x0D | Device type repeat |

**Config packet structure (A5/A6/A7/0x85):**

Config packets contain the full device table as a packed serial list:
- Each entry: `[4-byte serial BE] [0x80 separator]`, last entry uses `[0xA0]` as end-of-list
- 6 config rounds per pass, format byte = `(round << 4) | page_type`
- Main series: page_type=5 → formats 0x05, 0x15, 0x25, 0x35, 0x45, 0x55
- Zone binding series: page_type=2 → formats 0x02, 0x12, 0x22
- 3 complete passes for redundancy
- Split across rounds is by packet capacity, NOT by device type

**Handshake:**

- Sensor echo uses C5 (type+4), not C2 (type+1) like dimmers
- Final commit: all 6 types (C1→C7→CD→D3→D9→DF) blasted at ~75ms

**Post-transfer effects on sensors:**

Unpaired daylight sensor sends minimal OWT bursts; after transfer, burst count increases to 12+. The transfer likely programs channel assignment and TX redundancy parameters into the sensor's non-volatile memory.

## 8. Device Configuration

All config packets use **type bytes A1-A3** and must be **53 bytes** with 0x00 padding. Type byte rotates A1→A2→A3 across separate config calls (constant within a burst). Zone alternation: first packet on primary zone, rest on alternate (low byte +2).

### Format 0x11: LED Mode

Bytes 23-24 control status LED behavior:

| Mode | Byte 23 (load OFF) | Byte 24 (load ON) |
|------|-------------------|-------------------|
| Off | 0x00 | 0x00 |
| Always on | 0xFF | 0xDF |
| On when load off | 0xFF | 0x00 |
| On when load on | 0x00 | 0xDF |

### Format 0x1C: Default Fade Rate

Bytes 23-26 set fade-on and fade-off times:
- Bytes 23-24: fade_on (uint16 **little-endian**, quarter-seconds)
- Bytes 25-26: fade_off (uint16 **little-endian**, quarter-seconds)

### Format 0x15: Trim

High/low trim levels for dimmers. Wrapped in a 3-phase sandwich: 0x82 (OFF) → 0xA3 (config) → 0x81 (save).

| Byte | Value | Notes |
|------|-------|-------|
| 0 | 0xA3 | Always A3 (does NOT rotate) |
| 20 | high trim | `percent * 254 / 100` |
| 21 | low trim | `percent * 254 / 100` |
| 22-26 | `23 0B 60 00 00` | Constants |
| **27-28** | **`00 FE`** | **Data, NOT padding. Keep fixed values.** |
| 29-50 | 0x00 | Actual padding starts here |

Only 2 config packets (seq 0x01 on primary zone, seq 0x02 on alternate). Phase (forward/reverse) encoding is **unsolved**.

### Format 0x1A: Scene Config

Programs per-device fade and delay times for scene recall.

| Byte | Value | Notes |
|------|-------|-------|
| 15 | 0x40 | Scene component (not 0x50 dimmer) |
| 23 | 0x02/0x03 | Packet number |
| **28-29** | uint16 **BE** | Fade time (quarter-seconds) |
| **30-31** | uint16 **BE** | Delay time (quarter-seconds) |

Note the **big-endian** encoding — unlike format 0x1C which uses little-endian. Only 2 retransmissions (not 20 like LED/fade).

Programming sequence: A3 format 0x1A → 0x81 format 0x0A → C/D status → format 0x0D (scene definition, static) → format 0x0B (scene trigger).

### Format 0x0A: Pairing-Time LED

LED config during pairing uses format 0x0A with type 0x81 (broadcast). Different from runtime format 0x11.

## 9. Firmware OTA Wire Protocol

Firmware updates run over the **same RF channel and N81 framing as runtime CCA** (sections 1-8). The bridge's coproc wraps OTA-specific packet types and sub-opcodes into runtime-CCA-shaped packets — there is no separate OTA radio mode, no separate channel, no separate framing.

The earlier static-RE understanding (separate `[55 55 55][FF][FA DE][LEN][OP][BODY][CRC]` raw-bit framing) describes the **host↔coproc IPC layer**, not what flies over RF. Both layers exist concurrently:

| Layer | Substrate | What it carries | RE'd from |
|-------|-----------|-----------------|-----------|
| **On-air RF** | 433.602844 MHz, N81, runtime CCA framing | `0x91/0x92/0xB1/0xB2/0xB3` packets with `06 nn` sub-opcodes | [docs/firmware-re/cca-ota-live-capture.md](../firmware-re/cca-ota-live-capture.md) — 19-min IQ capture against Caseta Pro REP2 + DVRF-6L, 90.7% chunk match against source PFF |
| **Coproc IPC** | host UART, HDLC | `0x2A/0x32/0x36/0x41/0x58` opcodes with raw-bit framing | Phoenix EFR32 coproc binary, [docs/firmware-re/caseta-cca-ota.md](../firmware-re/caseta-cca-ota.md) |

These two layers are **NOT** the same byte sequence. The bridge's coproc translates IPC commands from lutron-core into on-air sub-opcodes before TX. See §9.4 for the IPC↔on-air mapping.

### 9.1. On-air framing (the RF layer)

OTA traffic uses runtime CCA framing (§2): preamble + sync delimiter + `FA DE` sync word, N81-encoded body, CRC-16 / `0xCA0F`. The packet **type byte** at offset 0 determines length per the standard CCA size rule (§3) — no length-prefixed self-describing header.

Two on-air packet shapes carry the OTA conversation:

**Long chunk packets (53 bytes, type `0xB1`/`0xB2`/`0xB3`)** — TransferData carriers, body bytes 14-15 = `06 02`:

```
byte    field             value/notes
0       type              0xB1, 0xB2, or 0xB3 (TDMA cycle; 0xB1 rare or absent in observed OTA)
1       0x01              constant
2-4     a1 ef fd          static prefix (hub-ID-ish)
5       0x00              constant
6-7     21 2b             constant (53-byte length signature)
8       0x00              constant
9-12    device serial     4 bytes BE (e.g. 06 fe 80 20)
13      0xfe              constant
14-15   06 02             on-air sub-opcode = TransferData
16      sub-counter       0..0x3F, cycles
17-18   chunk addr LO     16-bit BE; advances 0x1F = 31 / packet
19      0x1F              chunk size = 31 bytes
20-50   31 bytes          verbatim from PFF[file_offset], encrypted (per-model AES key)
51-52   CRC-16 (poly 0xCA0F, BE)
```

`file_offset = page * 0x10000 + chunkAddrLo` where `page ∈ {0, 1, 2, ...}`. The page indicator is **not** in this packet — it's set by the ChangeAddressOffset short packet at each 64 KB boundary (see below).

**Short control packets (24 bytes, type `0x91`/`0x92`/`0x81`/`0x82`/`0x83`)** — same byte 0..15 layout as the long packet, then a 6-byte body, then CRC. Carrier type encodes addressing scope:

| Type | Addressing scope | Bytes 9-12 |
|------|-------------------|------------|
| `0x81`/`0x83` | Broadcast to a DeviceClass | 4-byte DeviceClass (e.g. `04 63 02 01` = Vogelkop) |
| `0x82` | Broadcast (beacon-tail variant) | DeviceClass |
| `0x91`/`0x92` | Unicast to a single device | 4-byte device serial BE |

### 9.2. On-air sub-opcodes (`06 nn`)

Body bytes 14-15 follow the pattern `06 nn`. Confirmed values:

| `06 nn` | Operation | Carrier type | Notes |
|---------|-----------|--------------|-------|
| `06 00` | **BeginTransfer** | `0x92` (unicast) | Once at session start. Payload `02 20 00 00 00 1F` (last byte = chunk size 31; leading 5 bytes' meaning open — see §9.6). |
| `06 01` | **ChangeAddressOffset** | `0x91` (unicast) | Once per 64 KB page boundary. Payload bytes 16-19 = `(prev_page, new_page)` as 16-bit BE pair (e.g. `00 01 00 02` = page 1 → page 2). |
| `06 02` | **TransferData** | `0xB1`/`0xB2`/`0xB3` (long) | Per-chunk payload carrier (see §9.1). |
| `06 03` | **Device-poll** (multi-purpose pre-flight probe, no payload — body is 6 bytes of `cc` filler) | `0x81/0x82/0x83` (broadcast) or `0x91/0x92` (unicast) | Fires throughout OTA at OTA start, page wraps, OTA end. |

**`06 nn` ≥ `04` does not exist on-air.** EndTransfer / ResetDevice / CodeRevision / QueryDevice — all with named static-RE IPC opcodes — were not observed on RF in the 19-minute capture. The bridge stops sending TransferData when it has streamed the full firmware; the device's bootloader autonomously commits when its expected chunk count is reached and reboots. This is "open-loop" from the bridge's point of view.

### 9.3. Modem config (CC1101)

Identical to runtime CCA — same channel, same modulation, same data rate. The static RE earlier suggested OTA used a separate mode at 30.49 kbps with 35-channel hopping. Both claims are wrong:

- **Single channel** at 433.602844 MHz (runtime CCA channel). 90 s spectrogram shows energy in one ~80 kHz band, no hopping.
- **~62.5 kbps** (runtime CCA's bit clock). Live-capture peak-to-peak on a `1010` preamble = 31 µs / 2 bits = ~64 kHz.

The 35-row table at PowPak BN `0x9B30` and Phoenix BN `0x08018e30` is some other structure (calibration LUT, retry-channel list, or unrelated). It is NOT a hop table.

### 9.4. Coproc IPC ↔ on-air mapping

The bridge's lutron-core dispatches firmware updates via 8 HDLC IPC commands ([caseta-cca-ota.md §"OTA Wire Vocabulary"](../firmware-re/caseta-cca-ota.md#ota-wire-vocabulary)). Each IPC opcode maps to either an on-air sub-opcode or to no-op-on-air (the coproc handles it locally without RF traffic):

| IPC opcode | HDLC cmd | IPC name | On-air sub-opcode | Notes |
|------------|----------|----------|-------------------|-------|
| `0x2A` | `0x113` | BeginTransfer | `06 00` | Direct mapping. |
| `0x41` | `0x115` | TransferData | `06 02` | Direct mapping. |
| `0x32` | `0x119` | Control / ChangeAddressOffset | `06 01` | One of three IPC variants for opcode `0x32`. |
| `0x32` | `0x11B` | Control / EndTransfer | — | **No on-air representation.** Bridge stops TransferData; device commits autonomously. |
| `0x32` | `0x11D` | Control / ResetDevice | — | **No on-air representation.** Device reboots autonomously after commit. |
| `0x36` | `0x11F` | CodeRevision | — | Coproc replies from cache; not seen on RF. |
| `0x3A` | `0x121` | ClearError | — | Recovery, only on error path. |
| `0x33` | `0x125` | GetDeviceFirmwareRevisions | — | Cached query. |
| `0x34` | `0x127` | CancelDeviceFirmwareUpload | — | Local abort. |
| `0x35` | `0x129` | Broadcast | (likely `06 03` with broadcast carrier) | Pre-flight, scope = DeviceClass. |
| `0x58` | `0x111` | QueryDevice | (likely `06 03` with unicast carrier) | Pre-flight, scope = serial. |
| `0x3C` | `0x12B` | AckNotify | — | Coproc-internal. |

So the on-air conversation reduces to **three directional sub-opcodes from bridge to device** (`06 00` BeginTransfer, `06 01` ChangeAddressOffset, `06 02` TransferData) plus the periodic `06 03` pre-flight pollers. Everything else in the IPC vocabulary either maps to nothing on-air or is a coproc-local cache/control op.

### 9.5. Device-side ACK channel (`0x0B` XOR-encoded)

Throughout an OTA the device emits a 5-byte XOR-encoded `0x0B` packet every 25 ms (40 Hz). This is the *only* device→bridge channel observed on-air. It is **status-only** — there is no per-chunk NACK or retransmit-request mechanism.

Wire layout (NOT N81 — XOR-encoded, validated by the firmware decoder at `firmware/src/cca/cca_decoder.h:309 try_parse_dimmer_ack`):

```
[0]  0x0B
[1]  sequence (cycles 0x02 → 0x04 → 0x06 → 0x08 → 0x0A → 0x0C between chunks)
[2]  format ^ 0xFE         ← actual status code
[3]  byte[1] ^ 0x26        ← integrity check
[4]  format ^ 0x55 ^ 0xFE  ← redundant XOR-shadow of byte[2]
```

The corrected `format` byte is the device's state code:

| `format` | Frequency | Phase | Inferred state |
|----------|-----------|-------|----------------|
| `0x2E` | ~89.7% of OTA | Steady-state TransferData | "in-progress, idle" |
| `0xC1` | ~32 ACKs at OTA start | Pre-first-chunk | "ready / handshake" |
| `0xC2` | ~32 ACKs near page wrap | Around `06 01` ChangeAddressOffset | "advancing page" |
| `0xEC` | ~35 ACKs at OTA end | Post-last-chunk | "committing / done; reboot pending" |

Watching for `format=0xEC` after the last chunk is the bridge's only on-air signal that the device has accepted the firmware and is committing.

### 9.6. Open: BeginTransfer payload semantics

`06 00` payload bytes 16-21 = `02 20 00 00 00 1F`. The trailing `0x1F` is the chunk size (31 bytes). The leading 5 bytes don't decode obviously as firmware size, chunk count, or session ID. Likely encodes total-transfer-size or an identifier the bootloader uses to size its receive buffer. **Resolving this requires Phoenix EFR32 coproc RE at the IPC `0x2A` handler** — entry points at BN `0x08018c18` / `0x08018c98`.

This matters for synth-TX from Nucleo+CC1101: without correct BeginTransfer payload, the device may refuse to enter receive mode or commit a wrong-sized image.

### 9.7. DeviceClass enforcement

The Phoenix coproc has **no DeviceClass enforcement** — it relays whatever lutron-core asks. The on-device gate (whether a PowPak refuses an LMJ image when its in-flash DeviceClass says RMJ, etc.) is whatever the bootloader itself does. See [docs/firmware-re/powpak.md §"Bootloader unknowns"](../firmware-re/powpak.md#bootloader-unknowns-gates-paths-2-and-3) — the OTA-receive handler at PowPak BN `0x4290` / `sub_8bb4` is the gating RE target.

### 9.8. Reproducibility — source binary anchors

Phoenix EFR32 coproc (`phoenix_efr32_8003000-803FF08.bin`, load `0x08003000`):

| Anchor | BN address | Notes |
|--------|------------|-------|
| CC1101 register init | `0x08018c18` / `0x08018c98` | Same regs as runtime CCA |
| HDLC cmd dispatch chain | `0x08004706` | Routes IPC → handler |
| FirmwareUpdate handler cluster | `0x0800ee80`–`0x0800f2d8` | IPC opcode handlers |
| Coproc OTA framing template (host↔IPC layer) | `0x08018a8c` | The `55 55 55 FF FA DE 08 02` pattern lives here, NOT on-air |
| 35-row table (NOT a hop table) | `0x08018e30` | Purpose unknown |

PowPak HCS08 RX-side (`PowPakRelay434L1-53.bin`):

| Anchor | BN address | Notes |
|--------|------------|-------|
| Sync word check (`CPHX #$FADE`) | `0x92C0` | Recognizes runtime CCA sync |
| Flash-write primitive | `0x4290` | Writes one byte to flash |
| OTA-receive flash writer (orphaned, IRQ-only) | `sub_8bb4` | Likely the body of the `06 02` TransferData handler |

## 10. Hardware Notes

### CC1101 RX Limitations

The CC1101 in variable-length mode **truncates 53-byte config packets to 24 bytes**. Root causes:
1. N81 decoder stops on first framing error (single bit corruption at ~byte 24 kills remaining bytes)
2. CRC scanner returns shortest match (spurious CRC at 24 bytes steals the result)

**Always verify with RTL-SDR** for config packet analysis. CC1101 is reliable for 24-byte button/level packets.

```bash
# RTL-SDR capture (2 MHz = 32 samples/bit)
rtl_sdr -f 433602844 -s 2000000 -g 40 capture.bin

# Decode
bun run tools/cca/rtlsdr-cca-decode.ts --rate 2000000 capture.bin
```

### 0x0B ACK Packets

Dimmers send **5-byte XOR-encoded ACK packets** (type `0x0B`) — NOT standard 24-byte N81 CCA. Decoder rule lives in `firmware/src/cca/cca_decoder.h:309 try_parse_dimmer_ack`.

```
[0] 0x0B
[1] sequence
[2] format ^ 0xFE         ← actual status code
[3] byte[1] ^ 0x26        ← integrity check (no CRC)
[4] format ^ 0x55 ^ 0xFE  ← redundant XOR-shadow of byte[2]
```

Validation: `byte[3] == byte[1] ^ 0x26`. Correction: `format = byte[2] ^ 0xFE`, `level = byte[4] ^ 0xFE`. The "level" field is just `format ^ 0x55` in every observed case — it is a redundant XOR-shadow, not an independent value.

Cadence: 1 ACK every 25 ms (40 Hz) when the dimmer is in any active state (set-level, config, or OTA). 3 ACKs at ~25 ms intervals per runtime command.

During an OTA the `format` byte is the **device's state code** — see §9.5 for the OTA-specific state table (`0x2E` in-progress, `0xC1` ready, `0xC2` advancing-page, `0xEC` committing). For non-OTA traffic, `format` carries the response class for the runtime command being acknowledged.

## 11. Known Unknowns

- **Pico fast fade**: Pico payload is 5 bytes (no room for fade). Extended packets and alternative framings all failed. Likely requires solving the DEVICE→OUTPUT path.
- **Trim phase encoding**: Forward/reverse phase location unknown — byte 22 (0x23) is constant across captures.
- **Format 0x0E bytes 20-21**: Always 0x00 in captures. Could be delay field (untested).
- **Component byte 0x40 vs 0x50**: May unlock different parameter spaces (scene vs dimmer config).

## 12. Discovery Notes

> **Discovery (2026-02-05): Fade Time Control**
>
> Byte 19 of format 0x0E = fade time in quarter-seconds. Discovered from CC1101 captures of Caseta LEAP commands with different transition times. Previously thought byte 19 was dimmer/relay variant flag (0x01/0x00) — it's actually fade time. Shared between Vive and Caseta bridge — identical format 0x0E, same byte position. Works on both `send_vive_level()` and `send_bridge_level()`.

> **Discovery (2026-02-05): Zone Encoding Problem (RESOLVED)**
>
> Root cause: `start_vive_pairing()` didn't accept/propagate `zone_id` — auto-accept always defaulted to 0x38. Fix: Added `zone_id` param to `start_vive_pairing()`, stored as `vive_zone_id_`, passed through auto-accept. See `docs/vive-protocol.md` for full writeup.

> **Discovery (2026-02-06): Vive Pairing Protocol (RESOLVED)**
>
> - B9 = Beacon (format 0x11, broadcast) — NOT BA!
> - BA = Accept (format 0x10, directed to device)
> - All pairing packets must be 53 bytes (51 data + 2 CRC) with CC padding
> - Config packets that were too short caused partial pairing (device emits state but doesn't respond to zone commands)
> - Every config format needs 5+ retransmissions with rotating type bytes
> - Device sends B8 retries throughout config phase — absence of B8 = config not received

> **Discovery (2026-02-06): Vive Dimming & Set-Level (RESOLVED)**
>
> - Hold-start (format 0x09) is REQUIRED before dim steps (format 0x0b). Without it, device ignores dim step packets entirely.
> - Hold-start: byte 15 = 0x00 (hold), dim step: byte 15 = 0x02 (step)
> - Both use command class 0x42 at byte 14, direction at byte 16 (0x03=raise, 0x02=lower)
> - Sequence: 6 hold-start packets, then 12 dim step packets
> - Arbitrary set-level works! Format 0x0E bytes 16-17 accept any value 0x0000-0xFEFF
> - Vive app only exposes on/off/raise/lower, but the dimmer accepts direct level commands

> **Discovery (2026-02-06): Caseta/RA3 Bridge Pairing (RESOLVED)**
>
> - Handshake echo is CRITICAL — bridge must echo device's exact challenge bytes: `type+1`, `seq+5`, `byte[5]=0xF0` (round 1 only), recalculate CRC. Hardcoded handshake data = guaranteed failure; device validates the echo.
> - Phase 3b field order: integ_id[0] at bytes 9-12, device_id at bytes 17-20 (opposite of later phases)
> - Zone binding level packet: byte 21 always 0x20 (not round-dependent like integ packets)
> - Retransmissions: 6-12 per config packet, 500ms delays between phases
> - Half-duplex handshake timing: Maximize RX windows (5s+), minimize TX interruptions (3 packets max)
> - Arbitrary subnets work — no subnet validity constraint; earlier failures were all handshake bugs
> - Switch vs dimmer differences: type 0x82/0x81 for switch, 0x83/0x83 for dimmer (unpair/LED)
> - Dimmer needs format 0x15 config + multiple handshake cycles (not yet implemented)

> **Discovery (2026-02-08): Pico Arbitrary Set-Level (FADE UNSOLVED)**
>
> Dimmers accept arbitrary level values from pico-style packets — no bridge pairing needed. Byte 8=0x03, repeated device ID at bytes 12-15, payload bytes 17-21 (only 5 bytes). Fade always slow (~3 min) — pico payload too short for fade field, TEMPORARY limitation. API: `POST /api/pico-level` / `/api/pico-level-raw`.

> **Discovery (2026-02-10): Device Config — LED/Fade/Trim/Scene (RESOLVED)**
>
> Type bytes A1-A3 (0xA0+) require 53-byte packets (51 data + 2 CRC) with CC padding. Type byte rotating counter: constant within burst, A1→A2→A3 across separate config calls. Zone alternation: first packet on primary zone, rest on alternate (low byte +2).
>
> **Fade Config (format 0x1C):** Bytes 27-35 = static from capture: `02 00 28 00 14 00 01 1E FF` (purpose unknown). No delay support — tested bytes 24/26 (broke fade, confirmed as uint16 MSBs), bytes 27-30 as LE and BE (no effect). Delay is scene-only (format 0x1A).
>
> **Scene Config (format 0x1A):** Programming sequence: A3 format 0x1A → 0x81 format 0x0A → C/D status → format 0x0D → format 0x0B. Format 0x0D (scene definition) is STATIC across all fade/delay settings. Format 0x0B (scene trigger) bytes 16-18 are scene revision hash, NOT fade/delay.
>
> **Trim Config (format 0x15):** RTL-SDR confirmed CRC OK. Type byte = always 0xA3 (not rotating like LED/fade). Bytes 27-28 = `00 FE` (NOT CC padding! This was the lockup root cause). Sandwich types: 82 (OFF) → A3 (config) → 81 (save) (NOT 83→A3→82!). Only 2 config packets: seq 0x01 on AD, seq 0x02 on AF. Phase 3 save: high-end=0xFEFF (100%), low-end=0x0001 (min). Reference: `captures/trim-*.bin`, `captures/phase-{forward,reverse}.bin` (RTL-SDR).

> **Discovery (2026-02-12): Dimmer 0x0B ACK Packets**
>
> Dimmer sends 5-byte ACK packets (type 0x0B) in response to bridge commands — NOT standard 24-byte CCA. CC1101 decodes bytes 0,1,3 correctly but bytes 2,4 are XOR'd with 0xFE (systematic error). RTL-SDR confirmed: `0B 05 00 23 55` (correct) vs CC1101: `0B 05 FE 23 AB`. Dimmer sends 3 ACKs at ~25ms intervals after each bridge command. Bridge 0x81 SET_LEVEL commands decode fine on CC1101 with CRC OK. This explains ALL "dimmer state report" decode failures — they were never 24-byte packets. Reference captures: `captures/rtlsdr-set-level.bin`, `captures/rtlsdr-config.bin`.

> **Discovery (2026-02-13): Phase Config (format 0x15, RESOLVED)**
>
> Same packet structure as trim config, byte 22 encodes phase mode. Forward = 0x03, Reverse = 0x23 (bit 5 of byte 22 is the phase flag). Previous trim captures all had 0x23 because dimmer was in reverse mode. Trim packets carry phase along — setting trim also re-sends current phase. Pairing-time LED uses format 0x0A (broadcast, 0x81) — different from runtime 0x11.

> **Discovery (2026-02-15): 4-Button Pico Packet Structure (CONFIRMED)**
>
> - SCENE4 (0x08) = TOP button, SCENE1 (0x0B) = BOTTOM on both pico types
> - Press/release flip-flop: R/L puts command in PRESS (fmt 0x0E), scene puts it in RELEASE
> - Byte 17 (cmd_class): 0x40=scene/preset, 0x42=dim control
> - Byte 19 (cmd_param): preset ID (0x20=top, 0x21=2nd, etc.) or dim direction (0x01=raise, 0x00=lower)
> - R/L ON/OFF use cmd_class=0x40 (same as scene), RAISE/LOWER use cmd_class=0x42
> - R/L release format: 0x04 for on/off, 0x0C for raise/lower (dim stop)
> - Auto-detect: fmt 0x0E on PRESS = R/L pico; fmt 0x04 on PRESS = scene pico

### FCJS-010 Dimmer Config Notes

- Format 0x28 byte 9 = 0x50 (dimmer), not 0x38 (relay)
- Format 0x14 byte 22 = 0x02 (dimmer capability), not 0x00
- Format 0x13 (dimming config) required for dimmers, not sent for relays
- ON/OFF byte 19 = 0x01 for dimmer, 0x00 for relay

### RTL-SDR Verification Notes

- CC1101/ESP32 packet logs TRUNCATE packets in variable-length mode — always verify protocol with RTL-SDR captures of real hardware
- Decode command: `bun run tools/cca/rtlsdr-cca-decode.ts --rate 2000000 <file.bin>`
- Capture command: `rtl_sdr -f 433602844 -s 2000000 -g 40 <output.bin>`
- Use 2 MHz sample rate (32 samples/bit) for best results
- CC1101 variable-length mode misses packets it's not configured for — it only captures packets matching its configured length/sync settings
- RTL-SDR decoder improvements (2026-02-10): wider threshold region (100 bits instead of 16) — burst onset transients cause preamble FM swings of ±1.0 but data is only ±0.08; amplitude consistency check on preamble candidates — rejects burst transients that have >40% variation (real preambles have <10%); polarity retry — when sync/prefix extraction fails, tries opposite polarity

### Common Pitfalls

- Type byte determines packet length: 0x80-0x9F = 24 bytes, 0xA0+ = 53 bytes (51 data + 2 CRC)
- ALL pairing AND config packets (type A0+) must be 53 bytes with CC padding and CRC
- CC padding doesn't always start where you think — some formats have data bytes past the "obvious" payload end (e.g. trim has `00 FE` at bytes 27-28, not CC padding)
- Use `memset(0xCC)` not `memset(0x00)` for packet padding
- Sequence bytes vary but don't affect basic function
- Zone ID placement varies by packet format (byte 9 for 0x28, byte 24 for 0x12)
- Format 0x28 byte 10 (`zone_id + 0x23`) is non-critical; format 0x12 byte 24 is authoritative

## 10. Non-OTA Opcode Map (from EFR32MG12 RE)

This section documents the **bridge-side** TX dispatch found while reverse
engineering the Phoenix CCA EFR32 coprocessor binaries
(`phoenix_efr32_8003000-801FB08.bin` and `phoenix_efr32_8004000-803A008.bin`).

The dispatch is NOT a single master `switch(op)` table the way the OTA opcodes
are; it is split across:

1. A **TX message-class builder** (`FUN_08006784` in 801FB08, `FUN_08008848` in
   803A008). Selects an OP byte from a small message-class index and writes it
   to byte 5 of the outgoing packet buffer (after a 4-byte header). 6 cases.
2. A set of **format-specific TX wrappers** (~13 callers of the generic packet
   allocator `FUN_0800fbd4` in 801FB08). Each one writes its specific OP byte
   and format byte (offset 0x0E) for the wire packet.
3. An **OTA pairing/transfer state machine** (`FUN_0800bfe0` in 803A008,
   `FUN_08009e08` in 801FB08). 12 states, drives the OTA wake-up sequence
   documented in [docs/firmware-re/powpak.md](../firmware-re/powpak.md).

Because of this split, "the master CCA RX dispatch" doesn't appear as a single
TBB/TBH lookup — instead, an RX packet flows through CRC verification (using
the `0xCA0F` table at `0x0801E8D0` in 801FB08), then through cmp-cascades that
classify by length-band first (`cmp r0, #0x80` paired with `cmp r0, #0xa0` in
3 spots in 803A008 at `0x080130bc`, `0x08013e6a`, `0x080118ce`) before fanning
out to per-format handlers.

### TX Builder Cases (mirror in both CCA-side EFR32 binaries)

The 6-case TX message-class builder (`FUN_08008848` / `FUN_08006784`):

| Case | OP byte written | Length | Mapping to existing TS catalog |
|------|-----------------|--------|--------------------------------|
| 0 | `0x88 \| (cfg & 7)` → `0x88-0x8F` | 24-byte short pkt | NEW — short-packet state report range above documented `0x80-0x83`; matches CCA "type 0x80-0x9F = 24 bytes" rule from §3 |
| 1 | `0xA0 \| (cfg & 7)` → `0xA0-0xA7` | 53-byte long pkt | Partial — `CONFIG_A1` (0xA1), `SET_LEVEL` (0xA2), `CONFIG_A3` (0xA3) already in `protocol/cca.protocol.ts`; `0xA0/0xA4-0xA7` are NEW |
| 2 | `0xCE` | 24-byte short pkt | KNOWN — `HS_CE` "Handshake round 3 (bridge)" |
| 3 | `0xFC` (length=1, byte+0xb=3, byte+0xd=1) | 1-byte | NEW — short broadcast with length=1 only. Distinct from the existing virtual `SENSOR_VACANT` (0xFC, 24-byte, format 0x0C). On-air this is a short control beacon |
| 4 | `0xFD` followed by `0x82 0x80 ... <product-id-LE16> ...` (14 bytes total) | 14-byte | KNOWN family — UNPAIR group. The product-ID short differs per binary: `0x5006` in 801FB08, `0xA812` in 803A008 — likely the bridge's own QS hardware ID literal |
| 5 | `0xE9` (variable) | reads from external buffer; bitfield-encoded byte 7 | NEW — **multi-part transmit**, encodes a 4-bit flag mask (lower nibble bits 3..6) into byte 7 alongside an 8-bit address-class field. Likely a sensor-event echo or a multi-target dispatch (4 flag bits = 4 destinations) |

After the OP byte selection the builder calls `FUN_08004c7c` (in 801FB08) or
`FUN_08006d34` (in 803A008) — those are the queued-TX submit routines.

### OTA pairing / transfer state machine (12 states)

`FUN_0800bfe0` in 803A008 / `FUN_08009e08` in 801FB08. State variable lives at
`*DAT_0800c218` (803A008) / `*DAT_0800a040` (801FB08). States:

| State | Behavior |
|-------|----------|
| 0 | Idle — wait for tick, set retry counter (4-byte field +4 = `0xc2 0x01 0x00 0x00`), advance to 1 |
| 1 | Pairing-tx — call `FUN_080066c6` (TX builder), advance to 2 |
| 2 | Quiet — clear retry counter, wait |
| 3, 4 | Idle hold — countdown then `FUN_080141b8` (kick scheduler) |
| 5 | Bulk-broadcast — `FUN_0800b1dc(7)`, build 7-byte packet `FF FF FF FF FF 02 04` (broadcast addr + cmd 2 op 4), submit, advance to 6 |
| 6 | Multi-target loop — increment slot ptr+0x16, decrement remaining ptr+0x13; for each, build packet `FF FF FF FF FF 02 03 <slot+1> <remaining-1>` then payload from `FUN_0801431a`; when both counters exhaust, fall back to baseline state (max(ptr[1], 2)) or to state 7 |
| 7 | Final TX — uses *separate* buffer at `DAT_0800c2a4`, packet `FF FF FF FF FF 02 05`, submit, advance to baseline; conditionally writes packet trailer `60 EA 00 00` at offsets +4..+7 if state ∈ {3,4} |
| 8 | Search — call `FUN_08014c48(slot, 1)`, advance to 9 if found |
| 9 | Confirm — call `FUN_08014c48(slot, 0)`, then write `60 EA 00 00` trailer; on transient error log |
| 10 | Tear-down — countdown then `FUN_08014bb0` (release/finalize) |
| 11 | Pre-tx wait — countdown calls `FUN_0800aea0`, otherwise spinner via `FUN_0800676a` and `FUN_0800b1c0` |

The constants `02 04`, `02 03`, `02 05` written into byte+5..6 of the broadcast
packets correspond to STATE_RPT cmd_class + op pairs — these are the bridge-side
"broadcast pair / pair-confirm / pair-end" sequence that appears during
multi-device pairing. These overlap with the OTA opcode 0x32 multi-purpose-control
path documented in [docs/firmware-re/powpak.md](../firmware-re/powpak.md).

### Verifying which binary is which (CCA classification)

Both `phoenix_efr32_8003000-801FB08.bin` and `phoenix_efr32_8004000-803A008.bin`
contain:

- The strings `"Cordless wakeup unsupported event received"` and
  `"Link event unsupported event received"` (CCA-specific debug logs — not
  present in the other two EFR32 binaries).
- The `0xFADE` sync word as a 16-bit BE constant adjacent to the CRC-16 lookup
  table for poly `0xCA0F` — at `0x0801E8C8` / `0x0801E8D0` in 801FB08.
- The `"L-BDG"` product code string (Lutron SmartBridge Pro / DC32_CCT_PROCESSOR
  `0x08030101`).

The other two EFR32 binaries (`8003000-803FF08.bin`, `8003000-807F808.bin`)
have neither and are CCX-side. See [docs/firmware-re/coproc.md](../firmware-re/coproc.md)
for the full classification table.

### TODO / open questions

- Locate the **format-byte 0x0E** discriminator on the RX path. The TX wrappers
  set it via individual functions but the RX-side handler that dispatches on it
  hasn't been pinned. The 3 cmp-`0x80`-then-cmp-`0xa0` sites in 803A008 are TX
  builders; the RX path may live in an interrupt handler or a dispatch table
  in RAM populated at boot (which doesn't show in static analysis).
- The OP `0xE9` (case 5) bitfield encoding suggests a 4-target multicast or a
  4-button keypad event echo. Not yet mapped to any existing packet type.
- Cross-check between the two CCA binaries: the per-firmware constant in case 4
  (`0x5006` vs `0xA812`) should encode the bridge's own QS hardware ID — verify
  against a live capture of the bridge sending an UNPAIR.
- The 64-entry TBB/TBH "tables" found by the `WalkARMSwitchTables.java`
  walker are largely false positives — Cortex-M TBB tables don't include a
  size word, so the walker over-reads into the next basic block. The
  decompile-side switch reveals real sizes (e.g. 6 cases for the TX builder,
  12 for the OTA state machine).
