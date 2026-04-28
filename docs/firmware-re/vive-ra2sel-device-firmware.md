# Vive Hub & RA2 Select Device Firmware Inventory

End-device (`.pff`) firmware bundled in (or fetched by) the RA2 Select bridge and Vive Hub
processor rootfs trees. Reference baseline is the Caseta Pro / lite-heron drop at
`data/firmware/caseta-device/`.

## Summary

| Bridge | Bundles `.pff`? | Manifest? | Runtime fetch? | Notes |
|---|---|---|---|---|
| Caseta Pro / lite-heron | yes | yes | yes (replaces in-place) | reference baseline |
| **RA2 Select** (`v08.25.17f000`) | **yes** | **yes** | yes | byte-identical to Caseta Pro reference |
| **Vive Hub** (`v01.30.04`) | **no** | **no** | **no** | bridge does not OTA end devices |

## RA2 Select

Path: `caseta-ra2select/v08.25.17f000/rootfs/opt/lutron/device_firmware/`

- `device-firmware-manifest.json` (9 721 bytes) — `FirmwarePackageVersion: 001.003.004r000`
- `firmware/` — 9 `.pff` files, 15 manifest entries (some PFFs serve multiple device classes)
- Installed via opkg as `device-firmware` package (`/var/lib/opkg_device-firmware/`)
- Repo config: `/etc/opkg_device-firmware.conf` → `option_signature_ca_file /etc/ssl/firmwaresigning/public.pem`
- Production refresh URL is provided dynamically by the `sources` endpoint
  (see "CDN" below); package is downloaded as `lutron_device_firmware` to
  `/tmp/device_firmware/` and installed via `opkg`. Driven by
  `usr/sbin/device_firmware_download.sh` and `usr/sbin/firmwareUpgrade.sh`.

PFFs are **byte-identical** to the Caseta Pro reference set (same SHA-256 hashes, same sizes,
same `FirmwarePackageVersion`). RA2 Select therefore ships **no unique device firmware** —
it shares the Caseta Pro device firmware package wholesale. The Caseta Pro reference also
contains one extra file we did not see in the RA2 Select rootfs: `07911258_BASENJI_APP_RELEASE_v2.025.pff`
is present in RA2 Select; the file `07911258` shipped earlier in our Caseta Pro tree is
the same blob — there is no Vive/RA2-only firmware.

### Manifest mapping (RA2 Select == Caseta Pro)

| File | SHA-256 (first 12) | Size | Display Rev | Codename | Device Classes |
|---|---|---|---|---|---|
| `07910242_v2.05_CasetaDimmerApp.pff` | 6f6db786fa54 | 160 724 | 002.005.000r000 | CasetaDimmerApp | 0x04320501 |
| `07910820_BASENJI_APP_RELEASE_v2.015.pff` | 4d55b29fb501 | 209 444 | 002.015.000r000 | BASENJI | 0x03150101, 0x03160101 |
| `07911094_VogelkopFetDimmer_App_Release_v3.012.pff` | f0a084d876a3 | 195 044 | 003.012.000r000 | VogelkopFetDimmer | 0x04660201 |
| `07911256_EO_APP_RELEASE_v2.025.pff` | f85630e0cb1b | 172 660 | 002.025.000r000 | EO | 0x03120101, 0x03120102, 0x03120103 |
| `07911258_BASENJI_APP_RELEASE_v2.025.pff` | c15fd086d179 | 217 860 | 002.025.000r000 | BASENJI | 0x03150201, 0x03160201 |
| `07911260_BANANAQUIT_APP_RELEASE_v2.025.pff` | 73bca282fb85 | 220 116 | 002.025.000r000 | BANANAQUIT | 0x03090601, 0x030A0601, 0x03130601, 0x03140601 |
| `07911326_Antillean_App_Release_v1.001.pff` | 2f176aed13b8 | 167 300 | 001.001.000r000 | Antillean | (1, in extracted) |
| `07911506_v3.021_VogelkopDimmerAppCaseta.pff` | dc5325d2d84d | 187 060 | 003.021.000r000 | Vogelkop Dimmer Caseta | 0x04630201 |
| `07911507_v3.021_VogelkopSwitchAppCaseta.pff` | 84e07acc9fdb | 168 452 | 003.021.000r000 | Vogelkop Switch Caseta | 0x04640101 |

