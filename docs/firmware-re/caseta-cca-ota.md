# Caseta Bridge CCA OTA Orchestration

How the Caseta SmartBridge / RA2 Select bridge (L-BDG2-WH, deviceclass `080F0101`)
orchestrates CCA device firmware updates over 433 MHz.

The on-air opcode bytes have since been RE'd from the Phoenix EFR32 coproc (see
[powpak.md](powpak.md) and [docs/protocols/cca.md §9](../protocols/cca.md#9-firmware-ota-wire-protocol)).
The Caseta Pro coproc was confirmed to use the same wire format via static RE
of the RA2 Select REP2 image, and an end-to-end **live OTA capture against a
Caseta Pro REP2 + DVRF-6L on 2026-04-28** confirmed the channel parameters
empirically — see [cca-ota-live-capture.md](cca-ota-live-capture.md). The
single remaining wire-protocol unknown is the body-side sub-opcode that
discriminates the three `0x32` Control phases, which awaits a working GFSK
demod against the captured 6.1 GB IQ stream.

Companion to [coproc.md](coproc.md), which covers Phoenix's analogous path on RA3.

## Architecture

```
SSH / LEAP API
      │
      ▼
trigger_firmware_upgrade.sh  ──► firmwareUpgrade.sh ──► curlscript.sh
                                       │                  (firmwareupdates.lutron.com)
                                       │
                                       ▼
                       platform_manager_wrapper.sh -p
                                       │
                                       │ JSON IPC over UNIX socket
                                       │  (PlatformManagerSocketPath in lutron.conf)
                                       │  via /usr/sbin/lutron-core-client
                                       ▼
                                 lutron-core
                                       │
                          ┌────────────┼─────────────┐
                          │            │             │
                          ▼            ▼             ▼
                  device_firmware_   device-firmware-  cca-firmware-update-
                  download.sh        manifest.json     link-command-router
                  (opkg over HTTPS)                            │
                          │                                   │ 8 IPC core commands
                          ▼                                   ▼
                /tmp/device_firmware/                   coproc (STM32, /dev/ttyO1)
                lutron_device_firmware                         │
                                                               │ 433 MHz CCA RF
                                                               ▼
                                                     CCA device (Diva, plug-in,
                                                       Maestro, fan ctrl, ...)
```

## Trigger

From SSH on the bridge, the cleanest one-liner that orchestrates the whole flow:

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

### Naming caveat: this is not a bridge rootfs update

The shell variable holding this message is named
`PEGASUS_DEVICE_FW_DOWNLOAD_IPC_MESSAGE_WITH_AUTOINSTALL` — "Pegasus" is the CCX/Thread
codename, which would suggest this path is CCX-only. **It isn't.** The JSON `cmd` is
just `RequestDownloadDeviceFirmwarePackage` (no Pegasus), and on Caseta the manifest
it consumes is exclusively CCA (`TargetLocationName: "CCA"` for all 15 entries). The
"Pegasus" prefix is leftover Phoenix nomenclature where CCX is the dominant device
class. On Caseta with no CCX devices, every dispatch routes to the
`CCA_FIRMWARE_UPDATE_*` state machine.

For comparison, processor-firmware (i.e. bridge rootfs) updates use entirely separate
flags and IPC commands — never overlap with `-p`:

| Concern | Processor / rootfs | Device / CCA |
|---|---|---|
| Wrapper flag | `-d` / `-a` / `-i` | `-p` |
| IPC `cmd` | `RequestDownloadProcessorFirmware`, `RequestInitiateProcessorFirmwareInstall` | `RequestDownloadDeviceFirmwarePackage` |
| Bundle type | `.deb` (rootfs) | `.pff` (per-device) |
| opkg config | `/etc/opkg.conf` | `/etc/opkg_device-firmware.conf` |
| Destination | UBI partition + EEPROM flag flip + reboot | `/tmp/device_firmware/`, no reboot |

`AutoInstall: true` means: download the bundle from the cloud URL stored at
`/tmp/platform_manager/tmp/device_firmware_repo_url`, then immediately push to all
eligible devices over the air.

**Bypass cloud check** (for repeatable captures or when the cloud reports no update):
pre-stage a known-good bundle at `/tmp/device_firmware/lutron_device_firmware` and
mutate a target device's `RequiresFirmwareUpdate` flag in
`/var/db/lutron-runtime-db-default.sqlite` (queried via
`SELECT … FROM Device JOIN LinkNode … WHERE LinkID = ?`).

Other related entrypoints:
- `trigger_firmware_upgrade.sh -t cron_job` — runs the full check/update cycle. Slow.
- `lutron-coproc-firmware-update-app -s /dev/ttyO1 -f <s19>` — bridge's own coproc
  firmware update over serial. **Not** CCA device OTA.
- `coproc_firmware_updater.pyc --system-type=rockhopper` — boot-time coproc updater
  wrapper. Same scope as above.

## OTA Wire Vocabulary

`lutron-core` exposes eight CCA OTA core commands (from
`cca-firmware-update-link-command-router.cpp`, recovered as C++ symbols from the
stripped binary). Each maps to a coproc IPC message which the coproc translates into
one or more CCA RF packets:

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
advances.

The on-air opcode for each IPC phase has since been RE'd from the **Phoenix EFR32
coproc** (`phoenix_efr32_8003000-803FF08.bin`). See
[powpak.md §"CCA OTA wire protocol"](powpak.md#cca-ota-wire-protocol-red-from-phoenix-efr32-coproc)
for full framing, and [docs/protocols/cca.md §9](../protocols/cca.md#9-firmware-ota-wire-protocol)
for the protocol-spec form. Phase → opcode mapping:

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

Three phases share opcode `0x32` — body-byte sub-opcode discriminator still TBD
(see Open Question #1 below). Whether the **Caseta Pro coproc** (separate STM32
image, not extracted yet — only old `caseta-sb-0205/0210_stm32_*.s19` SmartBridge
blobs in `data/firmware/caseta-device/coproc-old/`) emits the same on-air
opcodes is also TBD; could be confirmed either by extracting the Caseta coproc
image (cipher work — see [caseta-smartbridge-coproc.md](caseta-smartbridge-coproc.md)
for the related cipher cracked on the older SmartBridge) or by live RF capture.

## Auto-trigger paths inside `lutron-core`

These fire without external IPC, useful to know so we don't mistake them for our
test-induced traffic:

- `CLAP_LINK_MANAGER_STARTED_STATE.triggerFirmwareUpdate(bool)` — fires when a link
  starts and the coproc reports a link type that doesn't match the device class's
  expected coproc image type, or when the device class has multiple valid link
  types (repair path).
- `ScheduledDeviceFirmwareUpdateTimeoutSeconds` — periodic timer; queries
  `DevicesRequiringFirmwareUpdate` table and runs sessions per link.
- `CCXDeviceFirmwareUpdate` config node has a "Downgrade Enabled" feature flag —
  name suggests CCX-only but logic appears unified across CCA/CCX.

## Manifest format

`/opt/lutron/device_firmware/device-firmware-manifest.json` (plaintext, 15 entries
in v08.25.17f000):

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
    },
    …
  ]
}
```

**Codename → device-class map** (15 classes covered):

| Codename | Device classes | Files | MCU |
|---|---|---|---|
| BASENJI (Diva, e.g. DVRF-6L) | `0x03150101/0201`, `0x03160101/0201` | v2.015 + v2.025 | **EFR32FG23** (Cortex-M33, Secure Vault Mid) |
| BANANAQUIT (plug-in / Maestro family) | `0x03090601`, `0x030A0601`, `0x03130601`, `0x03140601` | v2.025 | TBD (likely EFR32) |
| EO / eagle-owl | `0x03120101/0102/0103` | v2.025 | TBD (likely EFR32) |
| Vogelkop (high-end dimmer) | `0x04630201`, `0x04640101`, `0x04660201` | v3.012 + v3.021 | TBD |
| Antillean | (in firmware list, class TBD) | v1.001 | TBD |
| Caseta Dimmer (legacy) | `0x04320501` | v2.05 | TBD (likely HCS08 — pre-EFR32 era) |

**EFR32FG23 implication for PFF key recovery**: BASENJI uses FG23, which is xG2x
(Cortex-M33 + Secure Vault Mid, AAP token-based unlock, Secure Boot RTSL, OTP
key storage). Older xG1/xG12/xG14 (Cortex-M4) glitch attacks (LimitedResults /
Riscure et al.) do not apply directly — newer xG2x glitch research exists
(LimitedResults / Quarkslab on xG21+) but is harder. Crucially, Secure Boot and
debug-lock on FG23 are configurable, so empirically check what Lutron actually
enabled before assuming the worst case.

`EstimatedFastUploadTimeInSeconds: 1200` ⇒ **~20 min of RF per device**. Plan capture
buffer / streaming accordingly.

## .pff format (Pegasus Firmware Format)

Same container as CCX device firmware. See [coproc.md §"PFF File Format"](coproc.md#pff-file-format)
for the verified layout. Headline: 4-byte BE Major (0=boot, 1=app), 4-byte BE Minor,
64-byte unique field (likely ECDSA-P256 signature), 195 reserved zero bytes, then
the AES ciphertext starting at offset `0x10B`. Bridge does NOT decrypt — it ships
the .pff bytes unmodified to the device bootloader, which decrypts in place.

Format identifier (in path component): `App` images, distinct from `Boot` images
(format 0 = boot ~20K, format 1 = app 100–900K). Caseta manifest only ships App
images — boot updates would require physical access.

## Capture experiment plan

1. **Pick a target device** with a real version delta. From our LEAP dumps,
   DVRF-5NE-XX (DivaSmartDimmer @ `003.012.000`) is behind the Vogelkop App
   (`v3.021`). Confirm it's still pairable and on the bridge.

2. **Stage the bundle** if cloud reports no update:
   ```sh
   ssh root@<caseta-ip>
   cp <known-bundle> /tmp/device_firmware/lutron_device_firmware
   ```
   (Or just let `-p` pull live from cloud — easier if version delta is real.)

3. **Arm a wideband sniffer** — RTL-SDR is the safer choice here than CC1101-based
   sniffers (openBridge or Nucleo+CC1101) because OTA traffic uses a different
   modem mode than runtime CCA (GFSK 30 kbps async serial, 35-channel hopping
   across 92 kHz spacing — see [docs/protocols/cca.md §9.2](../protocols/cca.md#92-modem-config-cc1101)).
   The CC1101-based sniffers would need to be reconfigured to OTA mode and
   either parked on a single hop channel or made to follow the hop sequence.
   For RTL-SDR, capture ≥ 1500 s at the broadest-feasible bandwidth covering
   all 35 channels (≈ ~3.2 MHz centered on the band — adjust based on hop
   table extent).

4. **Trigger** from SSH:
   ```sh
   /usr/sbin/platform_manager_wrapper.sh -p
   ```

5. **Tail logs** in parallel:
   ```sh
   tail -F /var/log/messages | grep -E "firmware-update|cca|coproc"
   ```

6. **Decode**: with the phase→opcode mapping already documented (above and in
   [docs/protocols/cca.md §9.4](../protocols/cca.md#94-phase--opcode-mapping)),
   the capture's main remaining purpose is to (a) **verify** the Caseta Pro
   coproc emits the same wire format as Phoenix's, and (b) **resolve** the
   body sub-opcode that distinguishes the three `0x32` Control phases
   (ChangeAddressOffset / EndTransfer / ResetDevice). Segment the capture by
   long inter-packet gaps (sparse handshake phases vs. the dense TransferData
   burst), match boundaries to log timestamps, and read the body bytes of
   each `0x32` packet to identify the discriminator.

## Cross-system applicability (RMJ / Phoenix LMJ / Vive RMJS)

- **Wire protocol** (433 MHz packet format) is almost certainly shared across
  host systems — same radio chip family on the device side, and Phoenix uses the
  same `cca-firmware-update-*` C++ class names per coproc.md. So the byte-level
  protocol RE'd here generalizes.
- **Orchestration** is host-specific:
  - Phoenix (RA3/HW): same IPC names, but invoked via different platform-manager
    binary; uses obfuscated S19 blobs in `lutron-coproc-firmware-update-app`.
  - ESN (RMJ): unconfirmed — likely a different daemon; ESN may not support OTA
    at all (broadcast-style, see [esn.md](esn.md)).
  - Vive hub (RMJS): unconfirmed — has its own `lutron-core` variant.
- **For RMJ→LMJ "conversion attacks"**: per [memory note], the host system that
  owns the device must run the orchestrator. The wire packets we capture from
  Caseta should let us craft equivalent RF directly (bypassing the host) given a
  controllable transmitter (openBridge), if we can also recover/forge the
  per-device-model PFF decryption key.

## Open questions after this pass

1. ~~**CCA RF packet type byte for OTA phases**~~ — **Resolved 2026-04-29**.
   Live-capture decode produced the full on-air opcode table (see
   [cca-ota-live-capture.md §"Control-packet decode"](cca-ota-live-capture.md))
   and the static-RE'd raw-bit framing was reclassified as host↔coproc IPC,
   not on-air. On-air uses runtime CCA framing with `06 nn` body sub-opcodes:
   `06 00` BeginTransfer, `06 01` ChangeAddressOffset, `06 02` TransferData,
   `06 03` device-poll. EndTransfer / ResetDevice / CodeRevision / QueryDevice
   have no on-air representation — bridge stops sending and device commits
   autonomously.
2. ~~**Caseta Pro coproc wire format equivalence**~~ — **Resolved**. See
   above + Ghidra confirmation 2026-04-29: hit counts for OTA constants
   (`21 2b`, `21 0e`, `21 0c`, `21 08`, `06 00`, `06 01`, `06 02`) are
   IDENTICAL across `phoenix_efr32_*.bin`, `caseta-ra2sel_efr32_*.bin`, and
   `lite-heron_efr32_*.bin` — confirming a unified codebase across
   RA3 / Caseta Pro / lite-heron bridge variants.
3. **PFF symmetric key** — encrypted payload, key burned in device bootloader at
   manufacture. Recovering it likely needs SWD/JTAG on a CCA device. Without it
   we can replay/relay but can't author firmware. (Note: PowPak HCS08 LDFs are
   plaintext — only EFR32 PFFs are encrypted. See [powpak.md](powpak.md).)
4. **`MinimumRevisions` semantics** — empty for all entries in current Caseta
   manifest; on Phoenix it gates app upgrades on boot version. May trigger boot
   image transfer in future bundles.

## Phoenix EFR32 coproc dispatcher RE (2026-04-29 partial pass, Ghidra)

Loaded `phoenix_efr32_8003000-803FF08.bin` (RA3 coprocessor, 249 KB) and
searched for the HDLC IPC opcode literals (16-bit LE, see
[OTAHdlcCmd](../../protocol/cca.protocol.ts) for the full table).

### Five OTA-related dispatcher functions

The OTA opcodes (`0x111` QueryDevice, `0x113` BeginTransfer, `0x115` TransferData,
`0x119` ChangeAddressOffset, `0x11b` EndTransfer, `0x11f` CodeRevision,
`0x121` ClearError) appear clustered as 16-bit immediates within five distinct
function regions:

| Region start | First-cmd literal | Notes |
|---|---|---|
| `0x080190a8` | BeginTransfer @ `0x080190b1` | Smallest cluster |
| `0x080192d4` | BeginTransfer @ `0x08019301` | Decompiled: builds an IPC-layer outgoing buffer with literals `0x20`, `0x09`, `0x02`, `0xFFFE` — likely the per-phase dispatcher that takes a high-level call and queues an IPC packet |
| `0x08019490` | BeginTransfer @ `0x08019551` | |
| `0x08019724` | BeginTransfer @ `0x080197a1` | Most opcodes referenced (also `0x11f` CodeRevision, `0x121` ClearError) |
| `0x080199d8` | BeginTransfer @ `0x080199f1` | Tiny wrapper, calls common `FUN_080075a4` |

These functions feed a common IPC TX path via `FUN_0801c7fc(channel, cmd, ...)`
or `FUN_0801c8b4(channel, cmd, ..., length)`. Each handler uses different
`(channel, cmd)` first-arg pairs (e.g. `(2, 2)`, `(6, 0x40)`, `(6, 0x43)`)
to route through the IPC framing.

### Constants NOT found in any coproc binary

Searched all three EFR32 coproc binaries (Phoenix, Caseta-RA2-Select, lite-heron):

- **`a1 ef fd`** (the on-air bridge addressing prefix): **0 occurrences** in any
  binary. **Conclusion**: this prefix is **runtime-computed from bridge
  commissioning state** (likely the bridge's House Code / CCA Network ID,
  written to non-volatile flash during manufacturing or initial setup). It is
  NOT a hardcoded literal.
- **`02 20 00 00 00 1F`** (the BeginTransfer payload observed on-air):
  **0 occurrences**. The payload bytes are constructed dynamically — the
  trailing `1F` is the chunk size constant, but the leading 5 bytes
  `02 20 00 00 00` come from arguments passed into the IPC opcode `0x2A`
  handler.

### Implication for synth-TX from Nucleo+CC1101

To replicate a valid OTA TX, the bridge addressing prefix must either be
captured from the target's existing bridge (a few seconds of sniffing reveals
it) or derived from a value the device pre-trusts. Since no PowPak-receive
code in the current RE pass shows a bridge-prefix validation step, this is
likely permissive — the device accepts any prefix, and the prefix is mainly
used for bridge-side ACK demultiplexing.

The BeginTransfer payload's leading 5 bytes (`02 20 00 00 00`) are the
remaining pinpoint question. Resolution requires tracing IPC opcode `0x2A`
argument flow from the host CPU through the coproc — start at the IPC RX
deframer (HDLC layer) and follow `cmd_id == 0x113` dispatch through to one
of the five dispatcher functions above.
