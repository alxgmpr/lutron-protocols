# CCA Protocol Notes

Collected reverse-engineering notes for Clear Connect Type A (433 MHz FSK) protocol.

## Vive Pairing Protocol (RESOLVED 2026-02-06)

- **B9** = Beacon (format 0x11, broadcast) - NOT BA!
- **BA** = Accept (format 0x10, directed to device)
- All pairing packets must be **53 bytes** (51 data + 2 CRC) with CC padding
- Config packets that were too short caused partial pairing (device emits state but doesn't respond to zone commands)
- **Every config format needs 5+ retransmissions** with rotating type bytes
- Device sends B8 retries throughout config phase - absence of B8 = config not received

## Pico Arbitrary Set-Level (DISCOVERED 2026-02-08, FADE UNSOLVED)

- Dimmers accept arbitrary level values from pico-style packets — no bridge pairing needed
- Byte 8=0x03, repeated device ID at bytes 12-15, payload bytes 17-21 (only 5 bytes)
- **Fade always slow (~3 min)** — pico payload too short for fade field, TEMPORARY limitation
- API: `POST /api/pico-level` / `/api/pico-level-raw`

## Vive Dimming & Set-Level (RESOLVED 2026-02-06)

- **Hold-start (format 0x09) is REQUIRED before dim steps (format 0x0b)**
- Without hold-start, device ignores dim step packets entirely
- Hold-start: byte 15 = 0x00 (hold), dim step: byte 15 = 0x02 (step)
- Both use command class 0x42 at byte 14, direction at byte 16 (0x03=raise, 0x02=lower)
- Sequence: 6 hold-start packets, then 12 dim step packets
- **Arbitrary set-level works!** Format 0x0E bytes 16-17 accept any value 0x0000-0xFEFF
- Vive app only exposes on/off/raise/lower, but the dimmer accepts direct level commands
- Level encoding: `level16 = percent * 0xFEFF / 100` (same as bridge SET_LEVEL)

## Fade Time Control (DISCOVERED 2026-02-05)

- **Byte 19 of format 0x0E = fade time in quarter-seconds**
- Discovered from CC1101 captures of Caseta LEAP commands with different transition times
- 0x01 = 250ms (default), 0x04 = 1s, 0x28 = 10s
- Encoding: `byte19 = seconds * 4`
- **Shared between Vive and Caseta bridge** — identical format 0x0E, same byte position
- Previously thought byte 19 was dimmer/relay variant flag (0x01/0x00) — it's actually fade time
- Works on both `send_vive_level()` and `send_bridge_level()`

## Device Config (LED/Fade/Trim/Scene) — RESOLVED (2026-02-10)

- **Type bytes A1-A3 (0xA0+) require 53-byte packets** (51 data + 2 CRC) with CC padding
- Type byte rotating counter: constant within burst, A1→A2→A3 across separate config calls
- Zone alternation: first packet on primary zone, rest on alternate (low byte +2)

### LED Mode (format 0x11)
- 2-byte encoding at bytes 23-24
  - Byte 23 = LED state when load OFF (0xFF=on, 0x00=off)
  - Byte 24 = LED state when load ON (0xDF=on, 0x00=off)
  - Modes: off=00/00, on=FF/DF, load-on=00/DF, load-off=FF/00

### Fade Config (format 0x1C)
- uint16 LE quarter-seconds at bytes 23-26
  - Bytes 23-24 = fade_on (uint16 LE), bytes 25-26 = fade_off (uint16 LE)
  - Bytes 27-35 = static from capture: `02 00 28 00 14 00 01 1E FF` (purpose unknown)
  - **No delay support** — tested bytes 24/26 (broke fade, confirmed as uint16 MSBs),
    bytes 27-30 as LE and BE (no effect). Delay is scene-only (format 0x1A).

### Scene Config (format 0x1A) — CONFIRMED (2026-02-10)
- Bytes 28-29 = fade time (uint16 **big-endian** quarter-seconds)
- Bytes 30-31 = delay time (uint16 **big-endian** quarter-seconds)
- Note: BE encoding unlike format 0x1C which uses LE!
- Byte 15 = 0x40 (scene component), not 0x50 (dimmer component)
- Only 2 retransmissions (not 20 like LED/fade)
- Programming sequence: A3 format 0x1A → 0x81 format 0x0A → C/D status → format 0x0D → format 0x0B
- Format 0x0D (scene definition) is STATIC across all fade/delay settings
- Format 0x0B (scene trigger) bytes 16-18 are scene revision hash, NOT fade/delay

### Trim Config (format 0x15) — RTL-SDR confirmed (2026-02-10)
- **53 bytes** (51 data + 2 CRC) — CRC OK confirmed by RTL-SDR
- Type byte = **always 0xA3** (not rotating like LED/fade)
- Byte 20 = high-end trim, byte 21 = low-end trim, encoding: `percent * 254 / 100`
- **Byte 22 = phase control**: 0x03=forward, 0x23=reverse (bit 5 = phase flag)
- Bytes 23-26 = `0B 60 00 00` (constants)
- **Bytes 27-28 = `00 FE`** (NOT CC padding! This was the lockup root cause)
- Bytes 29-50 = CC padding, bytes 51-52 = CRC
- **Sandwich types: 82 (OFF) → A3 (config) → 81 (save)** (NOT 83→A3→82!)
- Only 2 config packets: seq 0x01 on AD, seq 0x02 on AF
- Phase 3 save: high-end=0xFEFF (100%), low-end=0x0001 (min)
- Reference: `captures/trim-*.bin`, `captures/phase-{forward,reverse}.bin` (RTL-SDR)

### Phase Config (format 0x15) — RESOLVED (2026-02-13)
- Same packet structure as trim config, byte 22 encodes phase mode
- **Forward = 0x03, Reverse = 0x23** (bit 5 of byte 22 is the phase flag)
- Previous trim captures all had 0x23 because dimmer was in reverse mode
- Trim packets carry phase along — setting trim also re-sends current phase
- Pairing-time LED uses format 0x0A (broadcast, 0x81) — different from runtime 0x11

## Caseta/RA3 Bridge Pairing (RESOLVED 2026-02-06)

- **Handshake echo is CRITICAL** — bridge must echo device's exact challenge bytes
  - `type+1`, `seq+5`, `byte[5]=0xF0` (round 1 only), recalculate CRC
  - Hardcoded handshake data = guaranteed failure; device validates the echo
- **Phase 3b field order**: integ_id[0] at bytes 9-12, device_id at bytes 17-20 (opposite of later phases)
- **Zone binding level packet**: byte 21 always 0x20 (not round-dependent like integ packets)
- **Retransmissions**: 6-12 per config packet, 500ms delays between phases
- **Half-duplex handshake timing**: Maximize RX windows (5s+), minimize TX interruptions (3 packets max)
- **Arbitrary subnets work** — no subnet validity constraint; earlier failures were all handshake bugs
- **Switch vs dimmer differences**: type 0x82/0x81 for switch, 0x83/0x83 for dimmer (unpair/LED)
- Dimmer needs format 0x15 config + multiple handshake cycles (not yet implemented)

## FCJS-010 Dimmer Config

- Format 0x28 byte 9 = 0x50 (dimmer), not 0x38 (relay)
- Format 0x14 byte 22 = 0x02 (dimmer capability), not 0x00
- Format 0x13 (dimming config) required for dimmers, not sent for relays
- ON/OFF byte 19 = 0x01 for dimmer, 0x00 for relay

## Dimmer 0x0B ACK Packets (DISCOVERED 2026-02-12)

- **Dimmer sends 5-byte ACK packets (type 0x0B)** in response to bridge commands — NOT standard 24-byte CCA
- Format: `0B [seq] [response_class] [seq^0x26] [response_subtype]`
  - Byte 2 = 0x00 for set-level ACK, 0xD0 for config ACK
  - Byte 3 = byte1 XOR 0x26 (integrity check)
  - Byte 4 = 0x55 for set-level ACK, 0x85 for config ACK
- **No CRC** — uses XOR integrity check instead
- CC1101 decodes bytes 0,1,3 correctly but bytes 2,4 are XOR'd with 0xFE (systematic error)
- RTL-SDR confirmed: `0B 05 00 23 55` (correct) vs CC1101: `0B 05 FE 23 AB`
- Dimmer sends 3 ACKs at ~25ms intervals after each bridge command
- Bridge 0x81 SET_LEVEL commands decode fine on CC1101 with CRC OK
- **This explains ALL "dimmer state report" decode failures** — they were never 24-byte packets
- Reference captures: `captures/rtlsdr-set-level.bin`, `captures/rtlsdr-config.bin`

## 4-Button Pico Packet Structure (CONFIRMED 2026-02-15)

- **SCENE4 (0x08) = TOP button**, SCENE1 (0x0B) = BOTTOM on both pico types
- **Press/release flip-flop**: R/L puts command in PRESS (fmt 0x0E), scene puts it in RELEASE
- **Byte 17 (cmd_class)**: 0x40=scene/preset, 0x42=dim control
- **Byte 19 (cmd_param)**: preset ID (0x20=top, 0x21=2nd, etc.) or dim direction (0x01=raise, 0x00=lower)
- R/L ON/OFF use cmd_class=0x40 (same as scene), RAISE/LOWER use cmd_class=0x42
- R/L release format: 0x04 for on/off, 0x0C for raise/lower (dim stop)
- **Auto-detect**: fmt 0x0E on PRESS = R/L pico; fmt 0x04 on PRESS = scene pico
- See detailed comment block in `cca.yaml` above BTN_PRESS_A definition

## RTL-SDR Verification

- CC1101/ESP32 packet logs TRUNCATE packets in variable-length mode
- Always verify protocol with RTL-SDR captures of real hardware
- Decode command: `bun run tools/rtlsdr-cca-decode.ts --rate 2000000 <file.bin>`
- Capture command: `rtl_sdr -f 433602844 -s 2000000 -g 40 <output.bin>`
- Use 2 MHz sample rate (32 samples/bit) for best results
- **CC1101 variable-length mode misses packets it's not configured for** — it only captures
  packets matching its configured length/sync settings. Many packet types go unseen.
- **RTL-SDR decoder improvements (2026-02-10)**:
  - Wider threshold region (100 bits instead of 16) — burst onset transients cause
    preamble FM swings of ±1.0 but data is only ±0.08
  - Amplitude consistency check on preamble candidates — rejects burst transients
    that have >40% variation (real preambles have <10%)
  - Polarity retry — when sync/prefix extraction fails, tries opposite polarity

## Common Pitfalls

- **Type byte determines packet length**: 0x80-0x9F = 24 bytes, 0xA0+ = 53 bytes (51 data + 2 CRC)
- ALL pairing AND config packets (type A0+) must be **53 bytes** with CC padding and CRC
- **CC padding doesn't always start where you think** — some formats have data bytes past
  the "obvious" payload end (e.g. trim has `00 FE` at bytes 27-28, not CC padding)
- **Use memset(0xCC)** not memset(0x00) for packet padding
- Sequence bytes vary but don't affect basic function
- Zone ID placement varies by packet format (byte 9 for 0x28, byte 24 for 0x12)
- Format 0x28 byte 10 (`zone_id + 0x23`) is non-critical; format 0x12 byte 24 is authoritative

## Zone Encoding Problem (RESOLVED 2026-02-05)

- **Root cause**: `start_vive_pairing()` didn't accept/propagate `zone_id` - auto-accept always defaulted to 0x38
- **Fix**: Added `zone_id` param to `start_vive_pairing()`, stored as `vive_zone_id_`, passed through auto-accept
- See `docs/vive-protocol.md` for full writeup
