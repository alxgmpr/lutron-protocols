# Vive Hub Reverse Engineering Notes

## Hardware

| Component | Part | Role |
|-----------|------|------|
| Main SoC | TI AM335X-GP rev 2.1 | Linux host, "Lutron P51" |
| RAM | 512 MiB DDR | |
| Storage | 8MA12 JY995 eMMC (3.6GB) | 22-partition GPT |
| Radio MCU | STM32L100 (Cortex-M3) | CCA coprocessor, dual CC110L |
| Radio | 2x CC110L | 433 MHz CCA TX/RX |
| WiFi | Marvell 88W8801-NMD2 | 802.11n, SDIO, AP + client |
| EEPROM | 93C46WP | 128-byte config (Microwire) |

## Debug Interfaces

- **AM335x UART**: TX/RX/DGND pads → `/dev/ttyO0` (ttyS0) @ 115200 → root shell, no auth
- **STM32 SWD**: 2 pads (SWDIO/SWCLK)
- **STM32 JTAG**: TDO/TMS/TCK/TDI/NRST/DGND/3.3V
- **WiFi**: TX/RX/GPIO3/CLK/DAT0-3/CMD (SDIO)
- **PID1/PID2/PID3**: board variant straps next to AM335x

## Software

- **OS**: Linux 4.4.32, BusyBox v1.26.2 (2019-04-17)
- **U-Boot**: 2017.01.001, Jenkins build `VIVE_MERGE_PIPELINE-support%2F01.09-7`
- **Root filesystem**: `/dev/mmcblk0p16` (ext4, read-write)
- **Coproc firmware**: v01.09.01 (embedded in updater binary as obfuscated S19)

### eMMC Partition Layout (GPT, 22 partitions)

| # | Name | Size | Notes |
|---|------|------|-------|
| 1-3 | spl1-3 | 127K ea | SPL bootloader copies |
| 4-6 | uboot1/2/recovery | 1M ea | U-Boot images |
| 7 | uboot_env | 1M | U-Boot environment |
| 8-10 | kernel1/2/recovery | 5M ea | Linux kernel images |
| 11-13 | devicetree1/2/recovery | 1M ea | DTB blobs |
| 14 | rawbuffer | 5M | |
| 15 | rootfs | 500M | Primary rootfs |
| 16 | rootfs2 | 500M | Secondary rootfs (active) |
| 17 | recovery_rootfs | 100M | Recovery |
| 18 | database | 60M | `/var/db` (SQLite) |
| 19 | firmware | 1GB | `/var/firmware` |
| 20 | misc | 391M | `/var/misc` (SSL, coproc) |
| 21 | linuxlog | 36M | `/var/log` |
| 22 | logging | 1GB | `/var/eventlog` |

### Key Binaries

| Binary | Size | Type | Purpose |
|--------|------|------|---------|
| `lutron-core` | 5.4MB | ARM ELF C++ | Main protocol engine, HDLC/CLAP to coproc |
| `leap-server.gobin` | 9.4MB | ARM ELF Go | LEAP API server (port 8081) |
| `lutron-web-app.gobin` | 14MB | ARM ELF Go | Web UI (ports 80/443/8083/8444) |
| `lutron-cci-engine` | 1.1MB | ARM ELF | Contact closure input handler |
| `lutron-coproc-firmware-update-app` | 290KB | ARM ELF | STM32 firmware flasher (S19 bootloader) |
| `lutron-button-engine` | 163KB | ARM ELF | Physical button handler |
| `lutron-eeprom-engine` | 111KB | ARM ELF | 93C46 EEPROM manager |
| `lutron-led-ui` | 251KB | ARM ELF | LED indicator control |

### Network Services

| Port | Service | Binding |
|------|---------|---------|
| 22 | OpenSSH (pubkey only) | 0.0.0.0 |
| 53 | dnsmasq | 0.0.0.0 |
| 80 | lutron-web-app (HTTP) | :: |
| 443 | lutron-web-app (HTTPS) | :: |
| 8080 | leap-server (internal) | 127.0.0.1 |
| 8081 | leap-server (TLS/LEAP) | :: |
| 8083 | lutron-web-app (LAP) | :: |
| 8444 | lutron-web-app (client auth) | :: |
| 2812 | monit | 127.0.0.1 |

