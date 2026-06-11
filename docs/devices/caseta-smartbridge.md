# Caseta SmartBridge

*Hardware and firmware reverse-engineering of the Caseta SmartBridge (AM335x host + STM32 CCA coprocessor).*

Reverse engineering of the older Caseta **SmartBridge** (L-BDG2 / SBP2,
device class `080E0101`; the CCA-OTA-orchestrating variant is the L-BDG2-WH,
device class `080F0101`). The SmartBridge pairs a TI AM335x application
processor running a Lutron OpenWrt-style Linux userspace with an STM32
Cortex-M coprocessor that does all 433 MHz Clear Connect Type A (CCA) radio
work. This page covers the coprocessor hardware, how its firmware is extracted
from the host updater binary, the on-air RX dispatch / host↔coproc IPC, and how
the AM335x orchestrates CCA device firmware OTA.

Three SmartBridge coproc binaries were statically reverse-engineered:
`02.05` (v02.05.00a000), `02.08` (v02.08.00f000), and `02.10` (v02.10.03a000).
Throughout, addresses are given for the `02.08` build unless noted.

## 1. Hardware

The SmartBridge STM32 coprocessor is a 32-bit ARM Cortex-M part with flash base
`0x08000000` and reset vector `0x080142B1` (T-bit set → Thumb — a normal
Cortex-M signature). The radio is a CC110L (or CC1101) driven over SPI.

The exact STM32 part (F0 / F1 / L0?) and pinout are unknown — they need a board
photo / chip markings. The extracted S19 size (~80 KB code) and the
`0x08000000` base imply a ~128 KB / 256 KB Cortex-M0 / M3. A factory bootloader
occupies `0x08000000`–`0x080030xx` (~12 KB) and is never reflashed by the
OS-level updater, so it is absent from every extracted image; recovering it
would require a chip readout or a leaked production image.

The coprocessor is essentially a **stateless RF transceiver** controlled by the
AM335x over a UART IPC link (`/dev/ttyO1`, TI AM335x serial port 1, on a
TS-7180 / Timesys "armv7l" board). All pairing intelligence, OTA orchestration,
and protocol state live in AM335x userspace — see §3 and §4.

This coprocessor **shares its platform with the RadioRA2 Select REP2 / Caseta
Pro** repeater. The two ship the same Lutron Linux stack and a closely related
(though not identical) coproc firmware image; cross-reference
[radiora2-select-rep.md](radiora2-select-rep.md). The RA2 Select REP2 is the
newer EFR32-era sibling whose coproc was used to confirm the CCA OTA wire format
that the older SmartBridge never gained (§3, §4).

`Copyright 2014 Lutron Electronics` is the only copyright string in the
`02.08` image (at flash `0x08016CE8`), suggesting a 2014-vintage codebase frozen
across all three builds.

## 2. Firmware extraction

There is **no external firmware file** on the SmartBridge rootfs — no `.s19`,
`.bin`, `.fw`, `.ldf`, or `.hex` anywhere in any of the three rootfs payloads
(02.05.00a000 / 02.08.00f000 / 02.10.03a000), no `/lib/firmware/`, and no
`fwupdate` / `mender` / `swupdate` framework. The coproc image is embedded
directly inside the host updater binary.

### Updater binary

`/usr/sbin/lutron-coproc-firmware-update-app` is a 282,932-byte ARM32 ELF
(ARMv5 EABI5, dynamically linked, stripped), linked against GLIBC 2.4 /
`GLIBCXX_3.4` / GCC 3.5 — much older than Phoenix's GLIBC 4.4 / newer GCC.
Notable strings:

- `Coprocessor Updater` — main banner.
- `Reading embedded s19` — confirms inline firmware, not an external file.
- `Lutron Coprocessor Updater - Version: 03.04.01f000` — host program version.
- `MC9S08*` MCU ID table — the same shared updater code supports HCS08 too, but
  that path is wrong for the SmartBridge (no Freescale chip present); the
  updater branches on the bootloader's protocol-version reply.
- `Example: lutron-coproc-firmware-update-app -f os.s19 /dev/ttyS1`.
- A 256-byte **substitution table at offset `0x7AA5`** (preceded by a small
  zero-pad), visible in `strings` output as garbled rows like
  `8?61$#*-pw~ylkbeHOFATSZ]`. This is the precomputed
  `((plain - 0x20 + key) % 95) + 0x20` lookup for fast encode/decode by the C++
  code.

### The three extracted images

Extracted and saved to `../../data/firmware/caseta-device/coproc-old/`:

| File | Build version | Address range | Lines |
|------|---------------|---------------|-------|
| `caseta-sb_stm32_80031E4-801FB08.s19`      | 03.03.01 (rootfs / 02.08.00f000) | 0x080031E4–0x0801FB08 | 5047 |
| `caseta-sb-0205_stm32_80030B0-801FB08.s19` | 03.03.01 (rootfs-02.05.00a000)   | 0x080030B0–0x0801FB08 | 5067 |
| `caseta-sb-0210_stm32_8003454-801FB08.s19` | 03.03.03 (rootfs-02.10.03a000)   | 0x08003454–0x0801FB08 | 5078 |

Each S19 ends with `S705 0801 42B1 FE` (Cortex-M reset start address
`0x080142B1`). Each begins directly with `S3` (32-bit address) records at flash
`0x08000000` — there is **no S0 header**. The S19 starts ~12–13 KB into flash,
confirming the factory bootloader below it (§1).

### S19 extraction pipeline

The coproc image is obfuscated with a **variant** of the same polyalphabetic
substitution cipher used by the newer Phoenix bridge. The core algorithm is
identical:

```python
decoded = ((encoded - key + 0x3F) % 95) + 0x20
key     = (key + 1) % 95
# CR/LF (0x0A, 0x0D) pass through and do NOT advance the key
```

