# CCA OTA — live capture findings (2026-04-28)

First successful end-to-end live capture of a CCA firmware OTA, run against a
rooted Caseta Pro / RA2 Select REP2 bridge with a paired DVRF-6L dimmer
(Vogelkop family, DeviceClass `0x04630201`, factory firmware `003.021`).

This page documents what the static RE got right, what it got wrong, and the
force-trigger procedure that bypasses the cloud-side gating.

## TL;DR

- **OTA is single-channel, ~433.566 MHz, ~80 kHz BW** — NOT the 35-channel hop
  the static-RE'd PowPak hop table (`docs/firmware-re/powpak.md`) suggested.
  That hop table is something else (calibration LUT, retry channels, or unrelated).
- **Center frequency offset 36 kHz below runtime CCA** (`433.602844 MHz`),
  consistent with the `MDMCFG3=0x3B` 30.49 kbps GFSK modem config (different
  MCSM gating from runtime).
- **Wire framing matches static RE** — preamble, sync `FA DE`, length-prefixed
  `[LEN][OP][BODY][CRC16]`. Confirmed by visible packet bursts in the capture
  spectrogram. Per-opcode body decoding awaits a working GFSK demod.
- **The cloud check (`firmwareUpgrade.sh`) is a dead end** for force-triggering.
  The Lutron app's "Check for firmware updates" button bypasses cloud entirely
  and goes straight to `leap-server`'s `devicefwu` module.

## Spectrogram evidence

5-second window during the active TransferData phase (~100 s into the
recording), 2.56 MHz capture bandwidth centered on `433.602844 MHz`:

![5s zoom spectrogram](figures/cca-ota/zoom-5s.png)

Vertical bursts at a single ~80 kHz-wide band centered slightly below the
runtime CCA channel. No frequency hopping visible.

Average PSD over the same window:

![Average PSD](figures/cca-ota/avgfft.png)

Single dominant peak at **433.5663 MHz** (-36 kHz from runtime CCA center).
Energy span across the 99.5th percentile bins: **433.5594 MHz to 433.6388 MHz**
(~80 kHz wide). If this were a 35-channel hop at ~92 kHz spacing, we'd see
~3.2 MHz of total span and 35 distinct peaks; we see one.

## Force-trigger procedure (rooted Caseta Pro REP2)

The bridge will only push an OTA when its `leap-server`'s `devicefwu` module
decides "this device's running version is older than the manifest version."
That decision uses leap-server's in-memory device-firmware cache, which is
seeded from `Device.FirmwareRevision` in the runtime DB at leap-server start.

### Step 1 — apply DB spoofs

The runtime DB at `/var/db/lutron-db.sqlite`:

- `Device.ActionRequiredID` is constrained to `(0, 6, 8)` by a CHECK constraint —
  cannot directly set `9` ("Device Firmware Update Required"). Spoofing only
  `FirmwareRevision` is sufficient for leap-server's eligibility check, but
  `LinkNodeAssociations.ActionRequiredID = 9` provides belt-and-suspenders for
  any other consumer of the `GetDeviceSerialNumbersRequiringNonComponentConfiguration`
  view.

```sh
sqlite3 /var/db/lutron-db.sqlite "
  UPDATE Device
    SET FirmwareRevision = '003.020'
    WHERE SerialNumber = 117342240;
  UPDATE LinkNodeAssociations
    SET ActionRequiredID = 9
    WHERE LinkNodeAssociationsID = 4;
"
```

`SerialNumber` is the device's factory serial (decimal). `LinkNodeAssociationsID`
is the row joining your device's `LinkNode` to the bridge's; one query to
confirm it before applying:

```sh
sqlite3 -header /var/db/lutron-db.sqlite "
  SELECT LinkNodeAssociationsID, SrcLinkNodeID, DestLinkNodeID, ActionRequiredID
    FROM LinkNodeAssociations
    WHERE DestLinkNodeID IN (
      SELECT LinkNodeID FROM LinkNode WHERE DeviceID = (
        SELECT DeviceID FROM Device WHERE SerialNumber = 117342240
      )
    );
"
```

### Step 2 — bounce leap-server

leap-server caches the `Device.FirmwareRevision` value in memory at startup.
Without a bounce, the spoof has no effect.

```sh
/etc/init.d/K26-leap-server restart
```

(`S74-leap-server` is the start-side symlink; `K26-leap-server` is the same
script and supports `start|stop|restart`.)

