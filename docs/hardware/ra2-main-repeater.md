# RadioRA 2 Main Repeater (RR-MAIN-REP-WH) Reverse Engineering

**Date**: 2026-04-10
**FCC ID**: JPZ0103 (filed 2014-01-21, approved)
**PCB**: 470-3588 REV A
**UL**: 1337C 94V-0

## Hardware

| Component | Part | Role |
|-----------|------|------|
| Main MCU | Freescale **MCF527x** (ColdFire V2), BGA | Main processor, Ethernet MAC, UARTs |
| Main flash | ST **M28W320FCB** (32 Mbit / 4 MB parallel NOR), BGA | **Firmware — bootloader + application (XIP)** |
| Secondary flash | Spansion **S25FL116K** (16 Mbit / 2 MB SPI NOR), SOIC-8 | Config data, database, radio tables? |
| SDRAM | Micron **MT 4LB47** (FBGA code, exact part TBD) | Working memory (heap, stack, runtime) |
| EEPROM | Microchip **93LC46C** (1 Kbit / 128 B, Microwire) | Serial number, MAC, config |
| Ethernet magnetics | Pulse H1102NL96 | 10/100 Ethernet |
| Battery | CR2032 (BAT1) | RTC backup |
| Speaker/buzzer | PTS1230 (11L) | Audio feedback? |
| Antenna | External SMA whip (ANT1) | 433 MHz |

**Not yet confirmed**:
- Radio chip (CC110L vs CC1101 — need to read marking under/near shield)
- Ethernet PHY (MCF527x has MAC only, needs external PHY — not yet identified)
- RS232 transceiver
- RS485 transceiver

### Memory Map (estimated)

```
Main Flash (M28W320FCB, parallel NOR, 4 MB):
  0x00000000  Reset vectors (SP + PC)
  0x00000008  Exception vector table
  0x00000400  Bootloader
  0x000?????  Application firmware
  0x003FFFFF  End of 4 MB

SPI Flash (S25FL116K, 2 MB):
  Accessed via MCF527x SPI peripheral
  Likely stores: device database, pairing data, radio config tables,
  possibly firmware update staging area

SDRAM (Micron, size TBD):
  Mapped via MCF527x SDRAM controller
  Runtime memory: stack, heap, RTOS task stacks, packet buffers

EEPROM (93LC46C, 128 B):
  Accessed via Microwire GPIO bit-bang
  Device serial, MAC address, factory calibration
```

### Main Flash Details (M28W320FCB — the firmware)

- **Capacity**: 32 Mbit (4 MB), organized as 2M x 16-bit
- **Interface**: 16-bit parallel bus, directly on MCF527x external bus
- **Package**: BGA (Z86 suffix) — **cannot clip-read, must access via MCF527x or desolder**
- **Voltage**: 2.7–3.6V (VDD), optional 12V VPP for fast programming
- **Access time**: 70 ns
- **Boot block**: Bottom boot block variant ("FCB") — small parameter blocks at low addresses
- **Security**: 128-bit user-programmable OTP cells + 64-bit unique device identifier
- **Endurance**: 100,000 program/erase cycles per block
- **Block map** (bottom boot block):
  - 4x 8 KB parameter blocks (0x00000–0x07FFF)
  - 1x 32 KB block
  - 63x 64 KB main blocks
  - Total: 4 MB

### SPI Flash Details (S25FL116K — secondary storage)

