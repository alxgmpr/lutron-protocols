# Phoenix Processor eMMC Extraction

## Overview

Standalone ARM assembly program boots the RA3/HWQSX Phoenix processor (AM335x) via UART, reads eMMC sectors directly into SRAM (no DDR required), and dumps them over UART. A Python script on a Raspberry Pi automates the boot, navigates the ext4 filesystem, and extracts files.

This was used to extract firmware upgrade SSL keys from `/etc/ssl/` on the rootfs partition.

## Extracted Data

All saved to `data/phoenix-ssl/`:

| File | Type | Size | Purpose |
|------|------|------|---------|
| `primary.pub` | RSA-4096 | 800B | Primary firmware upgrade signature verification |
| `secondary.pub` | RSA-4096 | 800B | Secondary/backup firmware upgrade verification |
| `firmwaresigning.pem` | X.509 RSA-2048 | 1.6KB | Self-signed cert from "Lutron/Phoenix Processors" OU, valid 2020-2120 |
| `eol-auth.pub` | RSA-2048 | 451B | End-of-Life authentication |
| `key_generation.md` | text | 973B | Internal docs — refs git.intra.lutron.com LPFU repo |

## Hardware Setup

- **SoC**: AM335x-GP rev 2.1 (TI Sitara Cortex-A8), 26 MHz crystal
- **eMMC**: On MMC1 (MMCHS1 at 0x481D8100), GPMC bus pins
- **UART boot**: Ground SYSBOOT2 (TP701) at power-on
- **Raspberry Pi 5**: UART0 (/dev/ttyAMA0) at 115200 8N1, GPIO17 relay (active-LOW) for PoE power cycling

### Wiring (Pi → Phoenix)

| Pi Pin | Phoenix | Signal |
|--------|---------|--------|
| GPIO14 (TXD) | UART0 RX | Serial data to Phoenix |
| GPIO15 (RXD) | UART0 TX | Serial data from Phoenix |
| GND | GND | Common ground |
| GPIO17 | PoE relay | Active-LOW power control |

TP701 (SYSBOOT2) must be grounded during power-on to force UART boot mode.

## How to Reproduce

### Prerequisites

On Mac (build host):
- `arm-none-eabi-as`, `arm-none-eabi-ld`, `arm-none-eabi-objcopy` (from `arm-none-eabi-gcc` homebrew package)

On Raspberry Pi:
- Python 3 with `pyserial` and `xmodem` packages
- `pinctrl` command (ships with Pi OS)
- Serial console disabled on /dev/ttyAMA0 (remove `console=serial0,115200` from `/boot/firmware/cmdline.txt`)

### Step 1: Build the ARM stub

```
cd tools
bash phoenix-emmc-build.sh
```

This produces `emmc-read.bin` (~3KB) — a standalone ARM program wrapped with an AM335x GP header.

### Step 2: Deploy to Pi

```
PI=alex@10.0.0.6
scp -i ~/.ssh/id_ed25519_pi emmc-read.bin $PI:~/
scp -i ~/.ssh/id_ed25519_pi phoenix-emmc-dump.py $PI:~/emmc-dump.py
scp -i ~/.ssh/id_ed25519_pi phoenix-emmc-extract.py $PI:~/emmc-extract.py
```

### Step 3: Read partition table

```
ssh $PI "python3 ~/emmc-dump.py gpt"
```

This power-cycles the Phoenix, sends the ARM stub via XMODEM, reads 34 sectors (GPT), and prints the partition layout.

### Step 4: Extract files

```
ssh $PI "python3 ~/emmc-extract.py /etc/ssl/firmwareupgrade"
```

This boots the reader, navigates the ext4 filesystem from root to the target directory, and extracts all files to `~/extracted/` on the Pi.

Other useful commands:
```
ssh $PI "python3 ~/emmc-dump.py boot"              # Boot and show diagnostic output
ssh $PI "python3 ~/emmc-dump.py read 0 34"          # Read raw sectors 0-33 to file
ssh $PI "python3 ~/emmc-dump.py interactive"         # Interactive sector read shell
ssh $PI "python3 ~/emmc-extract.py /etc/ssl"         # List /etc/ssl directory
ssh $PI "python3 ~/emmc-extract.py /etc/passwd"      # Extract a single file
```

### Step 5: Copy files back

```
scp -i ~/.ssh/id_ed25519_pi $PI:~/extracted/* ./
```

## eMMC Partition Layout

GPT with 20 partitions on a 3.7GB eMMC (7.6M sectors):

