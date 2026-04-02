# RadioRA 2 Select Repeater (RR-SEL-REP2) Reverse Engineering

## Hardware

Identical to Caseta Ethernet Bridge (Lutron "Sandwich Tern" platform):

| Component | Part | Role |
|-----------|------|------|
| Main SoC | TI AM335X-GP | Linux host, LEAP server |
| RAM | 256 MiB DDR | |
| Storage | NAND flash (UBI/UBIFS) | 12 MTD partitions |
| Radio MCU | STM32L100 (Cortex-M3) | CCA coprocessor, dual CC110L |
| Radio | 2x CC110L | 433 MHz CCA TX/RX |
| Ethernet | 100baseTX | `eth0`, MAC E8:EB:11:xx:xx:xx |
| EEPROM | On I2C-1 (MFI addr 17) | Config storage |

## Debug Interfaces

- **AM335x UART**: `/dev/ttyO0` @ 115200 → root shell, no auth, no password
- **STM32 SWD**: Unlabeled pads (SWD enabled in firmware, RDP likely level 0)
- **Coprocessor UART**: `/dev/ttyO1` @ 115200 (HDLC protocol, owned by `lutron-core`)

## Software

- **OS**: Linux 3.12.10 (armv7l), BusyBox v1.20.2 (2017-08-30)
- **OpenSSH**: 6.4p1 (no Ed25519 support — needs RSA keys, `PubkeyAcceptedAlgorithms=+ssh-rsa`)
- **Root filesystem**: UBI on NAND (`ubi0:rootfs`), read-write
- **Database version**: 199 (Kyle Barco, 2017-08-15, "Added the Fan Speed Control")

### NAND Flash Layout (MTD)

| Partition | Offset | Size | Purpose |
|-----------|--------|------|---------|
| mtd0-3 | 0x00000000 | 128KB × 4 | SPL copies |
| mtd4-5 | 0x00080000 | 1MB × 2 | U-Boot + backup |
| mtd6 | 0x00280000 | 128KB | U-Boot environment |
| mtd7-8 | 0x002A0000 | 5MB × 2 | Kernel + backup |
| mtd9-10 | 0x00CA0000 | 512KB × 2 | Device tree + backup |
| mtd11 | 0x00DA0000 | 242MB | RFS (UBI volume) |

### Key Binaries

| Binary | Size | Location | Purpose |
|--------|------|----------|---------|
| `lutron-core` | 5.7 MB | `/usr/sbin/` | CCA protocol engine (C++) |
| `leap-server.gobin` | 13.7 MB | `/usr/sbin/` | LEAP API server (Go) |
| `lutron-coproc-firmware-update-app` | 1.5 MB | `/usr/sbin/` | STM32 firmware flasher |
| `lutron-button-engine` | 163 KB | `/usr/sbin/` | Physical button handler |
| `lutron-eeprom-engine` | 111 KB | `/usr/sbin/` | EEPROM manager |
| `lutron-led-ui` | 154 KB | `/usr/sbin/` | LED control |
| `lutron-integration` | 499 KB | `/usr/sbin/` | Integration protocol (Telnet) |
| `lutron-eol` | 876 KB | `/usr/sbin/` | End-of-line test |
| `c4-sddp-server` | 24 KB | `/usr/sbin/` | Control4 SDDP discovery |
| `internet-connectivity-monitor.gobin` | — | `/usr/sbin/` | Connectivity monitor (Go) |

### Databases

| Database | Size | Purpose |
|----------|------|---------|
| `lutron-db-default.sqlite` | 966 KB | Default schema with device whitelist |
| `lutron-db.sqlite` | 966 KB | Active database |
| `lutron-platform-db-default.sqlite` | 10 KB | Platform config |
| `lutron-runtime-db.sqlite` | 20 KB | Runtime state |

### SSL / Authentication

