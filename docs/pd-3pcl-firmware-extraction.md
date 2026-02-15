# PD-3PCL Firmware Extraction Plan

Reverse engineering the Lutron PD-3PCL lamp dimmer by extracting firmware from its STM8L151Cx MCU via voltage fault injection.

## Target Hardware

**Device**: Lutron PD-3PCL (Caseta plug-in lamp dimmer)
**MCU**: STM8L151Cx, LQFP48 package, 3.3V, 8KB flash, 1KB RAM
**Debug interface**: SWIM (Single Wire Interface Module) on PA0 (pin 1)
**Bootloader**: ROM-resident at 0x6000-0x8000, UART-based, shared across STM8L151/152 family

### LQFP48 Pinout (relevant pins)

```
                        48  47  46  45  44  43  42  41  40  39  38  37
                       PE7 PE6 PC7 PC6 PC5 PC4 PC3 PC2 Vio Vio PC1 PC0
                        |   |   |   |   |   |   |   | GND VDD  |   |
                   +----+---+---+---+---+---+---+---+---+---+---+---+----+
    PA0/SWIM    1 -|*                                                     |- 36  PD7
    NRST/PA1    2 -|                                                      |- 35  PD6
    PA2/USART_TX 3-|                                                      |- 34  PD5
    PA3/USART_RX 4-|                                                      |- 33  PD4
    PA4         5 -|                  STM8L151Cx                          |- 32  PF0
    PA5         6 -|                   LQFP48                             |- 31  PB7/SPI_MISO
    PA6         7 -|                                                      |- 30  PB6/SPI_MOSI
    PA7         8 -|                                                      |- 29  PB5/SPI_SCK
    VSS/VSSA    9 -|                                                      |- 28  PB4/SPI_NSS
    VDD        10 -|                                                      |- 27  PB3
    VDDA       11 -|                                                      |- 26  PB2
    VREF+      12 -|                                                      |- 25  PB1
                   +----+---+---+---+---+---+---+---+---+---+---+---+----+
                        |   |   |   |   |   |   |   |   |   |   |   |
                       13  14  15  16  17  18  19  20  21  22  23  24
                       NC  PE0 PE1 PE2 PE3 PE4 PE5 PD0 PD1 PD2 PD3 PB0
```

### Test Pads (on PCB back)

4 grouped pads identified. Suspected SWIM debug header:

| Pad | Signal | Idle Voltage | MCU Pin |
|-----|--------|-------------|---------|
| 1   | VSS (GND) | 0V | Pin 9 |
| 2   | VDD | 3.3V | Pin 10 |
| 3   | NRST | 3.3V (internal pull-up) | Pin 2 |
| 4   | SWIM (PA0) | 3.3V (internal pull-up) | Pin 1 |

All 3 non-ground pads sit at 3.3V while running, consistent with SWIM (not UART, where RX would float).

### USART Pins (for bootloader communication)

The STM8L151 bootloader uses USART1. Default pin mapping:

| Function | Pin | LQFP48 |
|----------|-----|--------|
| USART1_TX | PA2 | Pin 3 |
| USART1_RX | PA3 | Pin 4 |

Alternate mapping (via option byte remap):

| Function | Pin | LQFP48 |
|----------|-----|--------|
| USART1_TX | PC3 | Pin 42 |
| USART1_RX | PC2 | Pin 41 |

## Protection Mechanism

### STM8 Option Bytes

Two EEPROM option bytes control boot security:

| Byte | Address | Protected Value | Effect |
|------|---------|----------------|--------|
| CRP (ROP) | 0x4800 | 0xAA | Readout protection enabled |
| BL (Bootloader Enable) | 0x480B (STM8L) | 0x55 | Bootloader enabled |

### Bootloader Control Flow (from disassembly of STM8L152C6)

