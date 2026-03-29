# Lutron Firmware CDN Reverse Engineering

Date: 2026-03-29

## CDN Infrastructure

All Lutron firmware is served from S3 via CloudFront:
```
firmware-downloads.iot.lutron.io
```
No directory listings. No authentication required. Products are organized by path prefix.

## Vive Hub Firmware

### Discovery

`https://www.lutron.com/vivehubsoftware` redirects (301) to the latest firmware:
```
https://firmware-downloads.iot.lutron.io/vive/Release/vive-hub-v01.30.04f000.vive
```

The release notes PDF (`https://assets.lutron.com/a/documents/vive_hub_software_release_notes.pdf`) lists all versions from 1.11 through 1.30.

### URL Pattern
```
https://firmware-downloads.iot.lutron.io/vive/Release/vive-hub-v{MM.mm.ppf000}.vive
```

### Available Versions (as of 2026-03-29)

Only 4 versions survive on the CDN — Lutron removes older releases:

| Version | Last-Modified | Size | Notes |
|---------|--------------|------|-------|
| 01.30.04f000 | 2026-02-05 | 126 MB | Latest (linked from lutron.com) |
| 01.29.02f000 | 2025-12-04 | 118 MB | |
| 01.26.05f000 | 2025-06-04 | 117 MB | |
| 01.24.07f000 | 2025-03-11 | 117 MB | Oldest available |

Versions 1.23.x and earlier: 404. Lutron retains approximately 4 recent releases.

### Firmware Archive Format (.vive)

ZIP archive containing:

```
EULA                    — License agreement (HTML)
EULA.zip                — Compressed copy of EULA
firmware.tar.enc        — AES-128-CBC encrypted tar (bulk payload, ~117-126 MB)
key.tar/
  key.enc               — 512-byte RSA-encrypted AES-128 key (4096-bit RSA)
  algorithm             — Plaintext string: "-aes-128-cbc"
manifest                — SHA-256 hashes of all files
manifest.sig            — PKCS7 signature (2015 cert, expired 2018)
sigFiles/manifest_2.sig — PKCS7 signature (2017 cert, valid to 2117)
versionInfo             — Version string (e.g. "01.30.04f000")
```

### Encryption Chain (BROKEN — fully decryptable)

1. `firmware.tar.enc` is encrypted with AES-128-CBC (OpenSSL `Salted__` format, MD5 KDF)
2. The AES passphrase is RSA-**signed** (not encrypted) → `key.enc` (512 bytes)
3. The device recovers the passphrase using the RSA **public** key via `openssl pkeyutl -verifyrecover -pubin`
4. The public keys are on the device at `/etc/ssl/firmwareupgrade/{primary,secondary}.pub`

The critical design flaw: Lutron used RSA signing (`-verifyrecover`) instead of RSA encryption.
The "decryption" key is the **public** key, which ships on every device. Anyone with the public
key can recover the AES passphrase and decrypt the firmware.

To decrypt:
```
# 1. Recover AES passphrase from key.enc using the device's PUBLIC key (4096-bit RSA)
openssl pkeyutl -verifyrecover -pubin \
  -inkey /etc/ssl/firmwareupgrade/primary.pub \
  -in key.enc -out symkey.bin

# 2. Decrypt firmware tar (must use -md md5 for old OpenSSL KDF compatibility)
openssl enc -d -aes-128-cbc -md md5 \
  -in firmware.tar.enc -pass file:symkey.bin \
  -out firmware.tar
```

### Decrypted Contents (v01.30.04f000)

The decrypted `firmware.tar` is a Debian apt repo:

| File | Size | Description |
|------|------|-------------|
| `rootfs-01.30.04f000.deb` | 117 MB | Full Linux rootfs (Timesys LinuxLink) |
| `kernel-5.10.001.deb` | 3.7 MB | Linux 5.10 kernel |
| `uboot-2017.01.027.deb` | 152 KB | U-Boot bootloader |
| `spl-2017.01.027.deb` | 36 KB | U-Boot SPL |
| `Packages.gz` / `Packages.sig` | — | APT metadata + signature |