### WiFi AP

- SSID: Vive-yyyyyyyy
- Interface: `uap0` at 192.168.3.1/24
- Driver: Marvell SD8801 v14.76.36

### mDNS Services

- `_lutron-vive-v1._tcp` port 80
- `_lutron-vive-v2._tcp` port 80 (NAME, STATUS, SN, F fields)
- `_leap._tcp` port 8081 (MAJOR=1)
- `_lutron-vive-web._tcp` port 8444
- `_lap._tcp` port 8083
- `_lutron._tcp` port 22 (MACADDR, CODEVER=01.09.08f000)

## EEPROM Contents (93C46, 128 bytes)

| Addr | Field | Value | Decoded |
|------|-------|-------|---------|
| 0 | InternalStatus | 0xF1 | |
| 1 | EolTestStatus | 0x55 | Pass |
| 2 | WifiThresholdStatus | 0x55 | Pass |
| 3-4 | Schema | 0xFFFF | |
| 5 | CopyToBoot | 0xA5 | Boot copy 2 |
| 6 | FailToBootCopy1 | 0x00 | No failures |
| 7 | FailToBootCopy2 | 0x00 | No failures |
| 8 | PartitionSync | 0x01 | |
| 9-12 | DateCode | 0x5C659ED7 | 2019-02-14 10:01:11 UTC |
| 13-16 | DeviceClass | 0x08070101 | 134676737 (HJS-2-XX) |
| 17 | UpgradeStatus | 0xFF | |
| 18 | DevelopmentUnit | 0xFF | |
| 19 | ClearConnectThresholdStatus | 0x55 | Pass |
| 20+ | (unused) | 0xFF | |

## Architecture: CLAP Protocol (AM335x ↔ STM32)

Communication between the AM335x (lutron-core) and STM32L100 coprocessor uses:

1. **Physical**: UART `/dev/ttyO1` (ttyS1) @ 115200
2. **Framing**: HDLC (LUTRON_HDLC namespace) — SABM, I-frames, S-frames, U-frames
3. **Application**: CLAP (Clear Connect Link Application Protocol) — command/response with 16-bit big-endian command type IDs
4. **Payload**: CO_PROC_CMD_PAYLOAD structure

### CLAP Command Types (from C++ RTTI)

#### Addressing / Pairing (Host → Coproc)
- REQ_ENTER_ADDRESSING_COMMAND
- REQ_EXIT_ADDRESSING_COMMAND
- ADDRESSING_REQ_ADDRESS_DEVICE_COMMAND
- UNADDRESS_DEVICE_COMMAND
- REQUEST_START_UNADDRESSED_DEVICE_IDENTIFICATION_COMMAND
- REQUEST_STOP_UNADDRESSED_DEVICE_IDENTIFICATION_COMMAND

#### Addressing / Pairing (Coproc → Host)
- ENTER_ADDRESSING_MODE_RESPONSE_COMMAND
- ADDRESSING_REPORT_CHANNEL_SUBNET_ADDRESS_COMMAND
- ADDRESSING_REPORT_DEVICE_INFORMATION_COMMAND
- ADDRESSING_ADDRESS_DEVICE_RESPONSE_COMMAND
- ADDRESSING_MODE_EXITED_COMMAND
- UNADDRESS_DEVICE_RESPONSE_COMMAND
- UNADDRESSED_DEVICE_IDENTIFICATION_COPROC_RESPONSE_COMMAND
- ASSIGN_TEMPORARY_LINK_ADDRESS_RESPONSE_COMMAND
- REVOKE_TEMPORARY_LINK_ADDRESS_RESPONSE_COMMAND