The SmartBridge differs from Phoenix in the keystream parameters — see
[coprocessor-firmware.md](coprocessor-firmware.md) for the full Phoenix cipher
writeup:

| Property             | Phoenix        | Caseta SmartBridge   |
|----------------------|----------------|----------------------|
| Initial key (`key0`) | `0x49` (73)    | `0x29` (41)          |
| Key reset boundary   | every S0 blob  | **never** (continuous) |
| S0 header signature  | `=z}/}~`       | (none)               |
| First record type    | `S0`           | `S3` (32-bit addr)   |
| Number of blobs      | up to 10       | 1 per binary         |

The key advances **continuously** across the whole S19 stream with **no
per-record reset**. Because there is no S0 record, there is no fixed signature
to search for; the extractor brute-forces a starting offset, trying each
candidate and checking whether the first 6 decoded bytes spell a plausible
S-record prefix (`S31508`, `S20800`, `S214`, …). This always lands on the true
start within ~8 KB (observed blob starts at offsets `0x9298`–`0x995C` across
variants; ends at the `S705…FE` start-address record).

The extractor (in the private security repo) runs two paths: first the Phoenix
path (scan for `=z}/}~`, decode with `key0 = 0x49` and per-blob reset); if no
signature is found, the SmartBridge fallback `extract_continuous_blob(data,
key0=0x29)` scans for a valid S-record start and dumps until an end record
(`S7`/`S8`/`S9`) or non-S-record line. As a side benefit, the same continuous /
`key0=0x29` fallback also recovered firmware from the previously-broken
`vive-prototype` binaries (`vive-proto`, `vive-proto-007`).

### How firmware actually reaches the coproc

At boot, `/etc/init.d/S71-coproc-firmware-update` compares
`/etc/lutron.d/lutron-coproc-version` (e.g. `03.03.01`, shipped read-only with
the rootfs) against `/var/misc/coproc-version-file` (last loaded version,
persisted in flash). If they differ it invokes
`lutron-coproc-firmware-update-app -s /dev/ttyO1` **without** `-f`, so the
embedded S19 (key0=0x29 form) is the source. The updater opens UART at
`/dev/ttyO1`, speaks Lutron's BLCP-style serial bootloader protocol,
erases / programs / verifies blocks, and exits; on success the active version
file is copied to the persistent location so subsequent boots skip the upgrade.

Hence the **coproc firmware lives in the binary itself**, fetched by `opkg`
inside the `coproc-firmware-update-app` package (part of the `data.tar.gz`
payload of the rootfs `.deb` shipped from
`https://caseta.s3.amazonaws.com/<version>/`). There is no per-device-class
coproc firmware file — one `.deb` bumps every coproc image at once.
`firmwareUpgrade.sh` on this rootfs is just a wrapper around `opkg upgrade`.

## 3. Dispatch & IPC