The rootfs contains the complete Vive Hub system: `lutron-core`, `leap-server.gobin`,
`lutron-web-app.gobin`, `lutron-cci-engine`, OpenADR and BACnet users, Python 3.8, etc.

### Signing Certificates

Both signatures use the same Lutron "Caseta Wireless" PKI:

**manifest.sig** (first cert):
- Issuer/Subject: `C=US, ST=PA, L=Coopersburg, O=Lutron Electronics Co Inc, OU=Caseta Wireless`
- Serial: varies
- Valid: 2015-05-26 to 2018-05-25 (expired — signature still accepted)

**manifest_2.sig** (second cert):
- Same issuer/subject
- Valid: 2017-12-21 to **2117-11-27** (100-year validity)
- This is the active signing cert, also found at:
  `etc/ssl/firmwaresigning/public.pem` in the Caseta SmartBridge rootfs

## Connect Bridge Firmware ("Connect")

**IMPORTANT:** "Connect" is NOT the Caseta SmartBridge. The Connect Bridge (L-BDG2-WH)
is a separate product that adds smart home integration (HomeKit, LEAP API, remote access)
to existing Homeworks (HW) and RadioRA 2 (RA2) systems. It bridges the older CCA-only
systems to IP/cloud. Same AM335x hardware platform as Caseta but different firmware and
different product role.

### Discovery

Found via Wayback Machine CDX API — indexed in January 2022.

### URL Pattern
```
https://firmware-downloads.iot.lutron.io/connect/alpha/{version}/
```

### Available Version

Only one version was indexed and is **still live**:

| File | Size | Description |
|------|------|-------------|
| `Packages.gz` | 1,595 | APT package manifest |
| `Packages.sig` | 2,361 | Manifest signature |
| `rootfs-05.01.01a000.deb` | 31.5 MB | Root filesystem |
| `kernel-4.4.001.deb` | 2.98 MB | Linux kernel image |
| `uboot-2013.07.020.deb` | 117 KB | U-Boot bootloader |
| `spl-2013.07.020.deb` | 17 KB | U-Boot SPL |

### Package Format

Standard Debian `.deb` packages (ar archive → control.tar.gz + data.tar.gz).
The rootfs .deb contains a `rootfs.tar.gz` inside `data.tar.gz` — the full Linux root filesystem.

**No encryption. No authentication.** Direct download over HTTPS.

### Firmware Update Mechanism

The bridge uses `opkg` (embedded package manager) with the CDN as an APT repo:
1. Bridge POSTs to `https://firmwareupdates.lutron.com/sources` with MAC, device class, version, date code
2. Server responds with the CDN URL for the correct firmware channel
3. Bridge runs `opkg update && opkg list-upgradable && opkg install rootfs`
4. New rootfs is written to the inactive UBI partition (A/B scheme)
5. EEPROM boot flag is flipped, system reboots

Hardcoded update credentials: `username=lutron-bridge password=Lutr0n@1`

Firmware update server endpoints:
- `https://firmwareupdates.lutron.com/sources` — returns CDN repo URL
- `https://firmwareupdates.lutron.com/checkin` — status reporting
- Dev: `https://firmwareupdates-dev.herokuapp.com/`
- Staging: `https://firmwareupdates-staging.herokuapp.com/`

Unit type is read from EEPROM: `0x5A` = dev, `0xA5` = staging, else production.

### Key Rootfs Contents

**Authentication:**
- `root::0:0::/root:/bin/sh` — root has no password
- `etc/passwd` — no shadow file (passwords in passwd or empty)
- `home/support/.ssh/authorized_keys` — Lutron employee key (`abhat@PC0008690`)