#### Device Discovery
- REQUEST_FULL_OOB_COMMAND (Host → Coproc)
- REQUEST_BEGIN_REMOTE_ADDR_DEVICE_DISCOVERY_COMMAND (Host → Coproc)
- REQUEST_END_REMOTE_ADDR_DEVICE_DISCOVERY_COMMAND (Host → Coproc)
- REPORT_DEVICE_OOB_COMMAND (Coproc → Host)
- REPORT_REMOTE_ADDR_DEVICE_DISCOVERY_STATUS_COMMAND (Coproc → Host)
- REPORT_REMOTE_ADDR_DISCOVERED_DEVICE_COMMAND (Coproc → Host)
- NOMINATE_DISCOVERY_BEACON_RESPONSE_COMMAND (type=300)

#### Level Control
- REQUEST_LIMIT_SET_GOTO_LEVEL_COMMAND (Host → Coproc)
- LIMIT_SET_GOTO_LEVEL_RESPONSE_COMMAND (Coproc → Host)
- LIMIT_SET_GOTO_PRIMARY_AND_SECONDARY_LEVELS_RESPONSE_COMMAND (type=1555)
- RequestLimitSetGotoLevel / RequestLimitSetGotoPrimaryAndSecondaryLevels

#### Occupancy
- OCCUPANCY_OCCUPIED_TRANSITION_RESPONSE_COMMAND (type=2053)
- OCCUPANCY_UNOCCUPIED_TRANSITION_RESPONSE_COMMAND (type=2055)
- REPORT_OCCUPANCY_SENSOR_GROUP_OCCUPIED_TEST_RESPONSE (type=2059)
- REPORT_OCCUPANCY_SENSOR_GROUP_UNOCCUPIED_TEST_RESPONSE (type=2061)
- OCCUPANCY_SENSOR_GROUP_LOW_BATTERY_RESPONSE_COMMAND (type=2063)
- SEND_OCCUPANCY_HEARTBEAT_RESPONSE_COMMAND (type=2065)
- OCCUPANCY_SENSOR_GROUP_MISSING_RESPONSE_COMMAND (type=2067)

#### Emergency Lighting
- REQUEST_PROCESS_EMERGENCY_HEARTBEAT_COMMAND (type=3072)
- START_EMERGENCY_MODE_RESPONSE_COMMAND (type=3074)
- STOP_EMERGENCY_MODE_RESPONSE_COMMAND (type=3076)

#### Programming Extraction
- REQUEST_BEGIN_DEVICE_PREEXISTING_PROGRAMMING_EXTRACTION_COMMAND
- REQUEST_END_DEVICE_PREEXISTING_PROGRAMMING_EXTRACTION_COMMAND
- REQUEST_DEVICE_PREEXISTING_PROGRAMMING_EXTRACTION_STATUS_COMMAND
- REPORT_DEVICE_PREEXISTING_ASSOCIATION_EXTRACTION_STATUS_COMMAND
- REPORT_DEVICE_PREEXISTING_ASSOCIATION_INFO_COMMAND
- REPORT_DEVICE_PREEXISTING_PROGRAMMING_EXTRACTION_COMPLETE_COMMAND

#### Runtime / Admin
- REPORT_RUNTIME_PROPERTY_UPDATE_COMMAND
- EXECUTE_SYSTEM_STATUS_QUERY_COMMAND
- REQUEST_REBOOT_COMMAND
- REQUEST_UPDATE_LOCATION_INFO_COMMAND
- REQUEST_UPDATE_DATE_TIME_COMMAND
- DATA_TRANSFER_QUEUE_OBJECT_COMMAND
- DATA_TRANSFER_CANCEL_OBJECT_COMMAND

## Database

SQLite database at `/var/db/lutron-db.sqlite` — schema is **essentially identical to RA3/HWQS** with ~180 tables.

### Key Tables
- `Device` — addressed devices (serial number, device class, firmware rev)
- `DeviceClassInfo` — supported device types with model numbers and masks
- `Link` — RF link instances (LinkTypeID=30 = Vive Clear Connect Link)
- `LinkType` — 30 link types defined (type 30 = "Vive Clear Connect Link")
- `RFPropertyAddress` — RF addressing for devices
- `SupportedDevices` — ~45 device classes supported
- `Preset` / `PresetAssignment` — scene/preset programming
- `BusinessRules` — system limits (max devices, etc.)
- `Zone` / `ZoneController` — zone configuration