- **Capacity**: 16 Mbit (2 MB)
- **Interface**: SPI (standard SOIC-8 pinout) — **easy to clip-read**
- **Voltage**: 3.0V
- **Read**: standard SPI commands (0x03 read, 0x9F JEDEC ID)
- **Datasheet**: [Mouser S25FL116K](https://www.mouser.com/datasheet/2/380/S25FL116K_00-274912.pdf)
- **Pinout (SOIC-8)**:
  ```
  Pin 1: CS#     Pin 8: VCC
  Pin 2: DO(IO1) Pin 7: HOLD#(IO3)
  Pin 3: WP#(IO2)Pin 6: SCK
  Pin 4: VSS     Pin 5: DI(IO0)
  ```

### SDRAM Details (Micron MT 4LB47)

- **FBGA code**: 4LB47 — use [Micron FBGA decoder](https://www.micron.com/sales-support/design-tools/fbga-parts-decoder) to get full part number
- **Package**: BGA
- **Type**: Likely SDRAM or DDR (MCF5275 EVB uses 16 MB DDR SDRAM)

### EEPROM Details (93LC46C)

- **Capacity**: 1 Kbit (128 bytes in 8-bit mode, 64 words in 16-bit mode)
- **Interface**: Microwire (3-wire: CS, CLK, DI/DO)
- **Purpose**: Likely stores device serial number, Ethernet MAC address, and persistent config

## Architecture

This is a fundamentally different platform from the AM335x "Sandwich Tern" repeaters (RR-SEL-REP2, Caseta, Vive). The MCF527x is a bare-metal/RTOS processor — no Linux.

```
  CC110L (CCA 433 MHz)  ──── UART/SPI ────┐
                                            │
  Antenna (SMA) ─── CC110L RF ─────────────┤
                                            │
  MCF527x ColdFire V2 ────────────────────┘
      ├── FEC (Ethernet MAC) → PHY → RJ45 (telnet:23, integration)
      ├── UART0 → MAX232 → DE-9 (RS232 integration)
      ├── UART1 → RS485 transceiver → RJ45? (Aux Repeater link)
      ├── UART2 → CC110L? (radio comms)
      ├── BDM debug → 26-pin header (labeled "DEBUG")
      ├── External NOR/SPI flash (firmware)
      ├── External SDRAM (runtime memory)
      ├── RTC ← CR2032 battery
      └── GPIO → LEDs, buttons (Test, Add, front panel)
```

Likely RTOS: **MQX** (Freescale's own, extremely common on ColdFire) or proprietary.

## Board Layout (from FCC internal photos)

### Front side (connector side, 470-3588 REV A):
- **Bottom row (L→R)**: Ethernet RJ45, RS232 DE-9, Power barrel jack
- **Top left**: ANT1 SMA connector, LED01/LED07
- **Top right**: USB footprint (unpopulated, pins 1-8), BAT1 coin cell
- **Center**: Large RF shield covering MCF527x + support chips
- **Near battery**: SW1 (unpopulated switch)
- **Near antenna**: Unpopulated switch (antenna diversity?)
- **U19**: Radio chip (under/near shield)
- **X3**: Crystal oscillator

### Back side (component side):
- **Bottom left**: DEBUG header (2x13, 26-pin) — **labeled "DEBUG"**
- **Top left**: USB unpopulated area, U12 footprint empty (USB PHY?)
- **Top right**: PROG header area
- **Bottom right**: TESTED label
- **Center**: Dense SMD area (QFP/BGA under shield on front)
- **Test points**: TP1, TP3, TP4, TP9, TP10, TP11, TP12, TP14, TP18, TP48

## Debug Interfaces

### 26-Pin BDM Header (labeled "DEBUG")

The ColdFire V2 BDM (Background Debug Mode) standard 26-pin (2x13) connector:

```
Pin  1: BKPT#/DSCLK    Pin  2: GND
Pin  3: GND             Pin  4: TDO/DSI
Pin  5: GND             Pin  6: TDI/DSO
Pin  7: GND             Pin  8: RESET#
Pin  9: GND             Pin 10: TA#/ALLPST
Pin 11: GND             Pin 12: PST0/DDATA0
Pin 13: GND             Pin 14: PST1/DDATA1
Pin 15: GND             Pin 16: PST2/DDATA2
Pin 17: GND             Pin 18: PST3/DDATA3
Pin 19: VCC             Pin 20: PSTCLK/TCLK
Pin 21: VCC             Pin 22: DEV (optional)
Pin 23: N/C             Pin 24: TMS
Pin 25: TRST#           Pin 26: TCK
```

**NOTE**: This pinout is the Freescale standard — verify by checking continuity on VCC (pins 19, 21) and GND (odd pins 1-17 minus pin 1) against known power rails before connecting anything.

**Tools for ColdFire BDM**:
- **P&E Micro USB Multilink Universal** (~$200) — best ColdFire support
- **P&E Micro USB Multilink ColdFire** (older, cheaper if found used)
- **USBDM** — open-source, originally HCS08/ColdFire, hardware designs available
- **OpenOCD** — has ColdFire support (limited, check MCF527x specifically)
- **Segger J-Link** — supports ColdFire via JTAG pins on the BDM connector

### Unpopulated USB (U12 area)

The USB footprint has pins 1-8 labeled. The empty U12 footprint nearby suggests a missing **USB PHY** or **USB-to-UART** chip. The MCF5271/5274 has a built-in USB 1.1 device controller — if U12 is just a USB transceiver, populating it could enable USB device mode.

### PROG Header

Top right of back side — likely a programming header for the radio chip (CC110L ISP or similar). Needs trace mapping.

### Test Points

| Label | Likely Function | Notes |
|-------|----------------|-------|
| TP1 | TBD | Back side |
| TP3 | TBD | Near UL marking |
| TP4 | TBD | Near USB area |
| TP9 | TBD | |
| TP10 | TBD | |
| TP11 | TBD | |
| TP12 | TBD | |
| TP14 | TBD | |
| TP18 | TBD | Bottom of back side |
| TP48 | TBD | Bottom right of back side |

Priority: find UART TX/RX test points — there may be a console UART that outputs boot messages.

## Comparison with Other Lutron Processors

| Feature | RR-MAIN-REP-WH | RR-SEL-REP2 | Vive Hub | RA3 (Phoenix) |
|---------|----------------|-------------|----------|---------------|
| Main SoC | MCF527x ColdFire V2 | TI AM335x | TI AM335x | TI AM3351 |
| Architecture | ColdFire (m68k) | ARM Cortex-A8 | ARM Cortex-A8 | ARM Cortex-A8 |
| OS | RTOS (MQX?) | Linux 3.12 | Linux 4.4 | Linux |
| Radio | CC110L (1x?) | STM32L100 + 2x CC110L | STM32L100 + 2x CC110L | EFR32 + Kinetis |
| CCX | No | No | No | Yes (Thread) |
| Storage | External flash | NAND (UBI) | eMMC (GPT) | eMMC |
| Debug | BDM 26-pin | UART (root, no auth) | UART (root, no auth) | UART |
| Integration | Telnet:23, RS232 | None (HomeKit only) | None | LEAP:8081 |
| Max devices | 200 | 40 | 700 | 200+ |
| Power | 9V DC external | Barrel jack | Barrel jack | PoE + barrel |
| Link type | 9 (Clear Connect) | 9 (Clear Connect) | 30 (Vive CC) | 9+40 (CCA+CCX) |

## Attack Plan

**Assumption**: BDM SECSTAT is set (ColdFire security enabled, BDM read access locked). This means we cannot simply connect a debugger and dump memory. Alternative extraction paths are needed.

### Phase 1: Non-invasive Recon (Ethernet + RS232)

1. **Power up, DHCP scan** — watch for IP assignment, broadcast traffic
2. **Port scan**: `nmap -sV -p- <ip>` — expect telnet:23, possibly HTTP
3. **RS232 console**: connect at 9600 8N1 (default RA2 integration baud), also try 115200 for boot/debug output
4. **Telnet integration login**: default `lutron` / `integration` (documented in Lutron integration guides)
5. **Probe for hidden services**: check all ports, look for HTTP admin, debug shells, TFTP
6. **Firmware update mechanism**: trigger a firmware update (if system connects to Lutron CDN) and capture the traffic — the update binary IS the firmware

### Phase 2: Board Analysis

7. **Read ALL IC markings** — photograph with good light, especially:
   - MCF527x exact part number (MCF5271? MCF5274? MCF5275?)
   - **External flash chip** (this is the #1 priority — NOR/SPI flash, likely near MCF527x)
   - External SDRAM chip
   - Ethernet PHY
   - Radio chip (confirm CC110L vs CC1101)
   - RS232/RS485 transceivers
8. **Map test points** — continuity test to find UART TX/RX (look for 3.3V idle-high signals)
9. **Trace unpopulated USB** — where do D+/D- route? If to MCF527x USB pins, could enable USB boot/DFU
10. **Identify unpopulated switch** — trace to what pin; could be boot mode select or BDM security override

### Phase 3: Firmware Extraction (bypassing SECSTAT)

Three paths, roughly ordered by difficulty:

#### Path A: SPI Flash Dump (easiest — but secondary storage only)
The S25FL116K (2 MB SPI NOR, SOIC-8) is secondary storage (config, database, radio tables). NOT the main firmware — that's in the BGA parallel NOR. Still worth dumping as a first step.

11. **In-circuit read**:
    - Hold MCF527x in reset (pull RESET# low via BDM header pin 8)
    - Connect to SPI flash (SOIC-8 clip, or tack wires if clip doesn't fit)
    - Read with CH341A: `flashrom -p ch341a_spi -r ra2-spi-flash.bin`
    - Verify: read twice, compare SHA-256
12. **If bus contention**: lift pin 1 (CS#) to isolate from MCF527x
13. **2 MB dump** — expect: device database, pairing tables, CCA config, possibly firmware update staging

#### Path A2: Main Firmware Extraction (M28W320FCB — the real target)
The main firmware (bootloader + application, 4 MB) is in the parallel NOR flash (BGA). Cannot clip-read. Options:

14. **Software path first** — if RS232/telnet gives any memory dump capability, read the flash through the MCF527x at its mapped address (likely 0x00000000). Even a hex dump command would work.
15. **BDM with SECSTAT bypass** — if we can glitch past SECSTAT, full 4 MB readable via BDM memory read at the flash base address
16. **Firmware update capture** — intercept Designer pushing firmware; the update image IS the firmware
17. **BGA rework** — last resort: hot air desolder M28W320FCB, read on a parallel flash programmer (TL866II+ supports M28W320), reball and resolder

#### Path B: Firmware Update Capture
15. **Check firmware CDN** — the Lutron S3 buckets we already mapped may have RA2 Main Repeater firmware (check `ra2-main-rep` or similar keys)
16. **MITM firmware update** — if the device checks for updates over HTTP (not HTTPS), intercept the download. Older QS-class devices may not use TLS for updates.
17. **Capture from Designer** — Lutron Designer can push firmware to processors. Capture the transfer on the wire.

#### Path C: Voltage Glitch on BDM Security
18. **Characterize the security check** — ColdFire SECSTAT is typically checked at BDM init. A well-timed voltage glitch during the security verification can cause it to skip the check.
19. **Glitch setup** — similar to the GRX keypad HC705 approach: precise voltage fault on VCC during BDM handshake. Requires ChipWhisperer or similar glitch hardware.
20. **If glitch succeeds** — full BDM access, dump everything including OTP/config bits

### Phase 4: Analysis

21. **Ghidra** — ColdFire/m68k well-supported, use "68000:Coldfire" processor module
22. **Find strings** — telnet command handlers, integration protocol, CCA packet processing, RTOS markers (MQX has distinctive strings)
23. **Map memory layout** — bootloader, app, config, radio register tables
24. **Map CCA radio interface** — SPI or UART between MCF527x and CC110L?
25. **Compare with ESN firmware** — same ColdFire family, may share code patterns and RTOS

## Key Questions

1. **Exact MCF527x variant?** — determines memory map, peripherals, USB capability
2. **External flash chip?** — part number determines read method and total firmware size
3. **What RTOS?** — MQX strings would confirm; could also be VxWorks or bare-metal
4. **Firmware update protocol?** — HTTP? TFTP? Proprietary? Encrypted?
5. **Does the radio chip have separate firmware?** — CC110L is register-configured (no firmware), but need to confirm it's CC110L
6. **What's the unpopulated switch for?** — if it's connected to a boot mode pin, it could enable alternate boot (UART boot, BDM bypass)

## Lutron Processor Classes

Three distinct hardware generations:

### 1. Older QS Class (ColdFire, bare-metal/RTOS)
- **RadioRA 2**: RR-MAIN-REP-WH ← **this device**
- **HomeWorks QS**: HQP6-1, HQP6-2, HQP6-MDU
- **Quantum**: QSE-CI-NWK-E (likely similar platform)
- MCF527x ColdFire V2, external flash, telnet integration, RS232/RS485, CCA only

### 2. Caseta Class (AM335x "Sandwich Tern", Linux)
- **Caseta**: L-BDG2-WH
- **Caseta Pro**: L-BDG3-WH (lite-heron — actually modified Phoenix)
- **RA2 Select**: RR-SEL-REP2
- AM335x + STM32L100 + CC110L, Linux, LEAP API, CCA only

### 3. RF-Only Class (Phoenix, Linux)
- **RadioRA 3**: RR-PROC3
- **HomeWorks QSX**: HQP7-RF, HQP7-RF-2
- **Athena**: AT-PROC
- AM3351 + EFR32 (CCA) + Kinetis (CCX), Linux, LEAP API, CCA + CCX

The HQP6 processors are likely the closest hardware match to this device — same era, same class, same ColdFire platform. Any techniques that work here should transfer directly.

## Related Devices

- **RR-AUX-REP-WH** — Auxiliary Repeater, CCA relay only, connects via RS485 to Main Repeater
- **HQP6-2** — HomeWorks QS Processor, same Older QS class, likely near-identical hardware
- **L-BDG2-WH** — Connect Bridge, adds LEAP/HomeKit to RA2 systems (Caseta class, different platform)
- **QSE-CI-NWK-E** — Quantum Network Interface, possibly same ColdFire platform
