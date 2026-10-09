# Shade firmware comparison — Caseta vs RA3

*Comparison of the shade-line device firmware carried by the Caseta hub (lite-heron) and the RA3
processor (Phoenix), from the public firmware CDN plus the live RA3 device dump. Companion to
[firmware-updates.md](../tooling/firmware-updates.md) (CDN/API and bundle format).*

- **Date**: 2026-10-06
- **Question**: are Caseta/Serena/Triathlon-line roller shades served *different* device firmware
  by the Caseta hub than by the RA3 processor?
- **Sources**:
  1. `https://firmware-downloads.iot.lutron.io/lite-heron/final/26.00.11f000/lutron_firmware`
     (Caseta hub bundle, 79 MB, HTTP 200, sha256 `d79fc6bd…`), downloaded 2026-10-06.
  2. Phoenix bundle `…/phoenix/final/26.06.47f000/lutron_firmware`.
  3. Live RA3 dump `/var/misc_unsynced/device_firmware/` (60 `.pff` files + manifest).

## 1. Bundle and key findings

- The lite-heron bundle is **the same container format** as Phoenix (ZIP → `firmware.tar.enc` +
  `key.tar` + `versionInfo`/`manifest`/`sigFiles`) and **decrypts with the same device key**
  (`6cba80b2…`): one symmetric bundle key across Phoenix (RA3/HWQSX) and lite-heron (Caseta).
- Same bootloader generation: SPL + U-Boot `2017.01.027` debs in both bundles.
- The Caseta hub rootfs `lutron-core` is a **smaller build of the same codebase** (11.5 MB vs 27 MB)
  and carries the same device-class gating strings as the Phoenix build
  (`ActivationDeviceClassChecksOverrideFlag`, `decorate device info with default properties`,
  `DeviceIsSupported`).
- **The shade device-firmware payload is shared byte-for-byte between the two product lines.**

## 2. Device-firmware manifest diff

`device-firmware-manifest.json` ships inside the bundle ZIP (cleartext), same schema on both.

| | Phoenix 26.06.47f000 | lite-heron 26.00.11f000 |
|---|---|---|
| `FirmwarePackageVersion` | `002.025.033r000` | `002.025.019r000` |
| Entries | 30 | 25 |

- **Classes only in Phoenix**: `0x06190301`, `0x061F0101`, `0x1B060301`, `0x1B080301`, `0x1B090101`.
- **Classes only in lite-heron**: none. Every Caseta class is also an RA3 class.
- For all classes present in both, App/Boot `Path`+`Sha256Hash` are compared:
  - **All five shade classes are IDENTICAL** (same path, same hash, same revision
    `002.026.000r000`): `0x03120101/02/03` → `cca/cca-eagle-owl-*`,
    `0x03140601` + `0x030A0601` → `cca/cca-bananaquit-avis-*`,
    `0x03150201` → `cca/cca-basenji-*`.
  - Keypad/dimmer/switch/bulb classes differ only by revision (Phoenix is newer: e.g. Sunnata
    `dart-rf-dimmer` `003.014.017r000` vs `003.014.003r000`); boot images mostly hash-identical.

Conclusion: **there is no separate "Caseta shade firmware".** The Caseta hub and the RA3 processor
serve the same `.pff` blobs to the same device classes; the Caseta hub just runs an older snapshot.

## 3. The `.pff` payloads and the live device

- All `.pff` (both `cca/` and `pegasus/` families) share one header:
  `00 00 00 01 00 00 00 01` then high-entropy ciphertext — one PFF container, encrypted body.
- The live RA3 carries the whole tree under `/var/misc_unsynced/device_firmware/`
  (60 `.pff` files, `cca/` + `pegasus/`); **every one hash-matches the manifest** (60/60).
  The full shade-line firmware set is therefore available offline from the dump alone — no per-file
  CDN fetch needed.
- SHA-256 prefixes (from the manifest, both bundles identical):
  - `cca-basenji-app …format-1.pff` = `B0989FD1…141F68C44637` (class `0x03150201`, Triathlon)
  - `cca-eagle-owl-app …format-1.pff` = `43A321F3…334BAD` (classes `0x03120101/02/03`)
  - `cca-bananaquit-avis-app …format-1.pff` = `667C3978…98DB` (classes `0x03140601`, `0x030A0601`)

## 4. Which class is which (live athena DB)

From `EnclosureDevice`/`ModelInfo` on the live device:

| Class | Model string | Count on live system | Identity |
|---|---|---|---|
| `0x03150201` | Triathlon Essentials Roller Shade | 13 | Triathlon Essentials (working) |
| `0x030A0601` | Roller Shade (battery powered) | 2 | **Sivoia QS Wireless** roller (physically confirmed, NOT Caseta-line) |
| `0x03070301` | RF QS Cellular Shade | 1 | RF QS Cellular |

- The generic DB model string "Roller Shade (battery powered)" is not a product identity: the two
  `0x030A0601` devices are **Sivoia QS Wireless** rollers (confirmed against the physical
  installation). Earlier notes elsewhere guessed it was "the Caseta-line roller" — **retracted**.
- What this table *does* establish: family `0x030A` (and by extension the battery-shade space
  `0x0306/07/09/0A/10–15`) is served natively on the RA3, and `0x030A0601` is OTA-hosted in both
  hubs' manifests (`cca-bananaquit-avis`).
- **Which class a Caseta-line retail shade (Serena / Triathlon Select / Caseta-branded roller)
  reports is still unknown from hub-side data.** No `eol.conf` entry and no DB row names the
  candidate classes; the SmartBridge doc's bird-name→class map (Bananaquit/Basenji assignments) does
  not survive contact with the live data and should be treated as unverified — it has since been
  corrected there. The test is empirical: with the RA3 in pairing mode, the device announces its
  class on the RF link (observe-only log capture — no write needed). A retail shade reporting
  `0x03150201` would behave identically to the 13 working rollers; the processor-side class checks
  are documented in [cca/pairing.md](../protocols/cca/pairing.md).

## 5. Delivery path (device OTA)

- Device firmware arrives via **opkg** (`/etc/opkg_device-firmware.conf`): dest
  `/var/firmware/device-firmware/`, signature checked against the same
  `/etc/ssl/firmwaresigning/public.pem` as the processor feed.
- `usr/sbin/fwu_check_and_download.sh` takes `-p <processor repo>` / `-d <device repo>`; when not
  given, both come from the same `curlscript.sh sources` POST
  (`firmwareupdates.lutron.com/sources`, class-keyed) which returns **two** repo addresses.
  The device URL is cached to the path named by platform config key
  `DeviceFirmwarePackageRepositoryUrlFile`.

## 6. Open items

- `.pff` body encryption: per-model AES key (believed burned into the shade bootloader) — the
  processor never decrypts, so the key is not in the RA3 rootfs; extracting a shade's key requires
  shade-side work (SWD/bootloader), out of scope for the hub-side effort.
- Map `0x03120101/02/03` (eagle-owl) and `0x03140601` (bananaquit) to retail product names
  (Triathlon *Select*? Serenawood?) — needs a product-name source (Designer CIL or marketing SKU
  table), not present in the hub binaries.
- Caseta hub `lutron-core`: the same gating strings are present, but the discovery path has not been
  traced on that build — open whether the Caseta-side trace adds anything to the Phoenix result.

*CDN fetches were of known, documented bundle objects only; no device or cloud write/contact.*