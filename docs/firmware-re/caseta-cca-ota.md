# Caseta Bridge CCA OTA Orchestration

How the Caseta SmartBridge / RA2 Select bridge (L-BDG2-WH, deviceclass `080F0101`)
orchestrates CCA device firmware updates over 433 MHz. Static analysis only —
RF wire format byte still unknown, blocked on a live capture.

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

The CCA RF packet type byte for these phases is **not yet known** — coproc translates
abstract IPC into RF, and the byte values live in the coproc firmware (STM32), not
in `lutron-core`. The current Caseta coproc image isn't extracted in our tree (only
old `caseta-sb-0205/0210_stm32_*.s19` blobs in `data/firmware/caseta-device/coproc-old/`).

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

| Codename | Device classes | Files |
|---|---|---|
| BASENJI (Diva) | `0x03150101/0201`, `0x03160101/0201` | v2.015 + v2.025 |
| BANANAQUIT (plug-in / Maestro family) | `0x03090601`, `0x030A0601`, `0x03130601`, `0x03140601` | v2.025 |
| EO / eagle-owl | `0x03120101/0102/0103` | v2.025 |
| Vogelkop (high-end dimmer) | `0x04630201`, `0x04640101`, `0x04660201` | v3.012 + v3.021 |
| Antillean | (in firmware list, class TBD) | v1.001 |
| Caseta Dimmer (legacy) | `0x04320501` | v2.05 |

`EstimatedFastUploadTimeInSeconds: 1200` ⇒ **~20 min of RF per device**. Plan capture
buffer / streaming accordingly.

## .pff format (Pegasus Firmware Format)

Same container as CCX device firmware (per [coproc.md](coproc.md)):
- 8-byte header (Major/Minor 4 bytes each, big-endian)
- Encrypted payload (AES, per-device-model key burned at manufacture)
- Bridge does NOT decrypt — it ships the .pff bytes unmodified to the device
  bootloader, which decrypts in place

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

3. **Arm the openBridge** sniffer at 433.602844 MHz, FSK, set the channel to match
   the bridge's CCA link channel (per `addressing-mode-link-receiver` logs in
   lutron-core, channel and subnet address are stored in the runtime DB).
   Capture window ≥ 1500 s.

4. **Trigger** from SSH:
   ```sh
   /usr/sbin/platform_manager_wrapper.sh -p
   ```

5. **Tail logs** in parallel:
   ```sh
   tail -F /var/log/messages | grep -E "firmware-update|cca|coproc"
   ```

6. **Decode**: With the 8-phase vocabulary above, segment the capture by long
   inter-packet gaps (Reset/Query/BeginTransfer are sparse; TransferData is a long
   burst). Match phase boundaries to log timestamps to identify each phase's RF
   packet type byte. Once known, add to [protocols/cca.md](../protocols/cca.md).

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

1. **CCA RF packet type byte for OTA phases** — needs live capture (this experiment).
2. **PFF symmetric key** — encrypted payload, key burned in device bootloader at
   manufacture. Recovering it likely needs SWD/JTAG on a CCA device. Without it
   we can replay/relay but can't author firmware.
3. **Caseta coproc firmware location** — current STM32 coproc image isn't in the
   rootfs we have. Likely embedded in `lutron-coproc-firmware-update-app`'s
   `.rodata` (similar to Phoenix). Worth a follow-up extraction.
4. **`MinimumRevisions` semantics** — empty for all entries in current Caseta
   manifest; on Phoenix it gates app upgrades on boot version. May trigger boot
   image transfer in future bundles.