```
_reset:
    sim                         ; disable interrupts
    ld A, #0x8000               ; load first flash byte
    cp A, #0x82                 ; check if "valid" firmware
    jreq _chk_bl
    cp A, #0xAC                 ; check alternate valid marker
    jreq _chk_bl
    ; chip is "empty" — fall through to chk_crp

_chk_bl:
    ld A, #0x480B               ; load BL option byte
    cp A, #0x55                 ; bootloader enabled?
    jreq _chk_crp
    jra _enter_app              ; BL disabled → run application

_chk_crp:
    ld A, #0x4800               ; load CRP option byte
    cp A, #0xAA                 ; readout protection disabled?
    jreq _serial_bl             ; YES → activate serial bootloader
    jpf _enter_app              ; NO → run application

_serial_bl:
    ; Initialize UART, pull RX high, wait for commands
    ; NO FURTHER CRP CHECKS — full read/write access granted
```

### Protection Matrix

| CRP | BL | First flash byte | Bootloader state | Glitches needed |
|-----|----|-----------------|-----------------|-----------------|
| off (0xAA) | on (0x55) | any | Active, full access | 0 |
| on | on (0x55) | any | Blocked at CRP check | 1 |
| off (0xAA) | off | valid (0x82/0xAC) | Blocked at BL check | 1 |
| **on** | **off** | **valid** | **Fully locked** | **2** |

Lutron almost certainly has both CRP on and BL off → **double glitch required**.

## Attack Strategy

Based on "Fill your Boots" (Van den Herrewegen et al., TCHES 2021) which demonstrated the first successful multi-glitch attack on real STM8L hardware.

Reference: https://doi.org/10.46586/tches.v2021.i1.56-81
Code: https://github.com/janvdherrewegen/bootl-attacks

### Overview

The attack corrupts the bootloader's option byte reads during the boot sequence by briefly dropping VDD. If the CRP byte is misread as anything other than 0xAA, the serial bootloader activates, granting full flash read access over UART.

A fully locked chip requires two glitches in quick succession:
1. **Glitch 1**: Skip the chk_empty/chk_bl check → fall through to chk_crp
2. **Glitch 2**: Corrupt the CRP comparison → enter serial bootloader

### Published Parameters (STM8L152C6, from Table 2 of the paper)

| Parameter | Symbol | Value |
|-----------|--------|-------|
| Normal operating voltage | V_CC | 3.3V |
| Glitch voltage | V_F | 1.84V |
| Glitch 1 width | W_0 | 50 ns |
| Glitch 1 offset from NRST rising edge | T_0 | 29.5 us |
| Glitch 2 width | W_1 | 50 ns |
| Glitch 2 offset from end of glitch 1 | T_1 | 7.32 us |
| Double-glitch success rate | | 0.0001% (1 in 1,000,000) |
| Required timing precision | | +/- 20 ns |
| Bootloader start time after NRST | | ~26 us |
| Internal clock at boot | | 2 MHz |

### Key Observations from the Paper

- The STM8L internal oscillator is very stable at 2 MHz, making glitch offsets repeatable.
- Glitches align with rising/falling edges of the 2 MHz clock (500 ns period).
- BOR (Brown-Out Reset) threshold can be as low as 1.8V. Operating at 3.3V with glitch to 1.84V stays above BOR.
- The 3-stage pipeline means glitch 2 timing differs between the profiled and real scenarios (pipeline contents differ when glitch 1 skips the BL check).
- The serial bootloader, once activated, has NO further CRP checks. Full read/write.
- UART protocol: **9600 baud, 8 data bits, even parity, 1 stop bit**.
- Sync byte: send 0x7F, expect 0x79 (ACK).
- Read command: 0x11, then 4-byte address + checksum, then byte count + checksum.
- ~100k attempts takes ~2.5 min on their setup. At 0.0001%, expect ~1M attempts = ~25 min.

## Equipment

### Attack Hardware

| Item | Purpose | Notes |
|------|---------|-------|
| **Nucleo-H723ZG** | Glitch generator + UART bridge | STM32H723 @ 550 MHz, ~1.8 ns timer resolution |
| **ST-LINK/V2 clone** | SWIM access for profiling chip | ~$4 from Amazon, supports SWIM protocol |
| **STM8L151C8 dev board** (or bare chip) | Profiling target | Must be freely programmable, same bootloader ROM |
| **N-channel MOSFET** | VDD crowbar switch | 2N7002, IRLML6344, or BSS138 (logic-level) |
| **Resistor network** | Voltage divider for V_F | Target: drop VDD to ~1.84V during glitch |
| **10 ohm resistor** | Current limiter on MOSFET drain | Prevents dead-short damage |
| **30 ohm shunt resistor** | Power analysis (optional) | Between VSS and ground, for timing characterization |
| **Capacitors** | Bypass caps on target VDD | 100nF ceramic close to MCU |
| **Dupont wires** | Connections to test pads | |