Copied to `data/firmware/ra2select-device/firmware/` for symmetry with `caseta-device/`.

## Vive Hub

Vive bridge **does not deploy end-device firmware**.

Evidence:

1. `find rootfs-full -name '*.pff'` → no hits.
2. `/etc/lutron.d/lutron-platform.conf` is missing every device-firmware key the
   RA2 Select / Caseta Pro images carry: no `FirmwareDownloadScript`, no
   `DeviceFirmwareDestinationPath`, no `DeviceFirmwareFile`,
   no `DeviceFirmwarePackageRepositoryUrlFile`,
   no `Sftp.DeviceFirmwarePackageDownload`, no `OpkgLibBaseDir`/`OpkgConfigBaseDir`
   keys. `device_firmware_download.sh` and the `opkg_device-firmware.conf` repo
   are not present.
3. The CDN bootstrap (`usr/sbin/curlscript.sh`) **is** present and identical to RA2
   Select, but the `firmwareUpgrade.sh` consumer is wired only for the rootfs
   processor package — not a device package. The `coproc_firmware_updater.pyc`
   only updates Vive's own coprocessor (CC-radio chip) using S-record (`.s19`)
   files passed via `lutron-coproc-firmware-update-app -f <file.s19>`, not `.pff`s.

In other words: Vive Hub manages association/level/scenes for end devices, but new
end-device firmware is delivered by a separate Lutron host system (the wired QSM
or RA-class host), not by the Vive Hub itself. This matches the
`project-designer-doesnt-ota-cca` memory note for Designer.

If the Vive Hub *did* support `.pff` deployment, it would need at minimum:
`/opt/lutron/device_firmware/`, `/etc/opkg_device-firmware.conf`, the
`device_firmware_download.sh` script, and the platform.conf keys. None of those
exist.

## CDN bootstrap (RA2 Select & Vive)

Both bridges share the same firmware bootstrap path:

- Production: `https://firmwareupdates.lutron.com/`
- Staging:    `https://firmwareupdates-staging.lutron.com/`
- Development:`https://firmwareupdates-dev.lutron.com/`

Endpoint pattern (POST):

- `<URL>/sources` — returns `{"Status":"ok","Url":"<processor-pkg-url>","DevicePackageUrl":"<device-pkg-url>"}`
- `<URL>/checkin` — health/state report

POST body fields (form-encoded): `username`, `password`, `macid` (eth0 MAC),
`deviceclass` (4-byte hex from on-board EEPROM), `coderev` (running rootfs
version), `datestamp` (EEPROM date code), `claimedstatus` (Claimed / Unclaimed,
from `/usr/lutron/mdnsHooks/01_claim_status.sh`), and on `checkin` also
`devicepackagerev` and `status`.

The username/password are baked into `usr/sbin/curlscript.sh` (basic auth between
unit and CDN). I declined to fetch with these credentials — a real probe would
need a valid `(macid, deviceclass, datestamp)` triple from a live unit. Trying
made-up values returns `404 Unknown device class`, so simply guessing classes
doesn't help. Vive Hub class is `0x08070101` (from `etc/lutron.d/eol.conf`).

To actually pull the live package: run the unit and capture the `sources` response
to discover the per-unit device-firmware repo URL, then `curl
<DevicePackageUrl>/lutron_device_firmware`. The result is an opkg `.ipk` whose
data archive contains the same `firmware/*.pff` + `device-firmware-manifest.json`
layout we already extracted from RA2 Select.

## Files staged

- `data/firmware/ra2select-device/firmware/*.pff` (9 files) — copied from
  `caseta-ra2select/v08.25.17f000/rootfs/opt/lutron/device_firmware/firmware/`
- `data/firmware/ra2select-device/device-firmware-manifest.json`

No new files were created for Vive — there is nothing to copy.