### Step 3 — trigger from the Lutron app

Tap **Check for firmware updates** in the app. This sends a LEAP message to
`leap-server` which:

1. Re-parses the manifest at `/opt/lutron/device_firmware/device-firmware-manifest.json`
2. Runs `Plinko` against its in-memory device cache
3. If any device's cached `FirmwareRevision` is below the manifest version for
   its `DeviceClass`, fires `devicefwu: Starting update of N device(s)`
4. lutron-core picks up the IPC and starts the per-device CCA OTA via the
   coproc

We never figured out how to trigger this without the app — the periodic timer
(`ScheduledDeviceFirmwareUpdateTimeoutSeconds`, daily-ish) is too slow to be
practical, and the lower-level `RequestStartFirmwareAutoApply` IPC isn't
socket-callable from outside (returns `No command parser registered`).

### Observed log timeline (DVRF-6L, Vogelkop `003.021`)

```
21:04:37 leap-server: devicefw: Package cache stale, attempting to parse package version
21:04:37 leap-server: devicefw: Package cache parse succeeded
                      (initial app-connect plinko: "no changes required" — cache not yet refreshed)
21:04:41…21:04:53 lutron-core: Goto level: ... ObjectUid={2, 0x000F}
                      (visible "preparing" feedback driving the dimmer up/down)
21:05:16 leap-server: devicefwu: Starting update of 1 device(s)
21:05:16 leap-server: devicefwu: Starting update of device with serial 117342240
                      (≈40 s after the button tap — the Plinko re-fire that read our spoof)
21:06:08 lutron-core: Coproc Health Statistics: UI Queue data high water mark 2.35% → 3.92%
                      (sole evidence of OTA traffic in lutron-core logs — no per-phase logging)
21:24:03 lutron-core: Initializing device records after firmware update for Serial=0x06FE8020
21:24:03 lutron-core: data-transfer-receiver: Data transfer complete
21:24:05 leap-server: devicefwu: Successfully updated SerialNumber 117342240
                      to CodeRevision: 003.021 and PartNumber: 0790116
21:24:05 leap-server: devicefwu: All devices have finished updating
```

Total OTA: **18 minutes 49 seconds** (start to "Data transfer complete"),
within the manifest's `EstimatedFastUploadTimeInSeconds: 1200` envelope.

### Step 4 — cleanup

```sh
sqlite3 /var/db/lutron-db.sqlite "
  UPDATE LinkNodeAssociations
    SET ActionRequiredID = 0
    WHERE LinkNodeAssociationsID = 4;
"
```

After successful OTA, lutron-core auto-overwrites `Device.FirmwareRevision`
back to the device's actual reported value (`003.021`), so that field is
self-cleaning.

## What lutron-core does not log

The OTA we captured ran for 19 minutes with **only two firmware-related
lutron-core log entries** (`Initializing device records after firmware update`
and `data-transfer-receiver: Data transfer complete`, both at the very end).
The per-phase IPCs (`RequestFirmwareUpdateQueryDevice`, `BeginTransfer`,
`ChangeAddressOffset`, `TransferData`×N, `EndTransfer`, `CodeRevision`,
`ResetDevice`) are not surfaced at the default log level. The coproc UI Queue
high-water-mark bump (2.35% → 3.92% → back) is the only proxy signal for OTA
traffic in the logs.

This means an empirical **per-phase-byte correlation must come from the RF
capture, not the log**. The log gives us start/end timestamps; everything
between is in the IQ stream.

## Demod progress + correction to the static-RE data rate

`lib/cca-ota-demod.ts` (committed in this PR) implements the DSP primitives:

- `complexFromUint8` / `uint8FromComplex` — rtl_sdr file ↔ complex IQ
- `mix` — frequency shift (used to bring the −36 kHz carrier to DC)
- `instantaneousFrequency` — phase-difference discriminator
- `synthesizeFsk` — bits → IQ (CPFSK, for round-trip testing)
- `demodulateFsk` — IQ → bits (matched filter over middle 50% of each bit)

**13 demod tests pass** including a full end-to-end synth → demod → codec
round-trip for the four primary OTA opcodes (0x2A / 0x32 / 0x41 / 0x58),
proving the framing and the codec layer agree on synthesized signals.