### Software/Tools

| Tool | Purpose |
|------|---------|
| stm8flash | SWIM programming of profiling chip |
| SDCC | Compile profiling stubs for STM8 |
| naken_asm | Disassemble bootloader ROM |
| STM32CubeIDE or PlatformIO | Nucleo firmware development |
| Python + pyserial | Automation and flash dumping |

## Execution Plan

### Phase 0: Initial Reconnaissance

**Goal**: Confirm SWIM presence and check if ROP is enabled.

1. Connect ST-LINK/V2 to the 4 test pads on PD-3PCL:
   ```
   ST-LINK     Test Pads
   --------    ---------
   VDD    ---- VDD pad (do NOT power from ST-LINK; let dimmer self-power)
   SWIM   ---- SWIM pad
   GND    ---- GND pad
   NRST   ---- NRST pad
   ```
2. Attempt to read:
   ```bash
   stm8flash -c stlinkv2 -p stm8l151c8 -s opt -r opt_bytes.bin
   ```
3. If reads succeed → ROP is off, dump flash directly:
   ```bash
   stm8flash -c stlinkv2 -p stm8l151c8 -r firmware.bin
   ```
4. If reads return all 0x00 or fail → ROP is enabled, proceed to Phase 1.

Also attempt to identify the exact STM8L151 variant (C2 = 4KB, C3 = 8KB) from the chip markings.

### Phase 1: Bootloader Extraction and Profiling Setup

**Goal**: Obtain the bootloader binary and characterize glitch parameters.

**Requires**: A second, freely-programmable STM8L151 chip (the "profiling chip").

1. **Dump the bootloader ROM** from the profiling chip via SWIM:
   ```bash
   # Bootloader lives at 0x6000-0x8000 on STM8L
   stm8flash -c stlinkv2 -p stm8l151c8 -s flash -r bootloader_region.bin
   # Also read from 0x6000 directly if stm8flash supports address ranges
   ```
   Alternatively, flash the `bl_dump.c` from the bootl-attacks repo, which dumps the bootloader over UART.

2. **Disassemble** the bootloader:
   ```bash
   naken_util -disasm -stm8 bootloader.bin
   ```
   Identify the exact offsets of chk_empty, chk_bl, chk_crp sections. Compare with the known STM8L152C6 bootloader in the repo (`stm8/bootloader/stm8L_bootloader.bin`). The STM8L151 likely has an identical bootloader.

3. **Flash profiling stubs** onto the profiling chip. For each Critical Bootloader Section (CBS):
   - Insert the CBS into a stub that triggers a GPIO before the check and sets another GPIO on "success" (reaching the wrong branch).
   - Use the enter_app.c template from the bootl-attacks repo.
   - Compile with SDCC, flash with stm8flash.

4. **Connect profiling chip to Nucleo**:
   ```
   Nucleo GPIO (trigger in) <---- Profiling chip GPIO (trigger out)
   Nucleo GPIO (result in)  <---- Profiling chip GPIO (success indicator)
   Nucleo GPIO (MOSFET gate) ----> MOSFET gate
   MOSFET drain -----------------> Profiling chip VDD (through voltage divider)
   MOSFET source ----------------> GND
   Nucleo GPIO (NRST) -----------> Profiling chip NRST
   ```

5. **Sweep V_F and W** at a fixed, short offset from the trigger GPIO:
   - Voltage range: 1.7V to 2.0V, step 0.01V
   - Width range: 40 ns to 130 ns, step ~2 ns
   - For each (V_F, W) pair, run 2000 reset-glitch-check cycles
   - Record success rate for each parameter pair
   - Expected sweet spot: V_F ~ 1.84V, W ~ 50 ns (from published results)

### Phase 2: Single-Glitch Timing Characterization