**TLS/Crypto:**
- `etc/ssl/private/smartbridge.key` — RSA 2048-bit private key for TLS
- `etc/ssl/certs/smartbridge.pem` — TLS cert (CN=updatecaseta-dev.intra.lutron.com, expired 2018)
- `etc/ssl/firmwaresigning/public.pem` — firmware signing cert (same as Vive manifest_2.sig)
- `usr/share/lap-certs/connectBridge.pem` — EC P-256 private key for LAP server
- `usr/share/lap-certs/connectBridgeLapServer.crt` — LAP server certificate
- `usr/share/lap-certs/connectLapCa.crt` — Mobile app CA root of trust
- `usr/share/lap-certs/lutronIntegratorProgramCa.crt` — Integrator program CA
- `usr/share/lap-certs/lutronResiGuiCa.crt` — Residential GUI CA

**Configuration:**
- `etc/lutron.d/lutron.conf` — main config (DB paths, hardware interface, socket paths)
- `etc/lutron.d/external_protocols.conf` — LEAP/LAP/LIP/HAP/Sonos/MQTT/RemoteAccess config
- `etc/opkg.conf` — package manager config (signature verification enabled)
- Hardware interface: `/dev/ttyO1` at 115200 baud (CC110L radio UART)

**Binaries (ARM, unstripped):**
- `usr/sbin/multi-server-connect.gobin` (15 MB) — main Go server (LEAP, LAP, LIP, HAP, MQTT)
- `usr/sbin/lutron-core-client` (278 KB) — native core client
- `usr/sbin/lutron-button-engine` (162 KB) — button/pico event processor
- `usr/sbin/lutron-eeprom-engine` (113 KB) — EEPROM read/write daemon
- `usr/sbin/lutron-led-ui` (256 KB) — LED indicator controller
- `usr/sbin/lutron-eol` (927 KB) — end-of-line test tool
- `usr/sbin/internet-connectivity-monitor.gobin` (2.9 MB) — connectivity watchdog

**Network Ports (from external_protocols.conf):**
- LEAP: TCP 8089 (plaintext localhost), TLS 8090
- LAP: TLS 8083
- LIP: TCP 8080 (plaintext localhost), TLS 8081
- HAP (HomeKit): TCP 4548
- Sonos: UDP 7782

## RadioRA 3 Processor Firmware ("Phoenix")

### Discovery

Over 200 version directories found via Wayback Machine CDX API, spanning:
- `phoenix/beta/01.01.24b005` (pre-release)
- `phoenix/final/21.01.07f000` through `phoenix/final/22.07.12f000`

### URL Pattern
```
https://firmware-downloads.iot.lutron.io/phoenix/{channel}/{version}/
  channel: "final" (production) or "beta" (pre-release)
```

### Current Status

- **`Packages.gz` and `Packages.sig`**: Still live (HTTP 200) for all 200+ indexed versions
- **Actual `.deb` files** (rootfs, kernel, uboot, spl): All removed (HTTP 404)
- Same package structure as Caseta: kernel, rootfs, uboot, spl

Lutron deletes `.deb` files from S3 after the update window. The `Packages.gz` metadata persists
as a stub. No encrypted alternatives (`.enc`, `.vive`) exist at the phoenix path. The processor
downloads debs transiently during firmware updates; they're removed afterward.

The `Packages.sig` uses a **different signing cert** than Caseta/Vive:
`OU=Phoenix Processors` (vs `OU=Caseta Wireless`), valid 2020-02-13 to 2120-01-20.

### Firmware Update Server

`firmwareupdates.lutron.com` is a **Django** application. Known endpoints:
- `POST /sources` — returns CDN repo URL (no CSRF required)
- `POST /checkin` — status reporting (no CSRF required)
- `POST /download` — exists but requires Django CSRF cookie+token (device/admin use?)
- `GET /` `/version` `/health` `/status` `/firmware` `/api` `/api/v1` `/api/v2` — all return `{"Status": "200 OK", "Message": ""}`

### RA3 Firmware is on the CDN (and inside Designer MSIX)

Decompiling `Lutron.Gulliver.Infrastructure.dll` (via ilspycmd) revealed the download URL.
`FirmwareFileProvider.DownloadFileFromUrl()` constructs: `{repoUrl}/lutron_firmware`

