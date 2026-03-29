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

## Caseta SmartBridge Firmware ("Connect")

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

- **`Packages.gz` and `Packages.sig`**: Still live (HTTP 200) for all indexed versions
- **Actual `.deb` files** (rootfs, kernel, uboot, spl): All removed (HTTP 404)
- Same package structure as Caseta: kernel, rootfs, uboot, spl

### Version Evolution

From the `Packages.gz` metadata across versions:

| Component | Earliest | Latest | Notes |
|-----------|----------|--------|-------|
| rootfs | 21.01.07f000 | 22.07.12f000 | 69 MB at latest |
| kernel | 4.4.001 | 4.4.001 | Same kernel throughout |
| uboot | 2017.01.010 (beta) | 2017.01.017 | Upgraded from .011 to .017 |
| spl | 2017.01.010 (beta) | 2017.01.017 | Matches uboot |

The Phoenix (RA3) processor uses the same AM335x + Linux architecture as Caseta but with newer U-Boot and larger rootfs (~55-69 MB vs ~31 MB).

## Cross-Product Observations

### Shared PKI
All three products (Vive, Caseta, RA3) use the same "Caseta Wireless" signing certificate infrastructure. The firmware signing cert from the Caseta rootfs matches the Vive firmware signature.

### Architecture Pattern
All products follow the same ARM Linux + A/B partition update pattern:
- AM335x SoC (TI Sitara)
- Linux 4.4 kernel (Caseta/RA3) or 5.10 (Vive Hub)
- U-Boot bootloader
- UBI/UBIFS (Caseta) or ext4 (Vive Hub) root filesystem with dual partitions
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
└── caseta/
    ├── caseta-rootfs-05.01.01a000.deb — Full rootfs package (30 MB)
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
3. **Analyze Caseta Go binaries**: `multi-server-connect.gobin` (15 MB) is the combined server.
4. **Compare rootfs across products**: Diff Caseta (v05.01.01), RR-SEL-REP2, and Vive Hub (v01.30.04) configs, certs, and binaries.
5. **Decrypt older Vive versions**: Apply same `primary.pub` key to v01.24.07 firmware to check for weaker security in earlier releases.
6. **Wayback Machine**: Try fetching cached copies of Phoenix .deb files via `web.archive.org/web/*/firmware-downloads.iot.lutron.io/phoenix/final/*/rootfs-*.deb`.