**Goal**: Find the exact glitch offset T for each bootloader check.

1. **Set option bytes** on profiling chip so only one glitch is needed:
   - For chk_bl: set CRP=off, BL=off → one glitch skips BL check
   - For chk_crp: set CRP=on, BL=on → one glitch skips CRP check

2. **Flash known firmware** with first byte = 0x82 (or 0xAC) to match expected Lutron firmware.

3. **Characterize boot timing** using power analysis:
   - Place 30 ohm shunt between VSS and ground
   - Capture voltage across shunt with Nucleo ADC or oscilloscope
   - Identify bootloader start time (~26 us after NRST high on STM8L)
   - Identify 2 MHz clock edges

4. **Sweep offset T** with V_F and W fixed from Phase 1:
   - Range: 25 us to 45 us (covers chk_empty through chk_crp)
   - Step: 0.01 us (10 ns)
   - For each T, run N reset cycles, monitor USART_RX pin going high
   - When USART_RX goes high → send 0x7F sync, expect 0x79 ACK
   - Record successful offsets

5. **Expected offsets** (from published STM8L152C6 results):

   | First byte | Section | T (us) | Success rate |
   |-----------|---------|--------|-------------|
   | 0x82 | chk_empty | 29.5 | 0.6% |
   | 0x82 | chk_bl | 35.75 | 0.1% |
   | 0xAC | chk_empty | 30.5 | 0.5% |
   | 0xAC | chk_bl | 36.25 | 0.1% |
   | 0x82 | chk_crp | 38.0 | 0.6% |
   | 0xAC | chk_crp | 39.0 | 0.5% |

### Phase 3: Double-Glitch Attack on Locked PD-3PCL

**Goal**: Bypass both protection checks and dump firmware.

1. **Connect Nucleo to PD-3PCL test pads**:
   ```
   Nucleo                           PD-3PCL
   ------                           -------
   MOSFET circuit ---- VDD pad      (glitch injection)
   GPIO (NRST)   ---- NRST pad     (reset control)
   UART TX       ---- USART1_RX    (PA3/pin 4 or PC2/pin 41)
   UART RX       ---- USART1_TX    (PA2/pin 3 or PC3/pin 42)
   GPIO (monitor)---- USART1_TX    (detect bootloader activation)
   GND           ---- GND pad
   ```

   **Note**: USART pins are on the MCU, not the test pads. You'll need to probe the MCU pins directly or find traces on the PCB. The test pads only expose SWIM/NRST/VDD/GND.

2. **Determine first flash byte**: We don't know if Lutron's firmware starts with 0x82, 0xAC, or something else. If neither, the bootloader considers the chip "empty" and skips chk_empty, which actually simplifies the attack (different T_0).

3. **Configure double-glitch parameters** based on Phase 2 profiling:
   ```
   T_0 = offset for chk_empty or chk_bl (from Phase 2)
   W_0 = 50 ns
   T_1 = offset for chk_crp relative to end of glitch 1
   W_1 = 50 ns
   V_F = 1.84V (from Phase 1)
   ```

4. **Attack loop** (runs on Nucleo):
   ```
   while not success:
       pull NRST low          // hold in reset
       wait 10 ms             // settle
       release NRST           // boot sequence begins
       wait T_0               // first check timing
       pulse MOSFET for W_0   // glitch 1: skip BL/empty check
       wait T_1               // second check timing
       pulse MOSFET for W_1   // glitch 2: corrupt CRP read
       wait 200 us            // let bootloader finish init
       check USART_RX pin     // did bootloader activate?
       if USART_RX high:
           send 0x7F sync byte
           if receive 0x79 ACK:
               SUCCESS — dump flash
               break
   ```

5. **Dump firmware** once bootloader is active:
   ```python
   # Read command: 0x11
   send([0x11, 0xEE])            # CMD_READ + complement
   recv_ack()                     # expect 0x79
   send([0x00, 0x00, 0x80, 0x00, 0x80])  # address 0x8000 + checksum
   recv_ack()
   send([0xFF, 0x00])            # read 256 bytes + complement
   data = recv(256)              # firmware bytes!
   ```
   Repeat for entire flash range (0x8000-0x9FFF for 8KB).