| File | Purpose |
|------|---------|
| `/etc/ssl/certs/smartbridge.pem` | Device TLS certificate |
| `/etc/ssl/private/smartbridge.key` | Device TLS private key |
| `/usr/share/lap-certs/casetaLocalAccessProtocol.crt` | LAP CA certificate |
| `/usr/share/lap-certs/casetaSmartBridge.pem` | LAP device key |
| `/usr/share/lap-certs/casetaSmartBridgeSignedByLutron.crt` | LAP device cert (signed by Lutron) |
| `/etc/ssl/firmwaresigning/public.pem` | Firmware signing verification key |
| `/root/.Remoteaccesskey/` | Remote access keypair |
| `/var/misc/auth/.HapKeys/` | HomeKit accessory keys |
| `/var/misc/auth/.srp/` | SRP authentication (salt + verifier) |

## Coprocessor Firmware

The `lutron-coproc-firmware-update-app` embeds an obfuscated S19 firmware image:

- **Cipher**: Rotating printable-ASCII Caesar cipher with per-line key reset at 0
  - `decoded = ((byte - 0x20) + (95 - key)) % 95 + 0x20`
  - Key starts at 0 for each line, advances for each printable byte
  - **Different from Vive** which used continuous key with seed `0x5859 % 95 = 7`
- **Content**: Only 257 S-records, 4112 bytes across 4 address segments — this is a **configuration/calibration table**, not the full firmware
- **Address segments**:
  - `0x00003310-0x0000FCF0`: 1104 bytes (RAM/config)
  - `0x00010028-0x0001ECB0`: 1280 bytes (RAM/config)
  - `0x08003434-0x0800FE54`: 1120 bytes (Flash app area)
  - `0x08010404-0x08018240`: 608 bytes (Flash app area)
- **Full firmware dump requires SWD** — the app only carries a partial update
- **Version marker**: `/etc/lutron.d/lutron.079` contains `07030408B435`
- **Interesting**: Help text references `SB_EFR_128K_00.00.03.s19` — EFR32 firmware filename

## CCA Link Type Analysis

### System Identity

| Property | RR-SEL-REP2 | Vive Hub |
|----------|-------------|----------|
| SystemType | Smart Bridge (bridge) | Smart Bridge (bridge) |
| DeviceClass | `0x08040100` (Smart Bridge 2) | `0x08070101` (Vive Premium Hub) |
| Active LinkType | **9** (Clear Connect Link) | **30** (Vive Clear Connect Link) |
| lutron-core identity | "Smart Bridge core application" | "Vive core application" |
| SDDP type | `lutron_ra2_select_repeater` | — |
| mDNS | `_hap._tcp` (HomeKit) | — |
| Max devices | 40 | 700 |
| Max zones | 50 | — |
| BusinessRulesInfoID | 3 | 6 |

### Cross-Pairing Barriers

The CCA radio protocol is **100% identical** between all systems. Cross-pairing is blocked by **three software layers**:

#### 1. Link Type (beacon packet filter)

The `LinkType` table defines 30 link types. Only two are wireless CCA:
- **Type 9**: "Clear Connect Link" — Caseta, RA2 Select, RadioRA 2
- **Type 30**: "Vive Clear Connect Link" — Vive only

The `Link` table in each system's DB points to its link type:
- RR-SEL: `Link.LinkTypeID = 9`
- Vive: `Link.LinkTypeID = 30`

**This is the byte in the CCA beacon packet** that prevents cross-system discovery.

#### 2. Device Whitelist (SupportedDevices view)

The `DeviceSupportedLinkTypes` table controls which devices each system accepts:

**Shared devices (work on both type 9 and 30)**:
- All Pico remotes (1-button through 4-button)
- Radio Powr Savr occupancy/daylight sensors
- Hubbell H-MOSS receptacle

**Caseta/RA2 Select exclusive (type 9 only)**:
- All Caséta dimmers/switches (in-wall, plug-in, pro)
- Sivoia/Serena shades
- RadioRA 2 Maestro dimmers/switches
- Wireless Repeater
- seeTouch keypad