The coproc is a **runtime-CCA-only** transceiver. The CCA on-air parameters it
shares with the newer Phoenix EFR32 coproc are: sync word `0xFADE`, CRC
polynomial `0xCA0F`, packet-length classification by type-byte high bits
(0x80 = 24-byte short, 0xA0 = 53-byte long), and the TX framing template
`55 55 55 FF FA DE` in flash. See
[../protocols/cca/index.md §3](../protocols/cca/index.md#3-packet-types) for
the runtime packet-type rules.

### Per-binary anchors

All three binaries: ARM Cortex-M, flash base `0x08000000`, reset vector
`0x080142B1`.

| Anchor | sb-0205 | sb-0208 | sb-0210 |
|--------|---------|---------|---------|
| Image start (S19 first record)             | `0x080030B0` | `0x080031E4` | `0x08003454` |
| Image end                                  | `0x0801FB08` | `0x0801FB08` | `0x0801FB08` |
| OTA framing template `55 55 55 FF FA DE`   | `0x08016980` | `0x08016980` | `0x08016DE0` |
| CC1101 register list start (44 bytes)      | `0x08016A0C` | `0x08016A0C` | `0x08016E5D`* |
| 35-channel hop table (entries 0x44..0x66)  | `0x08016A48` | `0x08016A48` | `0x08016E4D`* |
| 84-channel extended hop table (0x44..0x93) | `0x08016A48`-`0x08016AE8` | `0x08016A48`-`0x08016AE8` | `0x08016E4D`*-`0x08016EED`* |
| Sync-word (`0xFADE`) match at RX state 0   | `0x08012EE8` | `0x08012EE8` | (similar offset) |
| RX byte-state machine entry                | `0x08012C18` | `0x08012C18` | (similar offset) |
| TX framing function (xrefs OTA template)   | `0x0801306C` | `0x0801306C` | `0x080134B8`* |
| Radio scheduler (calls RX/TX state machines)| `0x0800570C`-`0x0800577E` | `0x0800570C`-`0x0800577E` | (similar offset) |
| HDLC IPC dispatch table head               | `0x0800BA84` | `0x0800BA84` | `0x0800BB80` |
| Top-level packet processor (HDLC + RF)     | `0x0800C370` | `0x0800C370` | (similar offset) |

\*0210 addresses estimated from offset deltas; verify in fresh load. The 0205
and 0208 builds are bit-identical in the address layout of these regions — only
the IPC bodies and a few tables differ.

### On-air RX state machine

The RX side is a **byte-by-byte UART/SPI input streaming machine** at
`0x08012C18` (sb-0208), called from the radio scheduler at `0x0800570C` based
on bit-21 of a peripheral status word. The state byte at `[state+0]` controls
the FSM:

| State | Behavior |
|-------|----------|
| 0 | Sliding-window FADE search. Each incoming byte `r6` is shifted into the 16-bit window `[state+0x42] = (state[0x42] << 8) \| r6`. When window equals `0xFADE`, transition to state 1. |
| 1 | Read **type byte** and classify: `r6 & 0xC0 == 0x00` → length 5 (small packet); `r6 & 0xE0 == 0xA0` → length 53 (config packet, long); otherwise → length 24 (button/level packet, short). Stash length at `[state+0x45]`, decrement counter at `[state+0x44]`, transition to state 2. |
| 2 | Streaming: write incoming byte to RX buffer at `[state+0x3C]`, increment ptr, decrement remaining counter at `[state+0x44]`. When counter hits 0, run CRC check (last 2 bytes vs computed CRC over preceding bytes) and deliver to the higher-level processor or drop. |

This is **runtime CCA framing only** — there is no path for OTA's explicit
`[LEN][OP][PAYLOAD][CRC]` framing where the length comes from the wire. The CRC
step uses a half-byte indexed lookup table (`ldrh r2, [r2, r5, lsl #1]`) with a
16-bit accumulator — standard CCA CRC-16, polynomial `0xCA0F` (the two-byte
sequence `0F CA` appears in flash adjacent to other CRC infrastructure at
sb-0208 offset `0x0800FFAB`).

### Top-level packet processor (`0x0800C370`)

After a complete packet is buffered, this function inspects the first two bytes
and routes to one of three paths:

1. **byte[1] & 0x80 != 0** → short-packet RF path (`0x0800C28C`)
2. **byte[1] & 0xC0 == 0xC0** → long-packet RF path (`0x0800C2E0`)
3. **byte[1] & 0xC0 == 0x00** → HDLC IPC dispatch (`0x0800BA84`)

The third arm is the AM335x↔STM32 IPC. The other two hand off to the runtime CCA
packet-handling cluster (`0x0800C28C`, `0x0800C2E0`, `0x0800C238`, …) which
decodes button presses, level commands, ACK responses, and config blob phases.
There is no further opcode-table dispatch — branches are open-coded against
format constants:

```text
cmp r0, #0x1C  → fade config (format 0x1C)
cmp r0, #0x0E  → OUTPUT format
cmp r0, #0x40  → level command class
cmp r0, #0x42  → dim command class
cmp r0, #0x9C  → button class
cmp r0, #0xA0..#0xA3 → rotating config types
```

Comparison hit-counts across sb-0208 (each a distinct decoder branch):

| Format/class | Hits |  | Format/class | Hits |
|--------------|------|--|--------------|------|
| `cmp r,#0x40` (level)  | 16 |  | `cmp r,#0x0B` (ACK)   | 5 |
| `cmp r,#0x80`          | 21 |  | `cmp r,#0xA0`         | 4 |
| `cmp r,#0xC0` mask     | 14 |  | `cmp r,#0x42` (dim)   | 3 |
| `cmp r,#0x0E`          | 8  |  | `cmp r,#0x1C` (fade)  | 2 |
| `cmp r,#0x0D`          | 6  |  | `cmp r,#0x15` (trim)  | 2 |
|                        |    |  | `cmp r,#0x1A` (scene) | 1 |
|                        |    |  | `cmp r,#0x11` (LED)   | 1 |

This matches the Caseta runtime CCA repertoire (output set-level, button events,
scene/fade/trim/LED config, ACK packets) but **no OTA opcodes**. Zero hits on
`0x2A`, `0x36`, `0x58`; the only `0x41` hit at `0x800FC64` is a `cmp r3, #0x41;
beq; cmp r3, #2; beq` two-way branch unrelated to TransferData; zero `0x32` hits
in code (just runtime length `0x32` literals) — confirming **OTA dispatch is
absent on the RX side**.

### TX builder (`0x0801306C`) — CCA OTA framing in TX only (dead RX path)

The single function that references the OTA framing template at `0x08016980`
is the radio TX byte-output state machine, driven by the same scheduler that
calls RX (`0x0800577A` is the only caller). It reads `state[0x46]` /
`state[0x48]` for byte counter and packet length; for the preamble/sync-word
region it indexes the template via `r3 = template + (state[0x46] - 6)`, streaming
only the first 6 bytes (`55 55 55 FF FA DE`) verbatim with subsequent bytes from
the packet buffer; for payload it reads `state[0x3C][i]`, runs it through the CRC
accumulator, and writes to the TX FIFO/SPI register, with special handling for
`0xA0` long (53-byte) and default short (24-byte) classes.

So the binary **does** know how to TX both runtime CCA packets and the OTA
preamble — but with no symmetric RX-side OTA processor, this TX path is dead
code: the bridge coproc does **not receive** OTA, and the OTA TX would only be
useful for forwarding host-built OTA packets verbatim.

### CC1101 / radio init data tables

All three binaries share the same radio data layout (only base offsets differ):

```text
0x08016A0C : register list (44 bytes)
              00 01 02 03 04 05 06 07 08 09 0a 0b 0c 10 11 12 13 14 15 16
              17 18 19 1a 1b 1c 1d 1e 1f 20 21 22 23 24 25 26 27 28 29 2a
              2b 2c 2d 2e
0x08016A38 : 8-byte FREQ-base block       2a 57 21 00 b1 63 23 67
0x08016A40 : 4-byte PA / sync extras      95 6a 0b 6d
0x08016A44 : another 4-byte block         7a 71 ad 74
0x08016A48 : extended 84-channel hop table (channels 0x44..0x93, 168 bytes)
              44 ec 45 e8 46 e4 47 dc … 92 b1 93 ad
```

The first 35 entries of the hop table (`0x44 ec` … `0x66 66`) match PowPak's
35-channel table byte-for-byte (see [powpak.md](powpak.md)). The remaining 49
entries (`0x67 5e` … `0x93 ad`) extend up to channel `0x93`; with FREQ2/1/0
interpretation this covers ~423–460 MHz at ~92 kHz spacing — a wider-than-PowPak
band, possibly used during pairing for diagnostic / test transmissions, or
vestigial calibration / spurious-emission sweep entries. The register list omits
FREQ2/1/0 (regs 0x0D–0x0F), exactly as in PowPak — band selection happens
through a separate code path.

### HDLC IPC dispatch table

Located at `0x0800BA84` (sb-0205, sb-0208) / `0x0800BB80` (sb-0210). Each entry
is a `cmp r3, #IMM` (or `movw r2, #IMM; cmp r3, r2` for ≥ 0x100) followed by a
length check (`cmp r0, #LEN`) and a `bl HANDLER`. The 16-bit big-endian command
ID is read from `[r1+0]` (after `rev16`). Handlers either return 1 directly
(stub), forward to a real implementation elsewhere in flash, or call a
"build response" pair (`0x08005E38` init buffer → `0x08005FEC` send via UART).

**Common dispatch (61 entries — present in all three versions).** Length column
= bytes the IPC framer requires, excluding the 2-byte cmd ID; "-" = no length
check.

| Cmd ID | Len | Handler  | Group / role (best guess) |
|-------:|----:|---------:|---------------------------|
| `0x0000` | -  | `0x08005880` | low-level radio control (response code 0x02) |
| `0x0002` | -  | `0x08005894` | low-level radio control (response code 0x03) |
| `0x0004` |  7 | `0x080058A8` | low-level radio control (response code 0x04) |
| `0x0006` | var| `0x08005920` | multi-record packet (`len = 3*byte[2] + 3`) |
| `0x0100` | -  | `0x08005B90` | radio status |
| `0x0103` | -  | `0x08005BA4` | radio status |
| `0x0106` |  8 | `0x08005BCC` | radio status |
| `0x0108` |  7 | `0x08005BE0` | radio status |
| `0x010A` |  6 | `0x08005BB8` | radio status |
| `0x010B` |  5 | `0x08005BF4` | radio status |
| `0x010C` | -  | `0x08005C08` | radio status |
| `0x010F` |  8 | `0x08005C1C` | radio status |
| `0x0111` |  6 | `0x08005D84` | response builder, code 0x36, 4-byte payload |
| `0x0113` |  3 | `0x08005AF8` | **stub** — returns 1, no-op |
| `0x0115` |  6 | `0x08005D98` | response builder, code 0x33, 4-byte payload |
| `0x0116` |  6 | `0x08005DAC` | response builder, code 0x34, 4-byte payload |
| `0x0119` |  7 | `0x08005DC0` | response builder, code 0x3D, 5-byte payload |
| `0x011B` |  6 | `0x08005DD4` | response builder, code 0x3E, 4-byte payload |
| `0x0200` | 25 | `0x080059A4` | TX direct packet (25-byte buffer) |
| `0x0202` | 15 | `0x08005A30` | TX direct packet (15 bytes) |
| `0x0205` | 16 | `0x08005A44` | TX direct packet (16 bytes) |
| `0x0300` | 10 | `0x0800BFE8` | likely TX or pair |
| `0x0302` |  9 | `0x08005990` | TX direct packet (9 bytes) |
| `0x0304` |  9 | `0x08005AFC` | response builder, code 0x24, 7-byte payload |
| `0x0306` | 10 | `0x0800C090` | **stub** — returns 1 |
| `0x0309` |  9 | `0x0800C098` | **stub** — returns 1 |
| `0x030B` |  8 | `0x0800C038` | reset/clear (calls 0x0800CF1C) |
| `0x0400` |  8 | `0x08005D5C` | response builder, code 0x4F, 6-byte payload |
| `0x0404` | -  | `0x08005D70` | response builder |
| `0x0501` | 11 | `0x080059B8` | TX direct packet (11 bytes) |
| `0x0503` | 11 | `0x080059CC` | TX direct packet (11 bytes) |
| `0x0505` |  9 | `0x080059E0` | TX direct packet (9 bytes) |
| `0x0507` |  9 | `0x080059F4` | TX direct packet (9 bytes) |
| `0x0509` | 14 | `0x08005A08` | TX direct packet (14 bytes) |
| `0x050B` |  9 | `0x08005A58` | TX direct packet (9 bytes) |
| `0x050D` | 11 | `0x08005A6C` | TX direct packet (11 bytes) |
| `0x050F` | 14 | `0x08005A1C` | TX direct packet (14 bytes) |
| `0x0511` | 10 | `0x08005A80` | TX direct packet (10 bytes) |
| `0x0513` | 10 | `0x08005A94` | TX direct packet (10 bytes) |
| `0x0518` |  8 | `0x08005AA8` | TX direct packet (8 bytes) |
| `0x051C` |  5 | `0x08005ABC` | TX direct packet (5 bytes) |
| `0x051D` | 21 | `0x08005AD0` | TX direct packet (21 bytes) |
| `0x051E` |  8 | `0x08005AE4` | TX direct packet (8 bytes) |
| `0x0600` |  7 | `0x08005C30` | radio config |
| `0x0602` | -  | `0x08005C44` | radio config |
| `0x0604` |  9 | `0x08005C58` | radio config |
| `0x0606` | 14 | `0x08005C6C` | radio config |
| `0x0608` | 14 | `0x08005C80` | radio config |
| `0x060A` | 15 | `0x08005C94` | radio config |
| `0x060C` | 15 | `0x08005CA8` | radio config |
| `0x060E` | 15 | `0x08005CBC` | radio config |
| `0x0610` | 13 | `0x08005CD0` | radio config |
| `0x0612` | 13 | `0x08005CE4` | radio config |
| `0x0614` | 14 | `0x08005CF8` | radio config |
| `0x0700` | 32 | `0x08005D0C` | scene/programming (32-byte payload) |
| `0x0702` | 32 | `0x08005D20` | scene/programming (32-byte payload) |
| `0x0707` | 60 | `0x08005D34` | scene/programming (60-byte payload, response code 0x38) |
| `0x0709` | 60 | `0x08005D48` | scene/programming (60-byte payload, response code 0x36) |
| `0xE100` | -  | `0x08005B64` | async event (upstream notification) |
| `0xE101` | -  | `0x08005B7C` | async event |
| `0xE203` | -  | `0x080058BC` | async event (response code 0x5E) |
| `0xE205` | -  | `0x080058D0` | async event (response code 0x5F) |
| `0xE207` | -  | `0x080058E4` | async event |
| `0xE209` |  6 | `0x080058F8` | async event |
| `0xE20B` | -  | `0x0800590C` | async event |

The `0xE1xx` / `0xE2xx` block is the upstream-notification range — handlers are
typically called from runtime code (button received, level changed) rather than
from inbound IPC, but they still pass through this dispatch with the `E1`/`E2`
prefix to distinguish event direction.

**v02.10-only additions (6 new entries):**

| Cmd ID | Len | Handler | Likely role |
|-------:|----:|---------|-------------|
| `0x011D` |  6 | `0x08005E08` → `0x0800840C` | reads 4 bytes BE, calls 0x0800CB3C with arg2=0 |
| `0x011F` |  6 | `0x08005E10` → `0x0800841C` | reads 4 bytes BE, calls 0x0800CB5C with arg2=4 |
| `0x0800` | 13 | `0x08005E18` → `0x0800842C` → `0x0800D0F8` | builds response with code `0x0801` |
| `0x0802` | 13 | `0x08005E20` → `0x08008438` → `0x0800D114` | builds response with code `0x0803` |
| `0x0900` | 11 | `0x08005E28` → `0x08008444` → `0x0800D130` | builds response with code `0x0901` |
| `0x0902` | 11 | `0x08005E30` → `0x08008450` → `0x0800D14C` | builds response with code `0x0903` |

The four `0x08xx` / `0x09xx` cmds use a request/response numbering pattern
(`req=0x0800` ↔ `rsp=0x0801`) and forward into a separate function group that
reads a single byte argument and builds a 1-byte response — typical of
**feature-flag toggles** added in firmware revisions (Smart Bridge Pro 2 telnet
integration enable/disable, rolling-code re-key, new device-type acceptance
flags, or diagnostics on/off). The `0x011D` / `0x011F` pair takes a 4-byte BE
argument and dispatches into `0x0800CB3C` / `0x0800CB5C` — likely
reading/writing a new 32-bit configuration register or device-class field.

### Comparison vs Phoenix EFR32 (HDLC IPC chain)

| Aspect | Caseta SmartBridge (older STM32) | Phoenix EFR32 (newer) |
|--------|----------------------------------|------------------------|
| Radio chip                    | CC110L (or CC1101)              | EFR32MG12 integrated radio |
| Sync word                     | `0xFADE`                        | `0xFADE` |
| Preamble + sync template      | `55 55 55 FF FA DE` @ `0x08016980` | same template @ `0x08018A8C` |
| CRC polynomial                | `0xCA0F`                        | `0xCA0F` |
| Channel hop table size        | **84 channels** (0x44..0x93)    | 35 channels (0x44..0x66) |
| First 35 hop entries          | Match PowPak byte-for-byte      | Match PowPak byte-for-byte |
| CC1101-style register list    | 44 entries (omitting FREQ regs) | n/a (different radio) |
| RX state machine              | At `0x08012C18` (FADE-window FSM) | HDLC + radio dispatch fan-out |
| RX byte classification        | Type-byte high bits → length    | Type-byte high bits → length |
| OTA opcode dispatch           | **Absent**                      | Full 10-opcode table |
| OTA framing TX                | Template referenced once (TX builder, dead) | Active TX path |
| HDLC IPC cmd ID width          | 16-bit big-endian @ byte 0      | 16-bit big-endian @ byte 0 |
| HDLC IPC entry count           | 61 (v02.05 / v02.08), 67 (v02.10) | ~30 in mapping |
| HDLC IPC numbering            | 0x0000-0x07xx + 0xE1xx/0xE2xx   | 0x111-0x12B (OTA) + others |
| Cmds 0x0111-0x011F            | Stubs / 4-byte response builders | Real OTA opcodes (Query/Begin/Transfer/Control/CodeRev) |
| Cloud System-Monitor OTA target? | No (no OTA dispatch in firmware) | Yes — full OTA path |

The shared `0xFADE` / `0xCA0F` / register list / preamble / first-35-channel hop
table establish that the on-air format is **the same Lutron CCA protocol across
both generations** — the older STM32 SmartBridge predates the EFR32-era OTA
opcode set but speaks the same wire framing for runtime button/level/scene
traffic. Crucially, the Phoenix OTA-style opcodes (`0x2A` BeginTransfer, `0x32`
Control, `0x36` CodeRevision, `0x41` TransferData, `0x58` QueryDevice, …) and the
OTA HDLC IPC command IDs (`0x0121` ClearError, `0x0125`, `0x0127`, `0x0129`,
`0x012B`) are **absent** from the SmartBridge — cmds `0x0111`-`0x011B` exist but
with mismatched lengths and stub / response-builder handlers, no CCA OTA
semantics. No version in the `02.05` → `02.10` lifecycle ever introduced a
Phoenix-style OTA opcode, so the older Caseta SmartBridge **never gained CCA OTA
capability**.

### Pairing / handshake

The Caseta SmartBridge does **not** use the modern Sunnata-era smart pairing
protocol (handshake echo, integration ID exchange, multi-phase config). Pairing
is driven entirely from the AM335x main proc via the IPC dispatch:

1. AM335x sends an IPC command (one of `0x05xx` / `0x06xx`) telling the coproc to
   TX a specific config or button packet. The handler at `0x080059xx` /
   `0x08005Cxx` packages the body bytes into a runtime CCA frame and queues it
   for the radio scheduler.
2. Coproc TXes the packet on the next scheduling slot.
3. When the device responds (button-press ACK, config ACK), the RX state machine
   buffers it, the top-level processor runs it through the format classifier, and
   an `0xE1xx` / `0xE2xx` notification fires upstream.
4. Main proc orchestrates retries, multi-phase config, integration-ID assignment.

So **all pairing intelligence lives in AM335x userspace** (`lutron-coproc-*`
processes) — the opposite of Phoenix's smart-pairing era where the coproc tracks
pairing state internally. There is no Sunnata-style smart-pairing handshake echo
in the STM32 binary: no integration-ID field-extraction, no responder-state
machine, just type-byte classification and pass-up.

### Version evolution (v02.05 → v02.08 → v02.10)

| Aspect | v02.05 | v02.08 | v02.10 |
|--------|--------|--------|--------|
| Image size (KB)              | 114.6   | 114.3   | 113.7 |
| IPC entry count              | 61      | 61      | 67 |
| OTA template offset          | 0x16980 | 0x16980 | 0x16DE0 (+0x460 shift) |
| New IPC commands             | —       | —       | 0x011D, 0x011F, 0x0800, 0x0802, 0x0900, 0x0902 |
| Bit-identical with previous? | n/a     | YES (dispatch / radio layout) | NO (new commands, code shifted) |

**v02.05 vs v02.08**: identical IPC dispatch table and radio data layout; only
handler bodies differ (a 0x134-byte shift in pool addresses; extracted images
differ by 308 bytes total) — a maintenance bump without protocol changes.

**v02.08 vs v02.10**: meaningful expansion. The dispatch table head moved
`0x0800BA84` → `0x0800BB80` (+0x100) and the radio data tables shifted +0x460,
both from code growth, not protocol redesign. The six new commands form two
unrelated feature groups (the `0x011D`/`0x011F` 4-byte-arg pair and the
`0x0800`/`0x0802`/`0x0900`/`0x0902` 1-byte set/get feature-flag pattern). None
maps to the Phoenix OTA dispatch.

## 4. CCA OTA orchestration

Although the SmartBridge coproc has no OTA receive path, the AM335x bridge **does**
orchestrate CCA device firmware OTA over 433 MHz for the EFR32-era variants. The
on-air wire format was RE'd from the Phoenix EFR32 coproc and confirmed identical
across the Caseta Pro / RA2 Select REP2 EFR32 image; see
[../protocols/cca/ota.md](../protocols/cca/ota.md) for the full on-air wire
format, channel parameters, and the 2026-04-28 live OTA capture against a rooted
Caseta Pro REP2 + DVRF-6L.

### Architecture

```
SSH / LEAP API
      │
      ▼
trigger_firmware_upgrade.sh  ──► firmwareUpgrade.sh ──► curlscript.sh
                                       │                  (firmwareupdates.lutron.com)
                                       ▼
                       platform_manager_wrapper.sh -p
                                       │ JSON IPC over UNIX socket
                                       │  (PlatformManagerSocketPath in lutron.conf)
                                       │  via /usr/sbin/lutron-core-client
                                       ▼
                                 lutron-core
                                       │
                          ┌────────────┼─────────────┐
                          ▼            ▼             ▼
                  device_firmware_   device-firmware-  cca-firmware-update-
                  download.sh        manifest.json     link-command-router
                  (opkg over HTTPS)                            │ 8 IPC core commands
                          │                                   ▼
                          ▼                            coproc (STM32, /dev/ttyO1)
                /tmp/device_firmware/                         │ 433 MHz CCA RF
                lutron_device_firmware                        ▼
                                                     CCA device (Diva, plug-in,
                                                       Maestro, fan ctrl, ...)
```

### Trigger

The cleanest one-liner from SSH on the bridge that orchestrates the whole flow:

```sh
/usr/sbin/platform_manager_wrapper.sh -p
```

This sends the following JSON over `PlatformManagerSocketPath`:

```json
{
  "cmd": "RequestDownloadDeviceFirmwarePackage",
  "args": { "RequestId": "pm-wrapper", "Guid": "cloud-mode", "AutoInstall": true }
}
```

`AutoInstall: true` means: download the bundle from the cloud URL stored at
`/tmp/platform_manager/tmp/device_firmware_repo_url`, then immediately push it to
all eligible devices over the air.

**Naming caveat — not a bridge rootfs update.** The shell variable holding the
message is named `PEGASUS_DEVICE_FW_DOWNLOAD_IPC_MESSAGE_WITH_AUTOINSTALL` —
"Pegasus" is the CCX/Thread codename, which would suggest a CCX-only path. It
isn't: the JSON `cmd` is just `RequestDownloadDeviceFirmwarePackage`, and on
Caseta the manifest it consumes is exclusively CCA (`TargetLocationName: "CCA"`
for all 15 entries). The "Pegasus" prefix is leftover Phoenix nomenclature where
CCX dominates; on Caseta with no CCX devices, every dispatch routes to the
`CCA_FIRMWARE_UPDATE_*` state machine.

Processor-firmware (bridge rootfs) updates use entirely separate flags and IPC
commands and never overlap with `-p`:

| Concern | Processor / rootfs | Device / CCA |
|---|---|---|
| Wrapper flag | `-d` / `-a` / `-i` | `-p` |
| IPC `cmd` | `RequestDownloadProcessorFirmware`, `RequestInitiateProcessorFirmwareInstall` | `RequestDownloadDeviceFirmwarePackage` |
| Bundle type | `.deb` (rootfs) | `.pff` (per-device) |
| opkg config | `/etc/opkg.conf` | `/etc/opkg_device-firmware.conf` |
| Destination | UBI partition + EEPROM flag flip + reboot | `/tmp/device_firmware/`, no reboot |

**Cloud-vs-on-device gating / bypass.** To run repeatable captures or when the
cloud reports no update, pre-stage a known-good bundle at
`/tmp/device_firmware/lutron_device_firmware` and mutate a target device's
`RequiresFirmwareUpdate` flag in `/var/db/lutron-runtime-db-default.sqlite`
(queried via `SELECT … FROM Device JOIN LinkNode … WHERE LinkID = ?`).

Other related entrypoints:

- `trigger_firmware_upgrade.sh -t cron_job` — full check/update cycle (slow).
- `lutron-coproc-firmware-update-app -s /dev/ttyO1 -f <s19>` — the bridge's own
  coproc firmware update over serial. **Not** CCA device OTA.
- `coproc_firmware_updater.pyc --system-type=rockhopper` — boot-time coproc
  updater wrapper. Same scope as above.

Auto-trigger paths fire inside `lutron-core` without external IPC (useful so you
don't mistake them for test-induced traffic):

- `CLAP_LINK_MANAGER_STARTED_STATE.triggerFirmwareUpdate(bool)` — fires when a
  link starts and the coproc reports a link type that doesn't match the device
  class's expected coproc image type, or when the device class has multiple valid
  link types (repair path).
- `ScheduledDeviceFirmwareUpdateTimeoutSeconds` — periodic timer; queries
  `DevicesRequiringFirmwareUpdate` and runs sessions per link.
- `CCXDeviceFirmwareUpdate` config node has a "Downgrade Enabled" feature flag —
  name suggests CCX-only but logic appears unified across CCA/CCX.

### OTA core command vocabulary (IPC)

`lutron-core` exposes eight CCA OTA core commands (from
`cca-firmware-update-link-command-router.cpp`, recovered as C++ symbols from the
stripped binary). Each maps to a coproc IPC message that the coproc translates
into one or more CCA RF packets:

| Phase | Core command (IPC) | Response |
|---|---|---|
| 0 | `RequestFirmwareUpdateResetDevice` | `FirmwareUpdateResetDeviceResponse` |
| 1 | `RequestFirmwareUpdateQueryDevice` | `FirmwareUpdateQueryDeviceSuccessResponse` / `FailureResponse` |
| 2 | `RequestFirmwareUpdateBeginTransfer` | `FirmwareUpdateBeginTransferResponse` |
| 3 | `RequestFirmwareUpdateChangeAddressOffset` | `FirmwareUpdateChangeAddressOffsetResponse` |
| 4 | `RequestFirmwareUpdateTransferData` (loop) | `FirmwareUpdateTransferDataResponse` |
| 5 | `RequestFirmwareUpdateEndTransfer` | `FirmwareUpdateEndTransferResponse` |
| 6 | `RequestFirmwareUpdateCodeRevision` | `FirmwareUpdateCodeRevisionResponse` / `ReportCodeRevision` |
| - | `RequestFirmwareUpdateClearError` (recovery) | `FirmwareUpdateClearErrorResponse` |

Phase 4 (`TransferData`) is the bulk of the session — repeated until the entire
`.pff` payload is shipped, with `ChangeAddressOffset` interleaved as the cursor
advances. The IPC phase → on-air opcode → HDLC cmd-ID mapping (RE'd from the
Phoenix EFR32 coproc) is documented in
[../protocols/cca/ota.md](../protocols/cca/ota.md); summarized:

| Phase | Opcode | HDLC cmd ID |
|-------|--------|-------------|
| ResetDevice | `0x32` (Control) | `0x11D` |
| QueryDevice | `0x58` | `0x111` |
| BeginTransfer | `0x2A` | `0x113` |
| ChangeAddressOffset | `0x32` (Control) | `0x119` |
| TransferData | `0x41` | `0x115` |
| EndTransfer | `0x32` (Control) | `0x11B` |
| CodeRevision | `0x36` | `0x11F` |
| ClearError | `0x3A` | `0x121` |

Static-RE'd raw-bit framing was later reclassified as host↔coproc IPC, not
on-air. The actual on-air format uses runtime CCA framing with `06 nn` body
sub-opcodes (`06 00` BeginTransfer, `06 01` ChangeAddressOffset, `06 02`
TransferData, `06 03` device-poll); EndTransfer / ResetDevice / CodeRevision /
QueryDevice have no on-air representation — the bridge stops sending and the
device commits autonomously. Ghidra hit-counts for OTA constants (`21 2b`, `21
0e`, `21 0c`, `21 08`, `06 00`, `06 01`, `06 02`) are **identical** across
`phoenix_efr32_*.bin`, `caseta-ra2sel_efr32_*.bin`, and `lite-heron_efr32_*.bin`,
confirming a unified codebase across RA3 / Caseta Pro / lite-heron bridge
variants.

### Firmware manifest

`/opt/lutron/device_firmware/device-firmware-manifest.json` (plaintext, 15
entries in v08.25.17f000):

```json
{
  "FirmwarePackageVersion": "001.003.004r000",
  "DeviceFirmwareList": [
    {
      "DeviceClass": "0x03150201",
      "App": {
        "Path": "firmware/07911258_BASENJI_APP_RELEASE_v2.025.pff",
        "TargetLocation": 0,
        "TargetLocationName": "CCA",
        "ImageType": 1,
        "Sha256Hash": "C15FD086…",
        "DisplayRevision": "002.025.000r000",
        "Revision": { "Major": 2, "Minor": 25, "Patch": 0, "Label": 128 },
        "MinimumRevisions": [],
        "EstimatedFastUploadTimeInSeconds": 1200
      }
    }
  ]
}
```

Codename → device-class map (15 classes covered):

| Codename | Device classes | Files | MCU |
|---|---|---|---|
| BASENJI (Diva, e.g. DVRF-6L) | `0x03150101/0201`, `0x03160101/0201` | v2.015 + v2.025 | **EFR32FG23** (Cortex-M33, Secure Vault Mid) |
| BANANAQUIT (plug-in / Maestro family) | `0x03090601`, `0x030A0601`, `0x03130601`, `0x03140601` | v2.025 | TBD (likely EFR32) |
| EO / eagle-owl | `0x03120101/0102/0103` | v2.025 | TBD (likely EFR32) |
| Vogelkop (high-end dimmer) | `0x04630201`, `0x04640101`, `0x04660201` | v3.012 + v3.021 | TBD |
| Antillean | (in firmware list, class TBD) | v1.001 | TBD |
| Caseta Dimmer (legacy) | `0x04320501` | v2.05 | TBD (likely HCS08 — pre-EFR32 era) |

`EstimatedFastUploadTimeInSeconds: 1200` ⇒ **~20 min of RF per device** — plan
capture buffer / streaming accordingly. `MinimumRevisions` is empty for all
current Caseta entries; on Phoenix it gates app upgrades on boot version and may
trigger boot-image transfer in future bundles.

The BASENJI **EFR32FG23** is xG2x (Cortex-M33 + Secure Vault Mid, AAP
token-based unlock, Secure Boot RTSL, OTP key storage); older xG1/xG12/xG14
(Cortex-M4) glitch attacks do not apply directly. Secure Boot and debug-lock on
FG23 are configurable, so empirically check what Lutron actually enabled before
assuming worst case.

### .pff format (Pegasus Firmware Format)

Same container as CCX device firmware (see
[coprocessor-firmware.md](coprocessor-firmware.md) for the verified layout):
4-byte BE Major (0=boot, 1=app), 4-byte BE Minor, 64-byte unique field (likely
ECDSA-P256 signature), 195 reserved zero bytes, then AES ciphertext at offset
`0x10B`. The bridge does **not** decrypt — it ships the `.pff` bytes unmodified
to the device bootloader, which decrypts in place. The Caseta manifest ships only
App images (format 1, 100–900 KB); boot images (format 0, ~20 KB) would require
physical access. The PFF symmetric key is burned in the device bootloader at
manufacture; recovering it likely needs SWD/JTAG on a CCA device. (PowPak HCS08
LDFs are plaintext — only EFR32 PFFs are encrypted; see [powpak.md](powpak.md).)

### SSH paths reference

| Path | Role |
|------|------|
| `/usr/sbin/platform_manager_wrapper.sh -p` | trigger device OTA (CCA) |
| `/usr/sbin/lutron-core-client` | sends JSON IPC over `PlatformManagerSocketPath` |
| `/tmp/platform_manager/tmp/device_firmware_repo_url` | cloud bundle URL |
| `/tmp/device_firmware/lutron_device_firmware` | staged bundle (bypass cloud) |
| `/var/db/lutron-runtime-db-default.sqlite` | device records / `RequiresFirmwareUpdate` flag |
| `/opt/lutron/device_firmware/device-firmware-manifest.json` | firmware manifest |
| `/etc/opkg_device-firmware.conf` | device-firmware opkg config |
| `trigger_firmware_upgrade.sh -t cron_job` | full check/update cycle |

To watch a session: `tail -F /var/log/messages | grep -E "firmware-update|cca|coproc"`.

### Cross-system applicability

- **Wire protocol** (433 MHz packet format) is almost certainly shared across host
  systems — same device-side radio chip family, and Phoenix uses the same
  `cca-firmware-update-*` C++ class names per the coprocessor RE.
- **Orchestration** is host-specific: Phoenix (RA3/HW) uses the same IPC names via
  a different platform-manager binary; ESN (RMJ) is unconfirmed and may not
  support OTA at all (see [esn.md](esn.md)); the Vive hub (RMJS) is unconfirmed
  and has its own `lutron-core` variant.
- For RMJ→LMJ "conversion attacks", the host system that owns the device must run
  the orchestrator; captured Caseta wire packets could let us craft equivalent RF
  directly from a controllable transmitter (openBridge), given a recovered/forged
  per-device-model PFF key. See the conversion-attack notes (maintained outside
  this repo).

## 5. Method / reproducibility

S19 → flat `.bin` via an S-record parser (start at the lowest address per file),
loaded into a fresh Ghidra project with `BinaryLoader` + `-loader-baseAddr
<per-binary>`. Disassembly via `arm-none-eabi-objdump -D -b binary -m arm -M
force-thumb --adjust-vma=<base>`. Dispatch tables extracted by walking
`cmp/movw + bne + bl HANDLER` patterns in the IPC dispatch region; anchors
confirmed by inspecting raw bytes and cross-checking the disassembly; RX state
machine semantics derived from the ARM/Thumb decompilation around `0x08012EE8`
(FADE compare). The OTA HDLC opcode table is defined in
[`../../protocol/cca.protocol.ts`](../../protocol/cca.protocol.ts).

## 6. Open questions / next steps

- Confirm v02.10 cmds `0x0800/0x0802/0x0900/0x0902` semantics by decompiling
  `0x0800D0F8` / `0x0800D114` / `0x0800D130` / `0x0800D14C`; they likely set
  persistent flags in a config block.
- Determine the 84-channel hop table's role: actually used, or dead code from a
  wider-band variant? A live RTL-SDR sweep above 433 MHz during pairing could
  answer this.
- Decompile `0x08005920` to confirm the `0x0006` IPC command's `len = 3*byte[2] +
  3` carries a list of 3-byte `(channel, freq_hi, freq_lo)` records for custom hop
  schedules.
- Check whether any IPC command lets the host push raw bytes through the OTA
  template TX path — a "transmit OTA opcode N from host" primitive even without
  on-device dispatch.
- Cross-check `0xE1xx`/`0xE2xx` event handlers against incoming runtime CCA packet
  types (button press, ACK, config ACK).
- Resolve the body-byte sub-opcode discriminating the three `0x32` Control phases
  (ChangeAddressOffset / EndTransfer / ResetDevice) from the captured IQ; segment
  by inter-packet gaps and match to log timestamps.
- The Caseta Pro coproc EFR32 image has not been extracted yet (only the old
  SmartBridge STM32 blobs); extracting it would close the last gap between the
  static RE and the live-capture confirmation.
- Recover the bootloader region (`0x08000000`–`0x080030xx`, ~12 KB) via chip
  readout — it is in no extracted S19.
- Identify the exact STM32 part (F0/F1/L0) from board markings.