```
https://firmware-downloads.iot.lutron.io/phoenix/final/26.01.13f000/lutron_firmware   (101 MB, RA3)
https://firmware-downloads.iot.lutron.io/phoenix/final/26.00.14f000/lutron_firmware   (99 MB, RA3 staged)
https://firmware-downloads.iot.lutron.io/lite-heron/final/26.00.12f000/lutron_firmware (78 MB, CCX-only proc)
```

All **live, no auth required**. Same file also in the MSIX at
`QuantumResi/BinDirectory/Firmware/phoenix/lutron_firmware` (SHA-256 verified identical).

This is a 101 MB ZIP containing:
```
device-firmware-manifest.json  — CCX device firmware manifest (FirmwarePackageVersion 002.025.024r000)
firmware.tar.enc               — AES-128-CBC encrypted tar (processor OS + CCX .pff files)
key.tar/
  key.enc                      — 64-char base64 passphrase (48 bytes decoded)
  iv.hex                       — Explicit IV: a789e29c032f7c9bfcfca42a6d826c53
  algorithm                    — "-aes-128-cbc"
  message_digest               — "md5"
EULA, EULA.zip
manifest, sigFiles/manifest_2.sig
versionInfo                    — "26.01.13f000"
```

**Different encryption from Vive Hub:**
- Vive: `key.enc` is 512 bytes, RSA-signed, recovered with 4096-bit public key + `pkeyutl -verifyrecover`
- RA3: `key.enc` is 64 bytes (base64 passphrase), includes explicit `iv.hex` and `message_digest`
- RA3 uses a **different keypair** — the Vive/RR-SEL-REP2 `primary.pub` does NOT decrypt RA3 firmware
- The RA3 processor has its own `/etc/ssl/firmwareupgrade/primary.pub` — needed to decrypt

**Signing cert is different too:** OU=Phoenix Processors (vs OU=Caseta Wireless for Vive).

### Firmware Delivery Model

Designer does NOT download individual `.deb` files from the CDN. The flow is:

1. `Packages.gz` on CDN is used **only** for version checking (opkg `list-upgradable`)
2. The encrypted `lutron_firmware` ZIP is bundled inside the Designer MSIX (or downloaded via `api.iot.lutron.io/api/v1/deploy` with OAuth)
3. Designer pushes the encrypted ZIP to the processor via LEAP
4. Processor runs `firmwareValidation.sh` → `decryptFile.sh` → `firmwareUpgrade.sh`
5. Decrypted `firmware.tar` contains `.deb` packages installed via opkg from local path
6. Individual `.deb` files **never exist on the CDN**

### CCX Device Firmware (Sunnata/Darter)

The `device-firmware-manifest.json` inside the ZIP maps device classes to `.pff` (Pegasus Firmware Format) files:
- `0x1B010101` — Pegasus bulb (app: 003.011.023r001, boot: 002.000.005r000)
- `0x1B030101` — Pegasus downlight
- Plus entries for all CCX device types (dimmers, switches, keypads, sensors, etc.)
- These `.pff` files are INSIDE `firmware.tar.enc` — need decryption to access

### To Decrypt RA3 Firmware

Need the RA3 processor's `/etc/ssl/firmwareupgrade/primary.pub`. Options:
1. **UART access** to the RA3 processor (if debug port is exposed like RR-SEL-REP2)
2. **SSH with correct key** — RA3 has SSH open but requires pubkey auth (no password)
3. **LEAP API** — check if `/firmware` or file-read endpoints can expose the key

### Version Evolution

From the `Packages.gz` metadata across versions:

| Component | Earliest | Latest | Notes |
|-----------|----------|--------|-------|
| rootfs | 21.01.07f000 | 22.07.12f000 | 69 MB at latest |
| kernel | 4.4.001 | 4.4.001 | Same kernel throughout |
| uboot | 2017.01.010 (beta) | 2017.01.017 | Upgraded from .011 to .017 |
| spl | 2017.01.010 (beta) | 2017.01.017 | Matches uboot |

