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

2. **The existing runtime CCA decoder (`tools/rtlsdr-cca-decode.ts`) decodes
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

## Outstanding work for full transcript

1. **Decode the type `0x0B` short packet body structure** — body has 3-5
   bytes after the type+length header; a sequence number is plausibly in
   there (the runtime CCA decoder finds these pass CRC after the polarity
   flip and N81 alignment).
2. **Decode the type `0xB1`/`0xB2`/`0xB3` long packet body** — bytes 9-12
   are the device serial; bytes 13-17 are the OTA sub-header; bytes 18-19
   appear to be a chunk address (incrementing 31 bytes/packet); bytes 20+
   are the firmware payload.
3. **Reconcile the static-RE'd opcodes with on-air bytes** — `0x2A`/`0x32`/
   `0x36`/`0x41`/`0x58` may live as command IDs on the host-side IPC
   (`leap-server` ↔ `lutron-core` ↔ coproc) rather than on-air. Cross-
   reference against [caseta-cca-ota.md](caseta-cca-ota.md)'s HDLC cmd ID
   table (`0x119`/`0x11B`/`0x11D` etc.).
4. **Resolve the body sub-opcode discriminator** for the three `0x32`
   Control phases (Open Question #1) — likely now needs to be answered at
   the IPC layer, not the on-air layer.

## Methodology validation

Cross-reference of the runtime CCA pairing capture (separate session, same
laptop+SDR setup) decoded cleanly via the existing `tools/rtlsdr-cca-decode.ts`
with all 8 documented pairing phases visible (idle/active beacons, PAIR_B0
device announce, A1/A2/A3 config, format 0x15 trim, format 0x0A LED, 6-round
handshake commit). The pairing capture corroborates PR #35 (no-crypto handshake)
and PR #36 (4-arm dispatch by `type & 0xC0`) byte-for-byte against the
documented byte layouts.

The OTA capture, once decoded, will play the same role for [§9 of cca.md](../protocols/cca.md#9-firmware-ota-wire-protocol).