**Critical empirical correction** (revises [`docs/protocols/cca.md` §9.2](../protocols/cca.md#92-modem-config-cc1101)):

> **Data rate is ~62.5 kbps, NOT 30.49 kbps** as the static-RE register
> decode in [powpak.md](powpak.md) claimed.

Measurement: peak-to-peak in a 1010-preamble alternating pattern on the live
capture is ~31 µs (= 2 bit periods), giving a bit rate of ~64 kHz. Closer to
runtime CCA's 62.5 kbps than to the doc's 30.49 kbps. Either the register
formula was misapplied or the OTA reuses runtime CCA's bit clock — the
demod uses the empirical rate.

**Other empirical numbers:**
- Deviation: 10/90 percentiles of instantaneous frequency on a real burst land
  at ±48 kHz, consistent with ~38 kHz CC1101-spec deviation (DEVIATN=0x44 →
  ~38 kHz, not 32 kHz as some doc rows claimed) plus transition smear.
- Burst structure: ~2.1 ms bursts every ~25 ms during TransferData
  (~40 packets/sec, well within the 250-packets/sec ceiling implied by the
  manifest's 1200 s budget for ~200 kB of payload).

## Symbol synchronization shipped — but real-capture still doesn't decode as raw-bit FA DE

`lib/cca-ota-demod.ts` now has the full bit-clock recovery toolkit (PR #40
follow-up):

- **`recoverBitPhase`** — sub-sample correlation of a ±1 alternating square
  wave against the freq array to find the bit phase from the preamble.
- **`demodulateFskWithSync`** — `demodulateFsk` plus phase recovery and
  median-DC slicing threshold (per-burst carrier offset).
- **`findSyncOffset`** — sliding zero-mean cross-correlation of an arbitrary
  bit pattern against the freq array. Anchors decoding on a transition-rich
  word (FA DE) so bit-clock drift through the 8-bit `0xFF` sync delimiter is
  bypassed.
- **`demodulateFskFromSample`** — slice bits from a known sample anchor with
  a fixed bit clock.
- **`findPatternOffsets`** — brute-force scan of every sample offset, demods
  the candidate's bits, returns offsets where the bits match a target pattern
  within a Hamming distance. Stricter than correlation (rejects partial-match
  preamble peaks).

**All 20 demod tests pass** including a regression for the 1-bit drift through
the 8-bit `0xFF` sync delimiter (the originally-suspected blocker).

## Real-capture finding: on-air OTA is not raw-bit, it's N81-framed runtime CCA

After the symbol-sync work landed, the real capture still produced 0 OTA
packets via `extractPacketsFromBits`. Detailed investigation of bursts at
multiple time points (60 s, 100 s, 200 s, 600 s, 1000 s into the recording —
all squarely within the OTA window) revealed:

1. **No bursts have median frequency near −36 kHz** in this capture, despite
   the spectrogram peak. All detected bursts cluster in `±25 kHz` from the
   tuned center (= the runtime CCA channel at `433.602844 MHz`). The −36 kHz
   peak in the average PSD reflects one **mode of the FSK** of the same-channel
   signal (peak energy at the lower deviation), not a separate carrier.

2. **The existing runtime CCA decoder (`tools/cca/rtlsdr-cca-decode.ts`) decodes
   the OTA capture cleanly** at the runtime CCA carrier with N81 framing —
   49 packets in a 2-second window at t=200 s, mix of two recurring formats:

   - **Short type `0x0B` packets every ~25 ms (≈40 Hz, ~2.0 ms each)** — these
     match the writeup's predicted "TransferData rate" of ~40 packets/sec.
     Body shape: `0b 02 d0 24 85 cf f7` and similar with varying tail bytes.

   - **Long type `0xB1`/`0xB2`/`0xB3` packets every ~150 ms (≈6.7 Hz, ~9 ms
     each)** with body bytes 9–12 = the target device's serial
     `06 fe 80 20` (= `0x06FE8020` = 117342240 decimal, the paired DVRF-6L)
     and bytes 18-19 incrementing by `0x1F` = 31 between packets — strongly
     suggestive of TransferData chunk addresses.

3. **`findPatternOffsets` brute-force-scanning every sample for `FA DE` (LSB-
   first or MSB-first, Hamming 0–4, data rates 30.49/38.4/62.5 kbps, mix
   offsets `0/-36500/+36500/-12500/+12500`) returns zero CRC-valid OTA
   packets** at any time point in the OTA window.

The simplest explanation: **the static-RE'd raw-bit framing
`[55 55 55][FF][FA DE][LEN][OP][BODY][CRC]` doesn't describe the actual
on-air OTA traffic.** What's on-air for a 2.5 GHz Caseta Pro REP2 → DVRF-6L
firmware push is N81-framed CCA-shaped traffic on the runtime channel, with
device serial in the body, identical framing to runtime CCA. The opcode
mapping `0x2A`/`0x32`/`0x36`/`0x41`/`0x58` from the static RE may refer to
**host↔coproc IPC commands**, not on-air bytes.

This pivots the open question: instead of a body sub-opcode for the three
`0x32` Control phases, the question is **"what's the on-air encoding inside
the `0xB1+` long packets that distinguishes ChangeAddressOffset / EndTransfer
/ ResetDevice?"** Body bytes 13-17 (after the 12-byte addressing header) are
the prime candidates — they show structure but also vary across packet types.

## Smoking-gun confirmation: B1/B2/B3 payload bytes are the PFF firmware file, byte-for-byte

Pulled `firmware/07911506_v3.021_VogelkopDimmerAppCaseta.pff` from the bridge
(`/opt/lutron/device_firmware/firmware/`, hash `dc5325d2…be16` matches the
manifest). Then decoded the entire OTA window (37 s … 1130 s, 19 chunks ×
60 s) with `tools/cca/rtlsdr-cca-decode.ts`, extracted the long
`0xB1`/`0xB2`/`0xB3` packets, and matched each one's payload against the
firmware file at every plausible offset.

```
Total long packets (B1/B2/B3) decoded:  3,767 (CRC-OK 3,338, NO-CRC 429)
Chunks matched somewhere in the PFF:    3,418 / 3,767 = 90.7%
Page distribution (page 0/1/2):         1,060 / 1,209 / 1,149
PFF coverage (matched bytes):          105,462 / 187,060 = 56.4%
```

Direct hit: in the t=200 s..280 s window (a steady-state TransferData
phase), **267/267 CRC-OK chunks match the PFF file at offset = parsed
chunk address, delta = 0**. Across the full OTA window, every successfully
decoded chunk lands at exactly one of three pages (page N starts at file
offset `N · 0x10000`). The 9.3% non-match are bit-error survivors that
passed the runtime CCA decoder's CRC but have a few wrong bytes in the
payload region.

This conclusively settles the protocol layout:

```
  byte  field             value/notes
  ────────────────────────────────────────────────────────────
  0     type              0xB1, 0xB2, or 0xB3 (3-way TDMA cycle)
  1     sequence          (within the OTA stream)
  2     flags             0xA1 (retx; first-pkt = 0xA0; high nibble = packet class)
  3-4   subnet            BE 16-bit, this bridge = 0xEFFD (= Project.SubnetAddress in /var/db/lutron-db.sqlite)
  5     pair_flag         0x00 normal (0x7F during pairing)
  6     proto             0x21 = QS_PROTO_RADIO_TX
  7     body length sig   0x2B = 43 (long-pkt body length; short variants use 0x08/0x0C/0x0E)
  8     0x00              constant
  9-12  device serial     BE 4-byte (0x06FE8020 = the paired DVRF-6L)
  13    0xFE              unicast marker (broadcast packets carry 0xFF instead, with bytes 9-12 = DeviceClass)
  14-15 06 02             OTA sub-opcode = TransferData
  16    sub-counter       0..0x3F (cycles)
  17-18 chunk addr LO     16-bit BE; advances 0x1F = 31 / packet
  19    0x1F              chunk size = 31 bytes
  20-50 firmware payload  31 bytes verbatim from PFF[file_offset]
  51-52 CRC-16 (poly 0xCA0F, BE)
```

The PFF body is **transmitted encrypted, byte-identical to the file** —
the bridge does not decrypt locally. The device must hold the per-model AES
key (Vogelkop Caseta variant). This is consistent with [coproc.md](coproc.md)'s
PFF format §"likely AES, per-device-model key".

`file_offset = page * 0x10000 + chunkAddrLo` where `page ∈ {0, 1, 2}`. The
PFF file is 187,060 bytes and spans pages 0..2 (page 2 partial). The page
indicator is **not in the B1/B2/B3 header** — it's set by a control packet
(probably the static-RE'd `ChangeAddressOffset`, `0x32` body in IPC terms)
that I haven't yet pinned down on-air. Future work: identify the control
packet that announces the next 64 KB page boundary.

`tools/cca/ota-extract.ts` (script, future PR) can now reassemble a partial
firmware image from any OTA capture — useful for verifying that an OTA push
landed the correct version, or for capturing payload to attempt offline
decryption.

## Control-packet decode (2026-04-29) — `06 nn` sub-opcode mapping

Building on the chunk-decode work, `tools/ota-extract.ts --dump-all` was extended
to emit every decoded packet (not just B1+) as JSONL, and a new
`tools/ota-control-analyze.ts` surfaces non-chunk packets at phase boundaries
(OTA start, page wraps, OTA end). Across the full 1093 s OTA window, 45,130
total packets decoded — 3,767 chunks plus 41,363 of every other type.

### Sub-opcode histogram across the full OTA (`06 nn` only)

| Type | `06 nn` | Count | Role |
|------|---------|-------|------|
| `0x81` | `06 03` | 12 | Beacon-ish broadcast (DeviceClass at bytes 9-12) |
| `0x82` | `06 03` | 24 | Same shape as `0x81/06 03`, fired at OTA end |
| `0x83` | `06 03` | 48 | Same shape — fires at OTA start AND end |
| `0x91` | `06 01` | **1** | **ChangeAddressOffset (page advance)** |
| `0x91` | `06 03` | 407 | Unicast device-poll (filler `cc cc cc cc cc cc`) |
| `0x92` | `06 00` | **1** | **BeginTransfer (open OTA session)** |
| `0x92` | `06 03` | 408 | Unicast device-poll (mirror of `0x91/06 03`) |
| `0xB2` | `06 02` | 2,037 | TransferData chunk (TDMA arm) |
| `0xB3` | `06 02` | 2,041 | TransferData chunk (TDMA arm) |

(Chunks of type `0xB1` were decoded zero times — see "TDMA arms" note below.)

### Confirmed on-air opcode table

| `06 nn` | Operation | Static-RE IPC | Confirmation |
|---------|-----------|---------------|--------------|
| `06 00` | **BeginTransfer** — open OTA session, declare chunk size | `0x2A` | One-shot at t=37.263 s, 19 s before first chunk. Carrier type = `0x92` (unicast to device serial). Payload `02 20 00 00 00 1F` (last byte = chunk size 31, leading bytes still under analysis). |
| `06 01` | **ChangeAddressOffset** — advance to next 64 KB page | `0x32` (sub-A) | One-shot at t=801.946 s, 150 ms after the last chunk of page 1 (`addrLo=0xFFFC`) and 150 ms before the first chunk of page 2 (`addrLo=0x001B`). Carrier type = `0x91`. Payload bytes 16-19 = `00 01 00 02` = (prev_page=1, new_page=2). |
| `06 02` | TransferData | `0x41` | 4,078 occurrences (all chunks). Confirmed by 90.7% PFF byte-match (PR #40). |
| `06 03` | **Device-poll / pre-flight broadcast** — multi-purpose "are you alive / prepare" probe | unclear (likely `0x36` CodeRevision and/or `0x58` QueryDevice multiplexed) | 899 occurrences. Body always `cc cc cc cc cc cc` (no payload). Carrier type encodes scope: `0x81/0x83` broadcast (DeviceClass at bytes 9-12), `0x91/0x92` unicast (serial at bytes 9-12), `0x82` beacon-tail variant. |

### Confirmed full-packet layouts

**BeginTransfer (`0x92/06 00`)** — t=37.263 s, 24 bytes:
```
92 01 a1 ef fd 00 21 0e 00 06 fe 80 20 fe 06 00 02 20 00 00 00 1f 9e 83
└─ ──────────── ─────────── ─────────── ────── ────────────────── ─────
   addressing   length-ish  serial(BE)  sub-op payload (6 bytes)  CRC16
                            of 06FE8020       └─ tail = 0x1F (chunk size)
```

**ChangeAddressOffset (`0x91/06 01`)** — t=801.946 s, 24 bytes:
```
91 01 a1 ef fd 00 21 0c 00 06 fe 80 20 fe 06 01 00 01 00 02 cc cc 7b f3
                                              ────── ─────────── ─────
                                              sub-op prev=1 new=2 CRC16
                                                     filler = cc cc
```

**TransferData (`0xB2/06 02`)** — 31 bytes payload from PFF, 53 bytes total
(see existing layout earlier in this doc; sub-counter at byte 16, addrLo at
bytes 17-18, fixed `0x1F` chunk-size at byte 19, payload at bytes 20..50, CRC
at 51-52).

**Device-poll (`0xNN/06 03`)** — 24 bytes, payload always filler:
```
9X 01 a1 ef fd 00 21 08 00 06 fe 80 20 fe 06 03 cc cc cc cc cc cc CC CC
└─ broadcast (8N) or unicast (9N), DeviceClass or serial at 9-12 ───────
```

### Byte 2-7 are the standard CCA header, not OTA-specific

The bytes that earlier notes called a "static prefix" `a1 ef fd` decompose
into the **standard CCA packet header** documented in
[cca-pairing.md §"PAIR_B0"](../protocols/cca-pairing.md#pair_b0--device-announces-itself-initial-enrollment).
Byte position is class-dependent, but the **subnet** is invariant for a
given bridge.

**For commands / beacons / state types (0x80, 0x81, 0x83, 0x91, 0x92, 0x93, 0xA1-0xA3, 0xB0-0xB3):**

```
[0]   type
[1]   sequence (TDMA / retx counter)
[2]   flags          0xA0 first / 0xA1 retx (high nibble = packet class: 0xA for cmd, 0x2 for state)
[3-4] subnet         BE 16-bit, PER-BRIDGE runtime config
[5]   pair_flag      0x00 normal / 0x7F during pairing
[6]   proto          0x21 = QS_PROTO_RADIO_TX
[7]   body length sig
[8]   0x00
[9-12] device serial (unicast) OR DeviceClass (broadcast)
[13]   0xFE unicast / 0xFF broadcast
[14+]  body
```

**For response/ACK cluster (0xC1, 0xC7, 0xCD, 0xD3, 0xD9, 0xDF):**

```
[0]   type
[1]   const 0x20 (no sequence byte)
[2-3] subnet         BE 16-bit, same value, shifted left one byte
[4]   variant flag (0x01 in OTA, 0x41 during pairing)
[5+]  body
```

**Confirmed empirically (2026-04-29):**
The bridge's SQLite at `/var/db/lutron-db.sqlite` row `Project` has columns
`SubnetAddress` and `SystemRFChannel`:

```
SystemRFChannel = 26  → 433.602844 MHz (matches SDR center freq exactly)
SubnetAddress   = 61437 = 0xEFFD       (matches bytes 3-4 of every on-air packet)
```

The subnet is generated at bridge commissioning (default `0xFFFF`, set to a
random 16-bit value) and devices learn it during pairing. It is the network
discriminator a device uses to filter incoming packets — packets stamped with
a different subnet are dropped.

**For synth-TX from Nucleo+CC1101 against a paired device:**
- Learn the target's **subnet** (sniff one packet from the bridge it's
  paired to, or read `Project.SubnetAddress` from a rooted bridge), OR pair
  the device to a bridge under our control first
- Set flags byte (`0xA1` for command-class retx; `0x21` for state-class retx)
- Use unicast marker `0xFE` at byte 13 + target serial at bytes 9-12, OR
  broadcast marker `0xFF` at byte 13 + DeviceClass at bytes 9-12

This also explains why no `a1 ef fd` literal appears in any coproc binary:
the subnet is loaded from per-bridge non-volatile storage at boot, the flags
bit toggles per retx, and the unicast marker is derived from packet context —
none are static literals.

### Known gaps

1. **Page 0 → page 1 wrap had no surviving control packet** in the capture.
   At t=437.0 s..437.4 s the chunk addrLo wraps from `0xFFFE` (page 0 last)
   to `0x003C` (page 1 first), but no `06 01` decoded in that window.
   Likely lost to bit errors (only 1 of 2 expected `06 01`s survived). The
   page 1→2 announce confirms the layout, so the page 0→1 announce is
   inferred to follow the same `(prev_page, new_page)` encoding with payload
   `00 00 00 01`.

2. **No EndTransfer / ResetDevice / CodeRevision / QueryDevice on-air opcode
   identified**. After the last chunk at t=1124.642 s, only `06 03` poll
   clusters and a 6-packet response cluster (`0xC1/0xC7/0xCD/0xD3/0xD9/0xDF`)
   appear before the OTA-end log line. Hypotheses (pick one to test next):
   - `06 03` is multiplexed: the carrier type byte (`0x81` vs `0x82` vs
     `0x83`) encodes the IPC sub-operation (CodeRevision vs QueryDevice vs
     ResetDevice). The 24-byte `cc cc cc cc cc cc` filler is consistent with
     "no payload" probes.
   - The `0xC1+` response family encodes the non-`06 nn` IPCs in their own
     framing (note byte 6 changes across boundaries: `0x3F` at OTA start →
     `0x12` at OTA end → `0x3C` at page-2 wrap).
   - The device's bootloader auto-resets on receiving the BeginTransfer
     payload's `02 20 00 00 00 1F` directives without needing a closing
     EndTransfer/ResetDevice (would explain why none seen).

3. **TDMA arms**: only `0xB2`/`0xB3` chunk types observed (zero `0xB1`
   despite the writeup hypothesizing 3-way cycling). Either 2-way TDMA in
   this OTA, or `0xB1` got persistently bit-errored. The 90.7% chunk match
   doesn't depend on which two arms; both deliver the same payload-by-addrLo.

### Tooling

```sh
# Dump every decoded packet to JSONL (~3-4 min, runs rtlsdr-cca-decode in 60s slices).
npx tsx tools/ota-extract.ts \
  --capture data/captures/cca-ota-20260428-190439.rf.bin \
  --firmware data/firmware/dvrf6l-v3.021.pff \
  --start-sec 37 --duration-sec 1093 \
  --dump-all data/captures/cca-ota-20260428-190439.packets.jsonl
```

The phase-boundary inspection that produced the `06 nn` table above was a
one-shot Python pass over the JSONL — group packets by `(type, bytes[14], bytes[15])`,
locate `addrLo` wraps in the chunk stream, dump the rare-count rows. No
permanent tool needed; the JSONL itself is the corpus.

## Device-side ACK stream (`0x0B` XOR-decoded, 2026-04-29)

The 39,486 `0x0B` packets in the dump (~89% of all decoded packets, dismissed
as noise pre-decode) are the **device-to-bridge dimmer-ACK channel**. Per
`firmware/src/cca/cca_decoder.h:309 try_parse_dimmer_ack` they're 5 bytes,
NOT 8N1, with XOR validation:

- Validate: `b[3] == b[1] ^ 0x26`
- Correct: `format = b[2] ^ 0xFE`, `level = b[4] ^ 0xFE`
- During this OTA: `format ^ level == 0x55` invariant, so `level` is just a
  redundant XOR-shadow of `format`. The "format" byte carries the device-side
  status code.

Applying that rule to the JSONL: **39,468 / 39,486 (99.95%) validate**. The
`format` byte changes across OTA phases:

| `format` | Count | When | Inferred state |
|----------|-------|------|----------------|
| `0x2E` | 35,424 (89.7%) | Steady-state TransferData | "in-progress, idle ACK" |
| `0xC1` | 32 | OTA start, before first chunk | "ready / handshaking" |
| `0xC2` | 32 | Around page 1→2 wrap (~t=798..805 s) | "advancing page" |
| `0xEC` | 35 | OTA end, after last chunk | "committing / done" |
| `0x9B` | 407 | spread across OTA | unclear (count matches `0x91/06 03` poll count) |
| `0x85` | 392 | spread across OTA | unclear (count matches `0x92/06 03` poll count) |
| `0xFA` | 7 | one-shots near boundaries | unclear |

The device emits an ACK every 25 ms (40 Hz) regardless of bridge traffic.
Sequence byte cycles `0x02 → 0x04 → 0x06 → 0x08 → 0x0A → 0x0C` (6 even values)
between consecutive chunks; odd sequence values are sparse (~100 each).

**Architectural conclusion** — the device-to-bridge channel is **status-only**,
no per-chunk NACK or retransmit-request mechanism visible. The device just
broadcasts "I'm in state X" continuously; the bridge fires chunks and stops.
No on-air handshake required to advance.

## `0xC1+` response cluster — bridge-side beacon, NOT a device response

The `{0xC1, 0xC7, 0xCD, 0xD3, 0xD9, 0xDF}` 6-packet cluster (593 packets in
99 bursts across the OTA) turns out to be a **bridge-side periodic beacon**,
not a device response or boundary marker:

- Fires every ~10.85 s for the full OTA window (regular cadence, not
  boundary-triggered)
- Same body across all 6 types within a burst (only the type byte differs —
  6-way TDMA cycle, like `0xB1/B2/B3` for chunks but with 6 arms)
- Byte 6 is a **decrementing counter** that cycles `0x3F → 0x00`, then wraps:
  burst 1=`0x3F`, burst 27=`0x25`, burst 65=`0x00`, burst 66=`0x3F` (wraps),
  burst 99=`0x12` (OTA end). Some bit-error anomalies (burst 28 = `0x65`).
- Byte 11 ∈ `{0x3F, 0x3A, 0x24, 0x00}` — switches between modes at certain
  points; rough correlation with current page but not a clean page index.
- Byte 12 toggles `0x39 / 0x00` every other burst.

This is bridge-internal beacon traffic (RA-Select-style master-presence), NOT
part of the OTA wire protocol. Synth-TX from Nucleo+CC1101 does NOT need to
emit these.

## Updated picture for synth-TX from Nucleo+CC1101

What the bridge transmits during an OTA, and what we need to replicate:

**Required (the OTA conversation itself):**
1. **BeginTransfer** (`0x92/06 00`) — once at t=session-start. Payload
   `02 20 00 00 00 1F` (last byte = chunk size 31; leading 5 bytes' meaning
   still open — needs Phoenix coproc RE at IPC `0x2A` handler).
2. **TransferData** (`0xB2`/`0xB3` cycling, `06 02`) — one packet per 31-byte
   chunk, addressed by `chunkAddrLo` advancing 31 per packet.
3. **ChangeAddressOffset** (`0x91/06 01`) — at each 64 KB page boundary,
   payload bytes 16-19 = `(prev_page, new_page)`.

**Optional (we can ignore these for TX, monitor for diagnostics):**
- `0x0B` device ACKs — listen for `format=0xEC` to detect commit/reboot
- `06 03` device-poll broadcasts (bridge pre-flight) — the device does not
  appear to require these to enter OTA mode
- `0xC1+` heartbeat cluster — bridge-internal, irrelevant to the device

**Eliminated** — there is no on-air EndTransfer / ResetDevice / CodeRevision
/ QueryDevice. The bridge just stops sending TransferData; the device's
bootloader autonomously commits once it has the full firmware (likely gated
by total-size in BeginTransfer's `02 20 00 00` payload), validates per its
internal rules (LDF body CRC32 at minimum, possibly more), and reboots.

The conversion-attack feasibility now hinges entirely on **the device
bootloader's validation rules** when the LMJ `.ldf` arrives at an RMJS chip
— specifically:
1. Does the bootloader cross-check the LDF's declared DeviceClass (at body
   offset `0x8AD`) against the in-flash one before accepting?
2. Is there a signature / HMAC over the LDF body, or is CRC32 the only seal?

These are answerable by RE'ing the PowPak HCS08 bootloader OTA-receive
handler — already partially identified at BN `0x4290` (flash-write primitive)
+ `sub_8bb4` (the calling site).

## Outstanding work (after the 2026-04-29 control-packet + ACK decode)

1. **Decode BeginTransfer payload `02 20 00 00`** — need to know what to TX
   for an LMJ firmware bundle. Phoenix EFR32 coproc RE at IPC opcode `0x2A`
   handler (BN `0x08018c18` / `0x08018c98`).
2. **Recover the page 0→1 wrap announcer** — only the page 1→2 announcer
   survived in the capture. Replay t=435..440 s with majority-vote across
   retransmissions to confirm inferred payload `00 00 00 01`.
3. **PowPak HCS08 bootloader validation rules** — start at BN `0x4290` /
   `sub_8bb4` and trace what the OTA-receive path checks. Determines
   whether cross-family flash can succeed (Path 2 viable vs BDM-only).
4. **Build the synth OTA TX firmware module** — extend `firmware/src/cca/`
   with an OTA-TX mode emitting BeginTransfer + TransferData + Change
   AddressOffset. Validate by self-receive via SDR + the existing
   `tools/ota-extract.ts` reassembler reaching 100% PFF coverage on
   synthesized output.

## Methodology validation

Cross-reference of the runtime CCA pairing capture (separate session, same
laptop+SDR setup) decoded cleanly via the existing `tools/cca/rtlsdr-cca-decode.ts`
with all 8 documented pairing phases visible (idle/active beacons, PAIR_B0
device announce, A1/A2/A3 config, format 0x15 trim, format 0x0A LED, 6-round
handshake commit). The pairing capture corroborates PR #35 (no-crypto handshake)
and PR #36 (4-arm dispatch by `type & 0xC0`) byte-for-byte against the
documented byte layouts.

The OTA capture, once decoded, will play the same role for [§9 of cca.md](../protocols/cca.md#9-firmware-ota-wire-protocol).