The Phoenix (RA3) processor uses the same AM335x + Linux architecture as the Connect Bridge but with newer U-Boot and larger rootfs (~55-69 MB vs ~31 MB).

## Firmware Update Server Enumeration

### Server API

`https://firmwareupdates.lutron.com/sources` accepts POST with:
- `username=lutron-bridge`, `password=Lutr0n@1` (hardcoded, same for all products)
- `macid` — not validated (dummy `CC:CC:CC:CC:CC:CC` works)
- `deviceclass` — 8-hex-digit device class ID (this selects the firmware)
- `coderev` — current version (use `01.01.00a000` to always get latest)
- `datestamp` — EEPROM date code

Response: `{"Status": "200 OK", "Url": "<CDN repo URL>"}`

### Discovered Device Classes → Firmware URLs

| Device Class | Product | Firmware URL / Codename |
|-------------|---------|------------------------|
| `08070101` | Early Vive Hub prototype | `s3.amazonaws.com/vive-hub/00.03.00a002` |
| `08100101` | RA3/HWQSX variant | `phoenix/final/26.01.13f000` |
| `08110101` | **RA3 Processor** | `phoenix/final/26.01.13f000` |
| `08120101`–`08190101` | RA3 variants | `phoenix/final/26.01.13f000` (shared) |
| `080E0101` | **Caseta SmartBridge** | `caseta.s3.amazonaws.com/02.08.00f000` |
| `080F0101` | **Caseta / RA2 Select bridge** | `caseta-ra2select/final/08.25.17f000` |
| `08200101` | **Caseta Pro / "lite-heron"** | `lite-heron/final/26.00.12f000` |

Not found: `08030101` (older Caseta uses different update path via `curlscript.sh`).

The server performs **staged rollout** — different `coderev` values get different firmware URLs.
Reporting `25.00.00f000` returns `26.00.14f000`, while `01.01.00a000` gets `26.01.13f000`.

Full fuzz of 1050 device classes (`00000101`–`20500101`) confirmed only category `08` (processors/hubs)
has HTTP-delivered firmware. All other device types (dimmers, shades, sensors, keypads) receive
firmware over CCA radio from the processor, not via HTTP.

### Product Codenames

| Codename | Product | CDN Path | Notes |
|----------|---------|----------|-------|
| `connect` | Connect Bridge (HW/RA2 HomeKit bridge) | `connect/alpha/` | Unencrypted .debs |
| `phoenix` | RA3 / HWQSX Processor | `phoenix/final/` | Unencrypted .debs (purged) |
| `lite-heron` | Caseta Pro | `lite-heron/final/` | .debs purged, Packages.gz live |
| `vive` | Vive Hub (production) | `vive/Release/` | Encrypted .vive archives |
| `vive-hub` (S3) | Vive Hub (prototype) | `s3.amazonaws.com/vive-hub/` | Unencrypted .debs, 2016 |
| `caseta` (S3) | Caseta SmartBridge (080E0101) | `caseta.s3.amazonaws.com/` | Unencrypted .debs, v02.08.00 |
| `caseta-ra2select` | Caseta / RA2 Select bridge (080F0101) | `caseta-ra2select/final/` | Unencrypted, v08.25.17, Linux 5.10 |

## Vive Hub Prototype (2016, device class 08070101)

An early prototype firmware on a **separate public S3 bucket** (`s3.amazonaws.com/vive-hub/`):
- Version `00.03.00a002`, dated January 4, 2016
- Described as "Ethernet Bridge" (pre-Vive branding)
- **No encryption, no signing** — no `firmwaresigning/` or `firmwareupgrade/` directories
- Linux 3.12, U-Boot 2013.07, BusyBox
- Includes Python 2.7 and Ruby 2.1
- Root passwordless, same opkg update mechanism
- All `.deb` packages still downloadable

## Cross-Product Observations

### Shared PKI
All three products (Vive, Connect Bridge, RA3) use the same "Caseta Wireless" signing certificate infrastructure. The firmware signing cert from the Connect Bridge rootfs matches the Vive firmware signature.

