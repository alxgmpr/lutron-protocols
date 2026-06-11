# CCA OTA — firmware over-the-air transfer

Canonical reference for the Clear Connect Type A (CCA) firmware over-the-air
(OTA) wire protocol, covering both the empirical EFR32/Caseta live capture
(2026-04-28) and the HCS08 (PowPak / HW-CCA) adaptation. The static
reverse-engineering anchors for the protocol live in
[`../../devices/powpak.md`](../../devices/powpak.md); this page is the
authoritative on-air description.

## 1. Summary

CCA OTA is a **single-channel** firmware transfer on a band centered near
**433.566 MHz, ~80 kHz wide** — it is **not** a frequency-hopping protocol.
The same wire format applies across both radio targets that ship CCA devices:
the **EFR32** coprocessor (Caseta / RA2 Select bridges, BASENJI-family
dimmers) and the **HCS08** MCU (PowPak RMJ/LMJ/RMJS modules and HW-CCA
dimmers). Transfer is the bridge (or a synthesizing transmitter) streaming
31-byte firmware chunks, addressed by a wire-level address that advances 31
bytes per packet and wraps at 64 KB page boundaries; the device's bootloader
receives the chunks and autonomously commits the image once complete. The
first successful end-to-end live capture (a rooted Caseta Pro / RA2 Select
REP2 bridge pushing firmware to a paired DVRF-6L dimmer, DeviceClass
`0x04630201`, factory firmware `003.021`) confirmed the framing, channel
parameters, and chunk layout byte-for-byte against the on-bridge PFF firmware
file.

## 2. Channel parameters