### Link Types (from Vive DB)
| ID | Name | Wireless | Notes |
|----|------|----------|-------|
| 7 | QS Link | No | Wired |
| 9 | Clear Connect Link | Yes | RA3/Caseta |
| 11 | Homeworks QS Clear Connect Link | Yes | HWQS |
| 30 | Vive Clear Connect Link | No* | Vive CCA (*flags=0,0) |

### Hub Device
- Device class: 0x08070101 (134676737)
- Model: HJS-2-XX
- Serial: 0xYYYYYYYY (100000009)

## Coprocessor Firmware

**Extracted!** Firmware decoded from `lutron-coproc-firmware-update-app` using rotating Caesar cipher.

### Extraction Details
- Embedded S19 obfuscated with rotating printable-ASCII cipher: `decoded = ((byte - 0x20) + (95 - key)) % 95 + 0x20`, key starts at `0x5859 % 95 = 7`, advances only for printable bytes
- Build path: `/home/jenkins-agent/workspace/rockhopper` (codename **Rockhopper**)
- Bootloader: v2.2.1 (Boot 079: 0x00796715)
- Application: v1.9.1 (OS revision)
- Flash: 0x08003000–0x0803FF08 (85.2 KB), bootloader at 0x08000000–0x08002FFF (12 KB, not in S19)
- Entry point: 0x0800C8FD, SP: 0x20004000 (16 KB SRAM)

### STM32L100 Pin Map (from firmware GPIO init)

| Pin | Function | Purpose |
|-----|----------|---------|
| PA0 | Output | CC110L_1 chip select |
| PA1 | Output | CC110L_2 control |
| PA2 | AF7 USART2 TX | Secondary UART |
| PA3 | AF7 USART2 RX | Secondary UART |
| PA4 | Output | Control / CS |
| PA5 | AF5 SPI1 SCK | CC110L_1 SPI clock |
| PA6 | AF5 SPI1 MISO | CC110L_1 SPI data in |
| PA7 | AF5 SPI1 MOSI | CC110L_1 SPI data out |
| PA8 | Output | LED or control |
| PA9 | AF7 USART1 TX | HDLC to AM335x |
| PA13 | AF0 SWDIO | **Debug — SWD active** |
| PA14 | AF0 SWCLK | **Debug — SWD active** |
| PA15 | AF0 JTDI | Debug — JTAG |
| PB0 | Input | CC110L_1 GDO0 → EXTI0 ISR |
| PB1 | Input | CC110L_1 GDO2 / status |
| PB3 | AF0 JTDO/SWO | Debug — JTAG |
| PB4 | AF0 JTRST | Debug — JTAG |
| PB10 | AF7 USART3 TX | Third UART |
| PB12 | Output | CC110L_2 chip select |
| PB13 | AF5 SPI2 SCK | CC110L_2 SPI clock |
| PB14 | AF5 SPI2 MISO | CC110L_2 SPI data in |
| PB15 | AF5 SPI2 MOSI | CC110L_2 SPI data out |

**SWD/JTAG debug pins are AF0 (debug function) in firmware → RDP likely level 0 (open).**

### Interrupt Handlers (Active IRQs)

| IRQ | Address | Purpose |
|-----|---------|---------|
| SysTick | 0x0800D689 | System tick (TDMA timing base) |
| EXTI0 | 0x0800D7B5 | CC110L_1 GDO0 (packet RX/TX event) |
| EXTI4 | 0x0800D6A9 | CC110L_2 GDO / control event |
| EXTI9_5 | 0x0800D699 | Additional GDO interrupt |
| TIM3 | 0x0800D781 | TDMA slot timer |
| TIM7 | 0x0800D7B9 | Secondary timer |
| USART1 | 0x0800D6B9 | HDLC link to AM335x |
| USART2 | 0x0800D701 | Secondary UART |
| USART3 | 0x0800D739 | Third UART |

### CCA Packet Type Catalog (119 types from firmware dispatch)