| # | Name | Start LBA | Size | Notes |
|---|------|-----------|------|-------|
| 0-2 | spl1/spl2/spl3 | 256/512/768 | 128KB each | U-Boot SPL (triple redundancy) |
| 3-5 | uboot1/uboot2/uboot_recovery | 2048/4096/6144 | 1MB each | U-Boot (A/B + recovery) |
| 6 | uboot_env | 8192 | 1MB | U-Boot environment |
| 7-8 | kernel1/kernel2 | 10240/30720 | 10MB each | Linux kernel (A/B) |
| 9 | kernel_recovery | 51200 | 5MB | Recovery kernel |
| 10-12 | devicetree1/2/recovery | 61440/63488/65536 | 1MB each | Device trees (A/B + recovery) |
| 13 | rawbuffer | 67584 | 5MB | Raw data buffer |
| 14 | **rootfs** | **77824** | **500MB** | Primary root filesystem (ext4) |
| 15 | rootfs2 | 1101824 | 500MB | Secondary rootfs (A/B) |
| 16 | recovery_rootfs | 2125824 | 150MB | Recovery rootfs |
| 17 | database | 2433024 | 200MB | Lutron device database |
| 18 | misc_unsynced | 2842624 | 2059MB | Unsynced miscellaneous data |
| 19 | misc_synced | 7059456 | 280MB | Synced miscellaneous data |

## Technical Details

### How the ARM Stub Works

The 3KB ARM assembly program (`phoenix-emmc-read.S`) executes entirely from SRAM — no DDR initialization needed:

1. **WDT disable** — prevents watchdog reset during operation
2. **Clock enables** — L3/L4 interconnect, MMC0/MMC1/MMC2, GPIO1/2/3, UART0
3. **eMMC reset** — drives GPIO1_20 HIGH to release eMMC RST# line
4. **Pin mux** — configures GPMC pins for MMC1 (AD0-7 → data, CSN1 → CLK, CSN2 → CMD)
5. **MMC controller init** — soft reset, 3.3V bus power, 400kHz card clock, init stream
6. **eMMC card init** — CMD0 (idle), CMD1 (OCR), CMD2 (CID), CMD3 (RCA), CMD7 (select), CMD16 (block size)
7. **Command loop** — reads sector commands from UART, dumps 512-byte hex blocks

### Key Hardware Discoveries

- **eMMC is on MMC1** — SYSBOOT[4:0] = 0b11100 (ungrounded) puts MMC1 first in boot order. Confirmed by CTO on MMC0/MMC2 and successful CMD1 on MMC1.
- **GPIO1_20 is eMMC RST#** — without toggling this GPIO HIGH, the eMMC never responds to commands. Same pin as BeagleBone Black.
- **MMC1 CLK needs RXACTIVE** — pin mux must be 0x22 (mode 2 + input enable) not 0x02, for clock feedback.
- **CONTROL_STATUS = 0x00C00358** — AM335x-GP device, SYSBOOT confirms 26 MHz crystal.

### Firmware Update Chain

1. **Encryption**: AES-128-CBC with symmetric key (extracted from Designer MSIX, documented separately)
2. **Signature**: RSA-4096 verification using `primary.pub` or `secondary.pub` on the device
3. **Signing cert**: Self-signed RSA-2048 X.509 from `firmwaresigning/public.pem`

### DDR Bypass Rationale

The original approach was to build a custom U-Boot SPL to fully boot the AM335x (with DDR, U-Boot shell, Linux). This hit two blockers:
1. **DDR bit corruption** — DQ13/DQ14 physically swapped on the Phoenix PCB, reads back wrong
2. **UART from U-Boot C code** — PRCM register writes crash from compiled C but work from ARM assembly

The eMMC-direct approach bypasses both problems entirely: ARM assembly reads eMMC sectors into the 64KB SRAM, no DDR needed. At 115200 baud, reading a 512-byte sector takes ~140ms. Extracting a few KB of certificates takes under a minute.

## Files

| File | Location | Purpose |
|------|----------|---------|
| `tools/phoenix-emmc-read.S` | project | ARM assembly eMMC reader source |
| `tools/phoenix-emmc-build.sh` | project | Assembles + wraps binary with GP header |
| `tools/phoenix-emmc-dump.py` | project | Pi script: boot + sector reads + GPT parsing |
| `tools/phoenix-emmc-extract.py` | project | Pi script: boot + ext4 navigation + file extraction |
| `tools/phoenix-uart-boot.py` | project | Original XMODEM sender (Mac side) |
| `data/phoenix-ssl/` | project | Extracted SSL keys and certificates |
| `/tmp/phoenix-boot/` | local | Build artifacts, test binaries, DDR experiments |