**Vive exclusive (type 30 only)**:
- All PowPak fixture controllers (0-10V, EcoSystem, relay, CCO)
- Vive Maestro dimmers/switches (C.L, 8ANS, ELV, 2-wire, 6ND)
- Vive ClearConnect dongle/sensor dongle
- Hubbell receptacle controller

#### 3. Processor DeviceClass (compiled identity)

`lutron-core` identifies itself differently:
- RR-SEL: "Smart Bridge core application" (compiled string)
- Vive: "Vive core application" (compiled string)

The `ThisProcessorDevice` table maps to the processor's DeviceClassInfo, which determines which `BusinessRules` row applies (max device counts, features enabled).

### Path to Cross-Compatibility

To make a Caseta/RA2 device pair with a Vive hub (or vice versa):

1. **Change Link.LinkTypeID** in the active database (9→30 or 30→9)
2. **Add DeviceSupportedLinkTypes rows** for the desired devices under the target link type
3. **The STM32 coprocessor doesn't care** — it handles all 119+ packet types regardless of link type
4. **The CCA radio protocol is identical** — same modulation, timing, framing, CRC

The filtering is entirely in `lutron-core` on the AM335x, not in the radio firmware.

## Comparison with Vive Hub

### Identical

- CCA radio hardware (STM32L100 + 2× CC110L)
- Coprocessor UART protocol (HDLC on `/dev/ttyO1` @ 115200)
- LEAP API architecture (Go server on port 8081)
- Database schema (same tables, views, triggers)
- LinkType table contents (all 30 types identical)
- SSL/LAP certificate infrastructure
- HomeKit (HAP) integration

### Different

| Aspect | RR-SEL-REP2 | Vive Hub |
|--------|-------------|----------|
| SoC storage | NAND (UBI/UBIFS) | eMMC (GPT, ext4) |
| Linux kernel | 3.12.10 (2017) | 4.4.32 (2019) |
| BusyBox | v1.20.2 | v1.26.2 |
| WiFi | None | Marvell 88W8801 |
| Connectivity | Ethernet only | WiFi AP + Ethernet |
| lutron-core size | 5.7 MB | 5.6 MB |
| leap-server size | 13.7 MB | 9.9 MB |
| coproc updater | 1.5 MB (4KB S19) | 297 KB (85KB S19) |
| DB version | 199 | Higher (more devices) |
| Active link type | 9 (Clear Connect) | 30 (Vive CC) |
| Max devices | 40 | 700 |
| SDDP identity | `lutron_ra2_select_repeater` | — |
| mDNS/HomeKit | Yes (`_hap._tcp`) | No |
| C4 SDDP | Yes (`c4-sddp-server`) | — |

## Network Configuration

- **DHCP client**: `dhcpcd` auto-starts when ethernet link detected
- **Firewall**: iptables rules loaded from `/etc/network-firewall/`
- **LEAP port**: 8081 (TLS)
- **HAP port**: 4548 (HomeKit)
- **Association port**: 8083 (LAP), 8443 (HTTPS), 4443 (listener)
- **MQTT**: `tls://v3mqtt.xively.com:8883` (Xively IoT, likely deprecated)
- **Update check**: `checkForFWUpgradeSource.sh` runs at boot

## Extracted Files

All files in `data/rr-sel-rep2/`:
- Boot chain: `spl1.bin`, `spl2.bin`, `uboot.bin`, `uboot-env.bin`, `kernel.bin`, `devicetree.dtb`
- Databases: `var/db/*.sqlite` (6 files + conversion scripts v2-v198)
- Binaries: `usr/sbin/*` (10 executables)
- Config: `etc/lutron.d/*`, `etc/monitrc`, `etc/openssh/*`
- SSL: `etc/ssl/*`, `usr/share/lap-certs/*`, `root/.Remoteaccesskey/*`
- Auth: `var/misc/auth/` (HAP keys, SRP, Nest)
- Init scripts: `etc/init.d/*` (boot sequence)
- Firmware: `coproc-firmware.s19` (decoded), `coproc-firmware.bin` (4KB partial)