Extracted from radio handler switch table at sub_8004700. Format ID is 16-bit, payload size in bytes.

| Group | Types | Description |
|-------|-------|-------------|
| 0x0xx | 4 | Basic/null packets |
| 0x1xx | 22 | Short control packets (buttons, pico, occupancy?) |
| 0x2xx | 3 | Long packets (15–25 bytes) |
| 0x3xx | 8 | Config/pairing packets (variable length) |
| 0x4xx | 10 | Zone/area programming |
| 0x5xx | 19 | Extended control (shades, dimmers, scenes) |
| 0x6xx | 11 | Advanced control (14–15 byte payloads) |
| 0x7xx | 4 | Large packets (32–60 bytes, accept-only) |
| 0x8xx | 9 | Status/state reports |
| 0x9xx | 2 | Extended status (18 bytes) |
| 0xAxx | 6 | Occupancy/sensor data |
| 0xBxx | 4 | Secondary sensor data |
| 0xCxx | 2 | Emergency/priority |
| 0xE0xx | 4 | System config (store bytes) |
| 0xE1xx | 2 | System control |
| 0xE2xx | 9 | Diagnostics/debug |

### Credentials & Secrets Found

| Item | Value | Notes |
|------|-------|-------|
| WiFi AP passphrase | `have a nice day` | Default for Vive hubs? |
| Web admin hash | `8266498d...` (SHA-256) | User `admin` |
| Support SSH key | RSA (abhat@PC0008690) | Lutron employee |
| SSL private keys | RSA 2048-bit | HTTPS, backend network, 3 spares |
| Root CA | `vive-product-line` → `vive-hubs` | Lutron PKI |
| LEAP loopback cert | ECDSA P-256, self-signed | `vive-yyyyyyyy-leap-vue-root` |
| SSH `leap` user | Tunnels to telnet localhost:8080 | Direct LEAP API access |
| lutron.079 | `08030201C32E` | Device class + HW revision fingerprint |
| DB source revision | `02.46.00f000` | Schema version |

## TDMA Timing (from firmware data tables)

Base tick: **250 μs** (SysTick reload 0x1F3F = 7999 @ 32 MHz)

### Slot Timing Tables (6 levels, indexed by zone type)

| Level | Frame Size | Slot Duration | Expanded | Secondary | Short Pkt | Med Pkt |
|-------|-----------|---------------|----------|-----------|-----------|---------|
| 0 | 2.00 ms (8) | 1.00 ms (4) | 3.00 ms | 2.25 ms | 1.00 ms | 1.00 ms |
| 1 | 16.00 ms (64) | 8.00 ms (32) | 15.00 ms | 11.25 ms | 2.00 ms | 2.00 ms |
| 2 | 18.00 ms (72) | 9.00 ms (36) | 17.00 ms | 12.75 ms | 3.00 ms | 2.00 ms |
| 3 | 20.00 ms (80) | 10.00 ms (40) | 19.00 ms | 14.25 ms | 4.00 ms | 3.00 ms |
| 4 | 28.00 ms (112) | 13.75 ms (55) | 27.00 ms | 20.25 ms | 6.25 ms | 5.00 ms |
| 5 | 36.00 ms (144) | 18.00 ms (72) | 35.00 ms | 26.25 ms | 9.00 ms | 7.50 ms |

Key constants: 0x2BC (700) = max device count, 0x1E06 (7686 ticks) = ~1.9s frame period, 0x449E (17566 ticks) = ~4.4s frame period.

### Packet Type Prefixes (state byte at 0x20001AB8)
- **0x40** = Short packet (24 bytes total: type 0x80–0x9F)
- **0x80** = Long packet (53 bytes total: type 0xA0+)
- **0xC0** = Config/pairing packet

## CLAP↔CCA Cross-Reference

The 119 CLAP command IDs (16-bit, host↔coproc) map to CCA over-the-air format bytes by payload size. Consecutive even/odd IDs suggest TX/RX direction pairs.

### Confirmed Mappings (CLAP ID → CCA format by payload size)

