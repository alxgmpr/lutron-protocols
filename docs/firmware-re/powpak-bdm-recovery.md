# PowPak BDM Recovery — re-flashing a bricked HCS08

For when an OTA attempt erased the application section and the device is no longer responsive over RF. Documented here in concrete-enough form to actually execute. Tested target: RMJ 0x00BC2107 (line-voltage RMJ-16R-DV-B 434 MHz), bricked 2026-04-29.

## What's bricked

The MCU itself isn't damaged — the **application section in flash is empty/erased** (or partly written and unbootable), so on power-up:
- Bootloader runs from section A (~0x0000-0xE92B), wired to the reset vector.
- Bootloader hands off to the application entry point at section B (0xE92C+).
- Application is gone → either CPU executes garbage opcodes and traps, or the bootloader's "no valid app" check silently halts.
- LED, relay, and CC1101 are all driven by the application; nothing is alive.

The bootloader is almost certainly intact (NVPROT-protected per `powpak.md`'s flash-protection notes), so re-flashing the application section restores the device.

## Hardware needed

### MCU identification

PowPak Relay 1.49/1.53 firmware binaries are consistent with **HCS08 banked-flash**, likely **MC9S08QE128** or close family member (LH/LL/PA — same instruction set). Page bytes in CALL instructions and the LAP register at `$181E` are the giveaways. Confirm against the silkscreen on the MCU package once the unit is open; expect a Freescale/NXP part number like `MC9S08QE128CLH` or `MC9S08LL64CLH` in a 32/44/48-pin LQFP.

The exact variant determines:
- Total flash size (64 KB / 96 KB / 128 KB)
- BKGD pin location on the package (per datasheet)
- Whether SEC bit at `$1FDF` blocks reads (it does on QE128)

### Programmer

Two viable options, both speak the HCS08 single-wire BDM protocol:

| Programmer | Cost | Notes |
|---|---|---|
| **USBDM** (open source, podonoghue) | $30-40 | DIY or buy on eBay/AliExpress/Tindie. Software runs Linux/Mac/Windows. Project: https://github.com/podonoghue/usbdm-eclipse-makefiles-build/releases |
| **P&E Multilink Universal** | $80-200 | Commercial, "official" path. Ships with NXP tools, also works with USBDM software. |
| **PEMicro Cyclone Universal FX** | $700+ | Production programmer, overkill for one device. |

USBDM is the recommended path — cheapest, well-supported, runs on Mac (the dev machine in this project). The pre-built USBDM_Programmer GUI (Java + Eclipse) reads/writes/erases HCS08 over BDM.

### BDM connector pinout (single-wire)

HCS08 BDM uses 1 signal wire (BKGD) plus reset and power references. Standard 6-pin header layout per Freescale AN3335:

```
  Pin 1: BKGD       ← single-wire BDM data
  Pin 2: GND
  Pin 3: NC
  Pin 4: RESET      ← active-low
  Pin 5: NC
  Pin 6: VDD        ← target VDD reference (3.3V on PowPak)
```

PowPak boards almost certainly have these pads broken out somewhere (Lutron uses them for factory programming). They may be:
- **Populated header**: a 6-pin or 4-pin .050"/.100" pitch header on the PCB silkscreen.
- **Unpopulated thru-holes**: 4-6 holes near the MCU labeled BKGD/RST/VDD/GND. Solder in pin headers or use pogo-pin clips.
- **Test pads only**: small round pads adjacent to the MCU. Use a pogo-pin jig or carefully tack-solder enclosed wires.

If the board has no obvious pads, fly-wire directly to MCU pins:
- For MC9S08QE128 LQFP-44: BKGD is **pin 5**; RESET is **pin 6**; VDD/VSS depend on package.
- For MC9S08LL64 LQFP-32: BKGD is **pin 25**; RESET is **pin 26**.
- Verify against the actual datasheet of whatever part is silk-screened.

### Power

The HCS08 needs 3.3V on VDD to operate during BDM. Two options:
1. **Use the device's onboard supply.** Apply 120V (or whatever the PowPak's mains rating is — RMJ-16R-DV-B is a "Direct Voltage" line-voltage device) to the device's input terminals. The onboard SMPS will produce 3.3V for the MCU. Use a current-limited variac or an isolation transformer for safety, especially while flying-wires to the MCU.
2. **Inject 3.3V externally.** If the SMPS is suspect (or you don't want line voltage on the bench), disconnect the SMPS output and feed 3.3V from a bench supply directly to the MCU's VDD pin. Verify with a meter first.

Option 2 is safer; option 1 keeps everything in-situ.

## Software

### USBDM tools

Install on Mac (we're on darwin):

```sh
# Clone the build artifacts (binaries + JAR)
brew install --cask usbdm   # if homebrew tap exists; otherwise:
# Manual: download from https://github.com/podonoghue/usbdm-eclipse-makefiles-build/releases
# Look for: usbdm-pkg-mac-X.Y.Z.dmg or similar
# After install, GUI is at /Applications/USBDM/USBDM_Programmer.app
```

CLI alternative (if dmg unavailable on Apple Silicon):
- Source build: https://github.com/podonoghue/usbdm-eclipse-makefiles-build
- Or run the Linux x86_64 tools under Rosetta 2.

### Original RMJ firmware (the image to flash back)

The factory RMJ image is on disk:
- `data/designer-firmware/QuantumResi/BinDirectory/Firmware/QuantumResi/qs_firmware_and_tools/powpak%20modules/PowPakRelay434_1-49.LDF` (100,056 bytes — 128-byte LDF header + 99,928-byte body)
- `data/firmware-re/powpak/PowPakRelay434_1-49.bin` (99,928 bytes, plain HCS08 image — LDF header already stripped, sha256 `61fdafb984ff79e37ec4ac3af301df518f83cd420727607aca69a31e9187d853`)

**Use the `.bin` (without LDF header).** This is the raw image that should sit at flash offset `0x0000`. Drive the flash via [tools/firmware/bdm-recovery.sh](../../tools/firmware/bdm-recovery.sh).

DeviceClass at body offset `0x8AD` is `0x16 0x03 0x02 0x01` (RMJ-16R-DV-B 434 MHz NA — matches the bricked unit's label).

If the bricked unit has a *different* DeviceClass (check the SKU on the label: `RMJ-2DSC-1-B` for 0-10V dimmer, `RMJ-CCO1-24-B` for contact closure), use the matching binary:

| File | SKU | DeviceClass at 0x8AD |
|---|---|---|
| `PowPakRelay434_1-49.bin` | RMJ-16R-DV-B (relay 434 MHz) | 16 03 02 01 |
| `PowPakRelay868_1-49.bin` | (relay 868 MHz EU) | 16 01 02 01 |
| `RFCCO434_1-51.bin` | RMJ-CCO1-24-B (contact closure) | 16 07 04 01 |
| `RFZeroTen434_1-34.bin` | RMJ-2DSC-1-B (0-10V) | 16 06 02 01 |

## Procedure

### Step 1 — Identify the MCU

Power off the device, open the case (PowPak modules are usually two snap halves or have 2-4 small Phillips screws). Find the MCU. Photo it clearly — for a one-off recovery, identifying the part number is non-negotiable: pinout depends on it.

Look for a Freescale/NXP MCU in a square or rectangular package with `MC9S08...` in the silkscreen. The CC1101 (radio) is a separate chip, smaller, with `CC1101` printed on it. Don't confuse them.

### Step 2 — Locate BDM access points

Look for, in priority order:
1. A populated 4-6 pin header near the MCU.
2. Unpopulated thru-holes labeled BKGD / RST / VDD / GND on silkscreen.
3. Test points adjacent to the MCU. Use the datasheet pinout to identify which is BKGD; trace adjacent pads with a multimeter on continuity (BKGD typically has a pull-up to VDD; RESET also has a pull-up to VDD).
4. Last resort: tack a wire directly to the BKGD pin on the MCU package.

### Step 3 — Wire the programmer

```
USBDM    ←→   PowPak
─────────────────────
BKGD     ←→   BKGD pin or test pad
RESET    ←→   RESET pin or test pad
GND      ←→   GND pad anywhere
VDD      ←→   3.3V VDD ref pad (NOT line voltage; this is the SMPS output side)
```

USBDM auto-senses target VDD; you don't power the target FROM the programmer.

### Step 4 — Power up the target

Either:
- Apply mains to the PowPak's 120V (or whatever) terminals. **Use an isolation transformer.** Don't reach for the BDM cable while it's hot. Power up, verify 3.3V on the MCU's VDD pin, then connect USBDM.
- Or feed 3.3V from a bench supply directly to the MCU VDD/VSS pins. Don't apply mains in this mode; disconnect the SMPS first.

### Step 5 — Connect via USBDM_Programmer

```
1. Launch USBDM_Programmer.app
2. Select target: HCS08 → MC9S08QE128 (or whatever part you identified)
3. Click "Detect Chip" — should report SDID match. If no detect, RECHECK wiring + power.
4. Click "Mass Erase".
   - If SEC bit is set at $1FDF, the chip will refuse a normal "Read", but Mass
     Erase still works. Mass Erase clears flash AND clears SEC. After this, the
     chip is unlocked.
5. Click "Program" → load the .bin (e.g., `PowPakRelay434_1-49.bin`).
   - Target address: 0x0000 (start of flash).
   - Verify the program target memory map matches the part's flash size.
6. Click "Verify" — confirms write integrity.
7. Click "Reset to User mode" or just disconnect BKGD; chip should boot the
   freshly written firmware.
```

CLI equivalent (if running headless):
```sh
# USBDM_GDIServer + telnet-style commands, OR:
# USBDM_Programmer can be driven by command-line parameters; see -? help.
USBDM_Programmer --target MC9S08QE128 --erase --program PowPakRelay434_1-49.bin --verify --reset
```

### Step 6 — Verify recovery

1. Disconnect BDM cables.
2. Power-cycle the device (full unplug, 10s pause, plug back in).
3. The power LED should flash on power-up.
4. Press the device's button — LED should respond.
5. Pair the device to its host system (ESN for RMJ). If pairing succeeds, full recovery confirmed.

If the device boots but doesn't pair, the application section is correct but the factory-config block at body offset `0x8AD` may have lost its serial/ID values (we wrote a generic image without per-unit serialization). Some Lutron PowPak SKUs have unique serial numbers in the factory-config block; flashing the generic image gives the device a "factory-fresh" identity. It will still pair, but with the binary's stock serial — not the original `0x00BC2107`.

If the device's identity matters (e.g., if it was already paired in a project file), you would need to splice the original device's serial into the binary at body offset `0x8AD`. We did NOT extract that information before bricking, so this option is foreclosed for unit `0x00BC2107`. Going forward, **read the device's full flash via BDM before flashing it** so you have a backup of the per-unit factory-config block.

## Lessons / changes for future Phase 2 work

1. **Acquire BDM tooling BEFORE the next OTA test.** USBDM is cheap. Get one on the bench so any future brick is recoverable in minutes, not days.
2. **Read the device's flash via BDM first** if the SEC bit is unset, OR record at minimum the device's serial-side identifying bytes (label photo, plus the body 0x8AD region if accessible).
3. **Send Device-poll (`06 03`) FIRST in Phase 2a, not BeginTransfer.** Poll has no payload, no flash side-effects. If the unpaired device responds to poll (visible 0x0B ACK), then proceed to BeginTransfer. If poll gets no response, the unpaired bootloader is dormant and BeginTransfer won't work either.
4. **Capture an ESN→RMJ exchange** on a real ESN system to learn what packet format an unpaired RMJ actually responds to. Without that ground truth we're guessing.

## References

- HCS08 BDM protocol: Freescale AN3335 (Application Note: Hardware design considerations for HCS08-based products).
- MC9S08QE128 datasheet: NXP doc number `MC9S08QE128RM` (reference manual).
- USBDM project: https://github.com/podonoghue/usbdm-eclipse-makefiles-build
- This project's PowPak HCS08 RE: [powpak.md](powpak.md)
- Conversion-attack plan that triggered the brick: [powpak-conversion-attack.md](powpak-conversion-attack.md) §"2026-04-29: Brick incident on RMJ 0x00BC2107"