### Architecture Pattern
All products follow the same ARM Linux + A/B partition update pattern:
- AM335x SoC (TI Sitara)
- Linux 3.12 (2016 proto) → 4.4 (Connect Bridge/RA3) → 5.10 (Vive Hub/RA3 v26+)
- U-Boot bootloader (2013.07 → 2017.01)
- UBI/UBIFS (Connect Bridge) or ext4 (Vive Hub) root filesystem with dual partitions
- EEPROM-based boot partition selection
- opkg package manager with signed repos

### Firmware Server
`https://firmwareupdates.lutron.com/` serves as the update orchestrator for all products. Devices POST their MAC, device class, and version; the server responds with the appropriate CDN URL.

## Files Saved

All downloaded firmware is in `data/firmware/` (gitignored):

```
data/firmware/
├── vive/
│   ├── vive-hub-v01.30.04f000.vive    — Latest Vive firmware (121 MB)
│   ├── vive-hub-v01.24.07f000.vive    — Oldest available (112 MB)
│   ├── v01.30.04-extracted/           — Extracted metadata from latest
│   │   ├── EULA, manifest, manifest.sig, versionInfo
│   │   ├── key.tar (key.enc + algorithm)
│   │   └── sigFiles/manifest_2.sig
│   └── v01.30.04-rootfs/             — Key files from decrypted rootfs
│       ├── etc/ssl/                   — Certs, keys, firmware upgrade pubkeys
│       ├── etc/lutron.d/              — Lutron service configuration
│       ├── etc/passwd, opkg.conf
│       └── usr/sbin/                  — Firmware upgrade/decrypt scripts
├── vive-prototype/
│   ├── rootfs-00.03.00a002.deb        — 2016 prototype rootfs (43 MB, unencrypted)
│   ├── kernel-3.12.002.deb            — Linux 3.12 kernel
│   ├── uboot-2013.07.001.deb          — U-Boot
│   └── spl-2013.07.001.deb            — SPL
└── caseta/                            — ACTUALLY Connect Bridge firmware (not Caseta SmartBridge)
    ├── caseta-rootfs-05.01.01a000.deb — Full rootfs package (30 MB) [misnamed, is Connect Bridge]
    ├── caseta-kernel-4.4.001.deb      — Linux kernel (2.8 MB)
    ├── caseta-uboot.deb               — U-Boot (115 KB)
    ├── caseta-spl.deb                 — SPL (17 KB)
    ├── connect-packages.txt           — APT manifest
    └── rootfs/                        — Extracted key files from rootfs
        ├── etc/ssl/                   — Certs, keys, firmware signing
        ├── etc/lutron.d/              — Lutron service configuration
        ├── etc/passwd, opkg.conf
        ├── usr/share/lap-certs/       — LAP/LEAP certificates and keys
        ├── usr/sbin/                  — Firmware upgrade scripts
        └── home/support/              — SSH keys
```

## Next Steps

1. **Probe firmwareupdates.lutron.com**: POST to `/sources` with spoofed MAC/device class to get CDN URLs for other products (RA3, Homeworks QSX).
2. **Analyze Vive Hub Go binaries**: `leap-server.gobin`, `lutron-web-app.gobin` contain the LEAP and web UI implementations. Decompile with Ghidra or `go tool objdump`.
3. **Analyze Connect Bridge Go binaries**: `multi-server-connect.gobin` (15 MB) is the combined server.
4. **Compare rootfs across products**: Diff Connect Bridge (v05.01.01), RR-SEL-REP2, and Vive Hub (v01.30.04) configs, certs, and binaries.
5. **Decrypt older Vive versions**: Apply same `primary.pub` key to v01.24.07 firmware to check for weaker security in earlier releases.
6. **Wayback Machine**: Try fetching cached copies of Phoenix .deb files via `web.archive.org/web/*/firmware-downloads.iot.lutron.io/phoenix/final/*/rootfs-*.deb`.