| CLAP IDs | Payload | CCA Format | Function |
|----------|---------|------------|----------|
| 0x0509, 0x050F | 14 | 0x0E LEVEL | GoToLevel / set-level |
| 0x0606, 0x0608, 0x0614 | 14 | 0x0E LEVEL | Extended level control |
| 0x0501, 0x0503 | 12 | 0x0C BEACON | Beacon / unpair / dim-stop |
| 0x0A05 | 12 | 0x0C BEACON | Sensor beacon |
| 0x0507, 0x0526, 0x0528 | 9 | 0x09 CTRL | Hold-start / device control |
| 0x0302, 0x0304 | 9 | 0x09 CTRL | Config control |
| 0x0420, 0x0422 | 9 | 0x09 CTRL | Zone control |
| 0x050B, 0x0520, 0x0522 | 11 | 0x0B DIM_STEP | Dim step / sensor |
| 0x0429 | 11 | 0x0B DIM_STEP | Zone dim step |
| 0x0505, 0x0511, 0x0513 | 10 | 0x0A ADDR | Address assign |
| 0x0A02 | 10 | 0x0A ADDR | Sensor address |
| 0x0900, 0x0902 | 18 | 0x12 FINAL | Final config / zone bind |
| 0x0A07, 0x0A0B | 16 | 0x10 ACCEPT | Pairing accept |
| 0x0205 | 16 | 0x10 ACCEPT | Extended accept |
| 0x042B, 0x051D | 21 | 0x15 TRIM | Trim / phase config |
| 0x0106, 0x011D, 0x0127 | 8 | 0x08 STATE | State report |
| 0x0400, 0x0804, 0x0806 | 8 | 0x08 STATE | State query/report |
| 0x0700, 0x0702 | 32 | — | Large data (32 bytes) |
| 0x0707, 0x0709 | 60 | — | Bulk data (60 bytes) |
| 0x0200 | 25 | 0x1A? | Scene/long config |
| 0xE0xx | 3–4 | — | System config (store bytes) |
| 0xE1xx | — | — | System control |
| 0xE2xx | 2–10 | — | Diagnostics |

### Packet Type Groups

| Group | Count | Purpose |
|-------|-------|---------|
| 0x0xx | 4 | Basic/null/ack |
| 0x1xx | 22 | Short control (pico, buttons, LED) |
| 0x2xx | 3 | Long config (scenes, bulk) |
| 0x3xx | 8 | Pairing/config (variable length) |
| 0x4xx | 10 | Zone programming |
| 0x5xx | 19 | Extended control (shades, dimmers, sensors, scenes) |
| 0x6xx | 11 | Advanced multi-level control |
| 0x7xx | 4 | Bulk data transfer (32–60 bytes) |
| 0x8xx | 9 | Status/state reports |
| 0x9xx | 2 | Final config (zone bind) |
| 0xAxx | 6 | Occupancy/sensor |
| 0xBxx | 4 | Secondary sensor |
| 0xCxx | 2 | Emergency/priority |
| 0xE0xx–E2xx | 15 | System/diagnostics |

## Cross-System Compatibility Analysis

### Shared Devices (7 — Picos + sensor)
Both Caseta/RA3 and Vive support PJ2 Picos (0x01070002–0x01070006, 0x01070101) and the LRF2 occupancy sensor (0x06080101). **These devices already work with both systems.**

### Caseta/RA3 Only (24 devices)
Residential: seeTouch keypads, all shades (Serena, Triathlon, Sivoia QS), Caseta dimmers/switches (PD-6WCL, PD-5WS), plug-in devices, GE bulbs, aux repeater, Super Pico.

### Vive Only (39 devices)
Commercial: PowPak modules (switching, dimming, receptacle, CCO, DALI, emergency), Vive Maestro (MRF2S-series CL/ELV/neutral dimmers + switches with built-in occupancy), fixture controllers/dongles, Hubbell 3rd-party sensor, plus 11 additional Pico variants (4-button, specialty scenes).

### Path to Cross-Compatibility
The CCA radio protocol is **identical** — same 8N1 encoding, same TDMA timing, same format bytes, same CRC-16. The barriers are purely in software:

1. **SupportedDevices table** — whitelist of allowed device class IDs (DB trigger blocks unsupported)
2. **DeviceClassInfo table** — device metadata (model numbers, descriptions, capabilities)
3. **Link Type** — Vive uses type 30 ("Vive Clear Connect Link"), Caseta uses type 9 ("Clear Connect Link")
4. **BusinessRules table** — max device counts, feature flags

To pair a Caseta dimmer with Vive (or vice versa):
```sql
-- Add Caseta wall dimmer support to Vive
INSERT INTO SupportedDevices (DeviceClassInfoID, DeviceClass, DeviceClassMask)
SELECT DeviceClassInfoID, DeviceClass, DeviceClassMask FROM DeviceClassInfo
WHERE ModelNumber = 'PD-6WCL-XX';

-- Or change link type to standard CCA
UPDATE Link SET LinkTypeID = 9 WHERE LinkTypeID = 30;
```

The STM32 coprocessor firmware handles **all 119 packet types** regardless of link type — the filtering is entirely in `lutron-core` on the AM335x.

## Caseta Bridge RE Attempt (2026-03-28)

Hardware: AM335X-GP rev 2.1 "Lutron Ethernet Bridge", 256 MiB DRAM, 256 MiB NAND, Linux 5.10.208, BusyBox 1.34.1, build `caseta-08.25.xx` (Dec 2025).

### UART Console
- TX/RX pads present, 115200 baud
- Boot log visible but **no shell spawned** — init doesn't attach tty to serial
- U-Boot autoboot=0, no key sequence interrupts it
- Kernel: `Linux-5.10.208-001-ts-armv7l`

### JTAG (FAILED)
- 6-pin JTAG header labeled: DGND, 3V3, TDI, TDO, TCK, TMS, TRSTN
- Built custom debugprobe firmware with JTAG enabled (`DAP_JTAG=1`, GPIO: GP2=TCK, GP3=TMS, GP4=TDI, GP5=TDO)
- Result: **"all ones" — JTAG fused off** (AM335x `DEVMEM_JTAG_DISABLE` eFuse likely blown)
- Tried: different speeds (10/50/100/500 kHz), TRSTN tied high, generic TAP config — all failed

### STM32 SWD
- Unlabeled 2-pin pads present (likely SWDIO + SWCLK for coprocessor)
- Not yet attempted

### Remaining Attack Vectors
1. STM32 SWD dump (untested)
2. NAND chip-off (desolder and read directly)
3. OTA firmware intercept
4. Voltage glitch on U-Boot bootdelay check
5. **RadioRA Select (RR-SEL-REP2)** — identical hardware, UART shell accessible

## Key Observations

1. **Vive uses the same CLAP/HDLC protocol as Caseta/RA3** for host↔coprocessor communication
2. **Database schema is identical to RA3** — same tables, triggers, device class masking
3. **LEAP server runs on port 8081** — same protocol, potentially compatible
4. **Link type 30 vs 9**: Vive has its own "Vive Clear Connect Link" type, separate from standard "Clear Connect Link" (type 9). This is likely the key difference that prevents cross-system pairing
5. **119 CCA packet types** in firmware — far more than documented, correlate to known CCA formats by payload size
6. **Dual CC110L radios** on SPI1 (PA5-7) and SPI2 (PB13-15) with separate GDO interrupts (EXTI0, EXTI4)
7. **SWD debug is active** in firmware GPIO config (PA13/PA14 = AF0) — RDP likely level 0 (full access)
8. **STM32 firmware fully extracted** — 85 KB application, codename "Rockhopper", rotating Caesar cipher decoded
9. **Root shell with no auth** on serial console, root has no password
10. **Support SSH backdoor** — Lutron employee RSA key in `/home/support/.ssh/authorized_keys`
11. **TDMA timing has 6 levels** — frame sizes from 2 ms to 36 ms, slot durations 1–18 ms, base tick 250 μs
12. **0x2BC (700) = max devices** — matches DB BusinessRules MaxNumberOfDevices