Measured from the 2026-04-28 live IQ capture (2.56 MHz capture bandwidth
centered on the runtime CCA carrier `433.602844 MHz`, which corresponds to
`Project.SystemRFChannel = 26` in the bridge's SQLite DB):

| Parameter | Value | Source |
|-----------|-------|--------|
| Center frequency | **433.566 MHz** (dominant PSD peak, −36 kHz from runtime CCA center) | Average PSD over the TransferData window |
| Energy span | 433.5594 MHz → 433.6388 MHz (~80 kHz wide) | 99.5th-percentile PSD bins |
| Data rate | **~62.5 kbps** (preamble peak-to-peak ~31 µs = 2 bit periods → ~64 kHz) | Empirical; revises the static-RE 30.49 kbps decode (see §5) |
| Deviation | ±48 kHz observed (10/90 percentiles of instantaneous freq), consistent with CC1101 `DEVIATN=0x44` ≈ 38 kHz plus transition smear | Instantaneous-frequency discriminator on a real burst |
| Burst structure | ~2.1 ms bursts every ~25 ms during TransferData (~40 packets/sec) | Burst timing in the capture |

### Spectrogram evidence (2026-04-28)

5-second window during the active TransferData phase (~100 s into the
recording):

![5s zoom spectrogram](../../firmware-re/figures/cca-ota/zoom-5s.png)

Vertical bursts appear in a single ~80 kHz-wide band centered slightly below
the runtime CCA channel — **no frequency hopping is visible**.

Average PSD over the same window:

![Average PSD](../../firmware-re/figures/cca-ota/avgfft.png)

A single dominant peak at **433.5663 MHz**. If this were a 35-channel hop at
~92 kHz spacing we would see ~3.2 MHz of total span and 35 distinct peaks; we
see one. The −36 kHz offset in the average PSD reflects one **mode of the
FSK** of the same-channel signal (peak energy at the lower deviation), not a
separate carrier — detailed burst analysis at multiple time points (60 s,
100 s, 200 s, 600 s, 1000 s) found all bursts clustered within ±25 kHz of the
tuned runtime CCA carrier.

## 3. Wire format

On-air, CCA OTA traffic is **N81-framed CCA-shaped traffic on the runtime
channel** — identical outer framing to runtime CCA, decoded cleanly by the
runtime CCA decoder ([`../../../tools/cca/rtlsdr-cca-decode.ts`](../../../tools/cca/rtlsdr-cca-decode.ts)).
The 8N1 outer frame is:

```
[55 55 55][FF][FA DE][LEN][TYPE][...body...][CRC16]
 preamble  delim sync  len  type             poly 0xCA0F (BE)
```

- **Preamble** `55 55 55`, sync delimiter `FF`, **sync word `FA DE`** (`0xFADE`).
- **CRC-16** over the body using polynomial **`0xCA0F`**, big-endian.

The static-RE'd opcode set (from the Phoenix EFR32 coproc) and its wake-up
sequence:

```
QueryDevice(0x58) → CodeRevision(0x36) → BeginTransfer(0x2A)
  → ChangeAddressOffset(0x32) → TransferData(0x41)×N
  → EndTransfer(0x32) → ResetDevice(0x32)
```

These `0x2A`/`0x32`/`0x36`/`0x41`/`0x58` opcodes are **host↔coproc IPC
command codes**; on-air they map to a `06 nn` sub-opcode at body bytes 14-15.
The confirmed on-air opcode table (from the live capture):

| `06 nn` | Operation | IPC code | Carrier type | Notes |
|---------|-----------|----------|--------------|-------|
| `06 00` | **BeginTransfer** — open session, declare chunk size | `0x2A` | `0x92` unicast | One-shot ~19 s before first chunk. Payload `02 20 00 00 00 1F` (trailing `0x1F` = chunk size 31). |
| `06 01` | **ChangeAddressOffset** — advance to next 64 KB page | `0x32` | `0x91` unicast | One-shot at each page wrap. Payload bytes 16-19 = `(prev_page, new_page)` 16-bit BE. |
| `06 02` | **TransferData** — 31-byte firmware chunk | `0x41` | `0xB1`/`0xB2`/`0xB3` (TDMA arms) | One packet per chunk; `addrLo` advances 31/packet. Confirmed 90.7% byte-match against the PFF file. |
| `06 03` | **Device-poll / pre-flight broadcast** | likely `0x36`/`0x58` multiplexed | `0x81`/`0x82`/`0x83` broadcast, `0x91`/`0x92` unicast | Body always filler `cc cc cc cc cc cc`. |

### BeginTransfer / ChangeAddressOffset / TransferData framing

The standard CCA header occupies bytes 0-13; OTA-specific fields follow.

**BeginTransfer (`0x92/06 00`)** — 24 bytes:
```
92 01 a1 ef fd 00 21 0e 00 06 fe 80 20 fe 06 00 02 20 00 00 00 1f 9e 83
└─ ──────────── ─────────── ─────────── ────── ────────────────── ─────
   addressing   length-ish  serial(BE)  sub-op payload (6 bytes)  CRC16
                            of 06FE8020         └─ tail = 0x1F (chunk size 31)
```

**ChangeAddressOffset (`0x91/06 01`)** — 24 bytes:
```
91 01 a1 ef fd 00 21 0c 00 06 fe 80 20 fe 06 01 00 01 00 02 cc cc 7b f3
                                              ────── ─────────── ─────
                                              sub-op prev=1 new=2 CRC16
```

**TransferData (`0xB2/06 02`)** — 53 bytes total, 31-byte payload:
```
byte  field             value/notes
────────────────────────────────────────────────────────────────────────
0     type              0xB1, 0xB2, or 0xB3 (TDMA cycle; only B2/B3 seen)
1     sequence          within the OTA stream
2     flags             0xA1 retx (first packet 0xA0; high nibble = packet class)
3-4   subnet            BE 16-bit, per-bridge (this bridge 0xEFFD = Project.SubnetAddress)
5     pair_flag         0x00 normal (0x7F during pairing)
6     proto             0x21 = QS_PROTO_RADIO_TX
7     body length sig   0x2B = 43 (long-pkt body length)
8     0x00              constant
9-12  device serial     BE 4-byte (0x06FE8020 = the paired DVRF-6L)
13    0xFE              unicast marker (0xFF broadcast, with DeviceClass at 9-12)
14-15 06 02             OTA sub-opcode = TransferData
16    sub-counter       0..0x3F (cycles)
17-18 chunk addr LO     16-bit BE; advances 0x1F = 31 per packet
19    0x1F              chunk size = 31 bytes
20-50 firmware payload  31 bytes verbatim from PFF[file_offset]
51-52 CRC-16 (poly 0xCA0F, BE)
```

`file_offset = page * 0x10000 + chunkAddrLo`, page ∈ {0, 1, 2}. The PFF body
is transmitted **encrypted, byte-identical to the file** — the bridge does
not decrypt locally; the device holds the per-model AES key. In the captured
t=200..280 s steady-state window, **267/267 CRC-OK chunks matched the PFF
file at the parsed chunk address with delta 0**; across the full OTA window
3,418 / 3,767 long packets (90.7%) matched the PFF, the remainder being
bit-error survivors that passed CRC.

The bridge also emits two channels that a synthesizing transmitter can
**ignore**: the device-to-bridge `0x0B` XOR-encoded ACK stream (5-byte, parsed
by [`../../../firmware/src/cca/cca_decoder.h`](../../../firmware/src/cca/cca_decoder.h)
`try_parse_dimmer_ack`; `format` byte carries device state — `0x2E`
in-progress, `0xC1` ready, `0xC2` advancing-page, `0xEC` committing), and a
bridge-internal `0xC1/0xC7/0xCD/0xD3/0xD9/0xDF` periodic beacon cluster (fires
~every 10.85 s, 6-way TDMA, unrelated to the OTA conversation). There is **no
on-air EndTransfer / ResetDevice / CodeRevision / QueryDevice** — the bridge
simply stops sending TransferData and the device's bootloader commits
autonomously.

## 4. Force-trigger procedure (rooted Caseta Pro REP2)

The bridge pushes an OTA only when its `leap-server` `devicefwu` module
decides a device's running version is older than the manifest version. That
decision reads `leap-server`'s in-memory device-firmware cache, seeded from
`Device.FirmwareRevision` in the runtime DB at startup. The cloud check
(`firmwareUpgrade.sh`) is a dead end — the app's "Check for firmware updates"
button bypasses the cloud and goes straight to `leap-server`'s `devicefwu`.

### Step 1 — apply DB spoofs

In the runtime DB at `/var/db/lutron-db.sqlite`, `Device.ActionRequiredID` is
constrained to `(0, 6, 8)` and cannot be set to `9`; spoofing only
`FirmwareRevision` is sufficient for the eligibility check, with
`LinkNodeAssociations.ActionRequiredID = 9` as belt-and-suspenders:

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

`SerialNumber` is the factory serial (decimal). Confirm the
`LinkNodeAssociationsID` first:

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

The cache is in-memory; without a bounce the spoof has no effect:

```sh
/etc/init.d/K26-leap-server restart
```

(`S74-leap-server` is the start-side symlink for the same script; it supports
`start|stop|restart`.)

### Step 3 — trigger from the Lutron app

Tap **Check for firmware updates**. `leap-server` then re-parses
`/opt/lutron/device_firmware/device-firmware-manifest.json`, runs `Plinko`
against its in-memory cache, and if any device's cached `FirmwareRevision` is
below the manifest version for its `DeviceClass`, fires
`devicefwu: Starting update of N device(s)`. lutron-core picks up the IPC and
starts the per-device CCA OTA via the coproc. There is no known way to trigger
this without the app — the periodic timer
(`ScheduledDeviceFirmwareUpdateTimeoutSeconds`, daily-ish) is too slow, and
`RequestStartFirmwareAutoApply` is not socket-callable from outside (returns
`No command parser registered`).

### Step 4 — cleanup

```sh
sqlite3 /var/db/lutron-db.sqlite "
  UPDATE LinkNodeAssociations
    SET ActionRequiredID = 0
    WHERE LinkNodeAssociationsID = 4;
"
```

After a successful OTA, lutron-core overwrites `Device.FirmwareRevision` back
to the device's actual reported value, so that field is self-cleaning.

### Observed timeline (DVRF-6L, Vogelkop `003.021`)

```
21:04:37 leap-server: devicefw: Package cache stale, parsing package version
21:05:16 leap-server: devicefwu: Starting update of 1 device(s)         (~40 s after button tap)
21:05:16 leap-server: devicefwu: Starting update of device with serial 117342240
21:06:08 lutron-core: Coproc Health Statistics: UI Queue high water 2.35% → 3.92%
21:24:03 lutron-core: data-transfer-receiver: Data transfer complete
21:24:05 leap-server: devicefwu: Successfully updated SerialNumber 117342240 → 003.021
21:24:05 leap-server: devicefwu: All devices have finished updating
```

Total OTA: **18 minutes 49 seconds**, within the manifest's
`EstimatedFastUploadTimeInSeconds: 1200` envelope. Note that lutron-core
logs **only** the two firmware-related entries at the very end — per-phase
timing and byte correlation must come from the RF capture, not the log; the
coproc UI-Queue high-water-mark bump is the only proxy signal for OTA traffic.

## 5. HCS08 specifics (PowPak / HW-CCA)

The same wire protocol drives HCS08-based devices — HW-CCA dimmers
(HQR/HWQS/MRF2, DeviceClass `0x04xxxxxx`) and PowPaks (family `0x16xxxxxx`).
Because the Phoenix RA3 IPL HW-CCA OTA path is a dead stub (`CCA_LINK_DRIVER`
vtable[0xc0] is `mov r0,#0; bx lr`, so IPL opId 272 silently returns 0), the
only working path is driving the openBridge directly via `STREAM_CMD_TX_RAW_CCA`
from the host-side TS driver
([`../../../tools/cca/ota-tx.ts`](../../../tools/cca/ota-tx.ts) +
[`../../../lib/cca-ota-tx-builder.ts`](../../../lib/cca-ota-tx-builder.ts)).

### What is identical to EFR32

Confirmed via PowPak HCS08 bootloader RE (see
[`../../devices/powpak.md`](../../devices/powpak.md)):

- **Outer N81 framing** — `[55 55 55][FF][FA DE][LEN][TYPE][...][CRC16(0xCA0F)]`.
- **Type bytes** — `0x91/0x92` short unicast, `0xB1/0xB2/0xB3` long unicast.
- **Header layout** (bytes 0-13) — same as the TransferData table in §3.
- **Sub-opcode pattern** (`06 nn` at bytes 14-15) — the HCS08 dispatcher at
  body `0x1A23` branches on the same sub-op byte: `06 00` BeginTransfer falls
  through to the default flash-write primitive (`CALL $0292, #$67`); `06 01`
  ChangeAddressOffset → `CALL $009A, #$F6`; `06 02` TransferData →
  `CALL $009B, #$2F`; `06 03` Poll → `CALL $009A, #$B0`; `06 04`/`06 06` →
  `CALL $009B, #$CD` and `06 05` → `CALL $009B, #$B5` (semantics unknown, never
  seen on-air).
- **Chunk size** `0x1F` = 31 bytes per TransferData.
- **64 KB wire-page semantics** — `addrLo` advances 31/packet, wraps at
  `0x10000`, `ChangeAddressOffset` announces the new page. The HCS08's banked
  16 KB physical flash pages are decoupled from the wire-level 64 KB pages: the
  flash-write primitive at body `0x0292` reads a 3-byte address and resolves it
  to physical flash via the chip's linear-address mapping.

The HCS08 sync-detect at body `0x52BF` is `CPHX #$FADE; BNE $5330` with no
subnet/serial/DeviceClass filter — it accepts any sync-matching packet, then
filters at the OTA dispatcher by serial + sub-opcode.

### Bootloader & FREQ registers

The PowPak bootloader runs the CC1101 in **async serial mode**
(`PKTCTRL0 = 0x32`): the chip handles physical-layer FSK while the MCU
bit-bangs the entire CCA framing (preamble, sync word, length, CRC). CC1101
sync filtering is disabled (`MDMCFG2 SYNC_MODE = 0`, `SYNC1/0 = 0x00`) — all
sync detection is in firmware. The `FREQ2/1/0` registers are **excluded from
the main CC1101 init table** (register offsets `0x0D-0x0F`): the band (434 vs
868 MHz) is configured by a separate code path. An adjacent constant at BN
`0x9B2D` (`21 63 b1` = FREQ2/1/0 for 868.1249 MHz) is the 868 MHz anchor,
likely leftover shared-codebase dead code on the 434 MHz firmware.

The static decode of `MDMCFG3 = 0x3B` gave 30.49 kbps, but the live capture
measured **~62.5 kbps** empirically (preamble peak-to-peak), so either the
register formula was misapplied or the OTA reuses runtime CCA's bit clock.
Likewise the data-rate row in
[`../../devices/powpak.md`](../../devices/powpak.md) and the modem-config
section of the CCA reference are superseded by the §2 measured values.

### The 35-row table is NOT a frequency-hop table

A 35-entry stepping table sits at BN `0x9B30-0x9B7F`:

```
44 EC  45 E8  46 E4  47 E0  48 DC  49 D8  4A D4  4B D0
4C CC  4D C8  4E C4  4F C0  50 BD  51 B9  52 B5  53 B1
54 AD  55 A9  56 A5  57 A1  58 9D  59 99  5A 95  5B 91
5C 8D  5D 89  5E 85  5F 81  60 7E  61 7A  62 76  63 72
64 6E  65 6A  66 66
```

Each entry is 2 bytes; the first byte increments by 1, the second decrements
by ~4. Static RE originally **hypothesized this was a frequency-hop table**
(interpreting the pairs as `(FREQ1, FREQ0)` with implied `FREQ2 = 0x10`).

**The 2026-04-28 live OTA capture DISPROVED that hypothesis.** OTA runs on a
**single channel at ~433.566 MHz for the entire 19-minute transfer with no hop
pattern** (see §2). The `(FREQ1, FREQ0)` interpretation also yielded
~423-425 MHz — below the 433 MHz ISM band — confirming it is not a direct
CC1101 frequency table. **The canonical interpretation is that the 35-row
table is NOT a hop table; it is most likely a calibration LUT or a
retry-channel / offset list.**

### Host-side driver status

[`../../../lib/cca-ota-tx-builder.ts`](../../../lib/cca-ota-tx-builder.ts) adds
an `McuFamily` type (`"efr32" | "hcs08"`), per-MCU BeginTransfer payload
defaults (`HCS08_BEGIN_TRANSFER_PAYLOAD` mirrors EFR32's
`02 20 00 00 00 1F` by default), `buildBeginTransfer`, and `walkOtaPackets`.
[`../../../tools/cca/ota-tx.ts`](../../../tools/cca/ota-tx.ts) adds
`--mcu efr32|hcs08`, `--begin-payload` (override BeginTransfer bytes 16-21),
and `--begin-only` (emit BeginTransfer then stop, for non-destructive
reachability probing). A dry-run against `HWQS_3PD_3.08.LDF` (DeviceClass
`04 24 02 01`, 109,956-byte body) emitted 3,549 packets = 1 BeginTransfer +
3,547 TransferData + 1 ChangeAddressOffset (page 0 → page 1, payload
`00 00 00 01`).

Candidate EFR32-vs-HCS08 differences still unverified: BeginTransfer payload
bytes 16-20 (leading 5 bytes' meaning open even for EFR32), the device-side
ACK format, and end-of-transfer behavior (sub-ops `0x04`/`0x05` reach handlers
but were never observed on-air). The HCS08 bootloader's default fallback
(sub-op `0x00` → flash-write primitive) may be destructive on an
already-in-OTA device. The conversion-attack feasibility (RMJ → LMJ) hinges on
the HCS08 bootloader's validation rules — whether it cross-checks the LDF's
declared DeviceClass (body offset `0x8AD`) and whether a signature/HMAC seals
the LDF body or CRC32 is the only seal; see
`~/redacted-security-repo/docs-security/powpak-conversion-attack.md`.

## 6. Cross-references

- [`../../devices/powpak.md`](../../devices/powpak.md) — PowPak HCS08 RE:
  RX-side anchors, dispatcher decode, flash-write primitive, sync-detect,
  DeviceClass identity, and the static modem-config tables superseded here.
- [`../../devices/caseta-smartbridge.md`](../../devices/caseta-smartbridge.md) —
  the Caseta Pro / RA2 Select REP2 bridge that performs the EFR32 OTA push.
- [`index.md`](index.md) — CCA protocol index.
- [`pairing.md`](pairing.md) — CCA pairing wire format (the byte 0-13 header
  shared with OTA traffic).