6. **Expected attempt count**:
   - At 0.0001% success rate: ~1,000,000 attempts
   - At ~40 attempts/second (25 ms per cycle): ~7 hours
   - At ~400 attempts/second (2.5 ms per cycle with fast reset): ~42 minutes
   - The paper reports 100k attempts in 2.5 min → ~660/sec → ~25 min for 1M

### Phase 4: Firmware Analysis

Once extracted:

1. **Disassemble** with naken_asm or load into Ghidra (STM8 support available)
2. **Identify CCA radio protocol handling** — the PD-3PCL is a Clear Connect Type A device
3. **Map peripheral usage** — which pins drive the TRIAC/dimming circuit, LED, capacitive touch
4. **Extract device ID** and any cryptographic keys stored in flash or EEPROM
5. **Compare** with known CCA protocol behavior from our RF captures

## Glitch Circuit Design

### Voltage Divider Glitch (Preferred)

Instead of crowbarring VDD to 0V (which resets the chip), use a voltage divider to drop VDD to ~1.84V:

```
             VDD (3.3V from dimmer's regulator)
              |
              +---[10 ohm]---+--- To MCU VDD/VDDA
              |              |
         MOSFET drain        |
              |              |
         MOSFET source       |
              |              |
              +---[R_div]----+
              |
             GND

MOSFET gate <---- Nucleo GPIO (push-pull, 3.3V)
```

When MOSFET is OFF: MCU sees full 3.3V through the 10 ohm resistor.
When MOSFET is ON: MCU VDD drops to V_F determined by the divider.

Calculate R_div: For V_F = 1.84V with 10 ohm series:
- R_div = 10 * 1.84 / (3.3 - 1.84) = 12.6 ohm → use 12 ohm

Alternatively, use the Nucleo's DAC to set V_F precisely and switch with the MOSFET. This is what the GIAnT board does.

### Simple Crowbar (Backup Approach)

```
        VDD (3.3V)
         |
    [10 ohm]---+--- MCU VDD
                |
           MOSFET drain
                |
           MOSFET source
                |
               GND

MOSFET gate <---- Nucleo GPIO
```

Brief pulse (50 ns) through 10 ohm limits current and creates a voltage dip. Less precise control over V_F — depends on MCU current draw and decoupling caps. **Remove or reduce decoupling caps near the target MCU** for this to work.

### Nucleo Timer Configuration

Use TIM1 or TIM2 on the STM32H723 in one-pulse mode:

- Clock: 275 MHz (AHB) or 550 MHz (if using PLL for timer)
- At 550 MHz: 1 tick = 1.8 ns
- 50 ns pulse = ~28 ticks
- 29.5 us delay = ~16,225 ticks
- Use chained timers: TIM1 triggers TIM2 for the second glitch

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Flash corruption from glitch | Glitch occurs during boot (read-only phase), not during writes. Low risk. |
| Chip damage from overcurrent | 10 ohm series resistor limits current. Brief pulses (50 ns) are safe. |
| Wrong USART pins | Try both default (PA2/PA3) and alternate (PC2/PC3) mappings |
| Different bootloader version | STM8L151 family likely shares bootloader with STM8L152. Verify with profiling chip. |
| BOR triggers during glitch | V_F = 1.84V is above minimum BOR threshold (1.8V). Disable BOR via option bytes on profiling chip. |
| Dimmer's power supply interference | Power the MCU from an external 3.3V supply during the attack, bypassing the dimmer's regulator |

## References

- Van den Herrewegen et al., "Fill your Boots: Enhanced Embedded Bootloader Exploits via Fault Injection and Binary Analysis", TCHES 2021. https://doi.org/10.46586/tches.v2021.i1.56-81
- bootl-attacks code: https://github.com/janvdherrewegen/bootl-attacks
- STM8 ROP bypass (VCAP glitch): https://itooktheredpill.irgendwo.org/2020/stm8-readout-protection/
- STM8L151 datasheet: DS7204
- STM8 bootloader user manual: UM0560
- SWIM protocol: UM0470
- GIAnT hardware: https://github.com/janvdherrewegen/bootl-attacks/tree/master/giant-hardware
