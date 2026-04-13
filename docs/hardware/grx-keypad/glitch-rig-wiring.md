# MC68HC705C8A VDD Glitch Rig

GRX keypad firmware extraction via Pi Pico voltage glitch attack.

## Target MCU

MC68HC705C8A QFP-44 (CFNE package), from Lutron GRX keypad.
Datasheet: Freescale MC68HC705C8A/D Rev.3, March 2002.

## QFP-44 Pinout (from datasheet Figure 1-5)

```
                  TCMP PD5  PD4  PD3  PD2  PD1  PD0  PC0  PC1  PC2  PC3
                   /SS  /SCK /MOSI/MISO /TDO /RDI
                   33   32   31   30   29   28   27   26   25   24   23
              ┌────┴────┴────┴────┴────┴────┴────┴────┴────┴────┴────┴──┐
      PD7  34 ┤                                                         ├ 22  NC
     TCAP  35 ┤                                                         ├ 21  PC4
     OSC2  36 ┤                                                         ├ 20  PC5
     OSC1  37 ┤              MC68HC705C8A                               ├ 19  PC6
      VDD  38 ┤                QFP-44                                   ├ 18  PC7
       NC  39 ┤                                                         ├ 17  VSS
       NC  40 ┤                                                         ├ 16  NC
    RESET  41 ┤                                                         ├ 15  PB7
      IRQ  42 ┤                                                         ├ 14  PB6
      VPP  43 ┤                                                         ├ 13  PB5
              └──┬────┬────┬────┬────┬────┬────┬────┬────┬────┬────┬────┘
               ○ 1    2    3    4    5    6    7    8    9   10   11   12
                PA7  PA6  PA5  PA4  PA3  PA2  PA1  PA0  PB0  PB1  PB2  PB4
```

## Wiring

### Power

| MCU Pin | Signal | Connection |
|---------|--------|------------|
| 38 | VDD | +5V rail **(glitch injection point)** |
| 43 | VPP | **Tie to VDD** (GND = permanent damage) |
| 17 | VSS | GND |
| — | Bypass | 100µF + 100nF, close to pins 38/17 |

### Glitch Crowbar (Q2 MMBT3904)

```
+5V ──── R4 (33Ω) ──┬── Q2 collector
                     │
                     └── VDD pin 38
Q2 emitter ── GND
Q2 base ←── R3 (1KΩ) ←── Pico GP3
```

GP3 HIGH fires a brief VDD crowbar through 33Ω, corrupting the SEC bit read.

### Reset Control (Q1 MMBT3904)

```
+5V ──── R1 (10KΩ) ──┬── RESET pin 41
                      │
                      └── Q1 collector
Q1 emitter ── GND
Q1 base ←── R2 (1KΩ) ←── Pico GP2
```

GP2 HIGH = hold RESET low. GP2 LOW = release (R1 pulls high).

### Clock

| MCU Pin | Connection |
|---------|------------|
| 37 (OSC1) | Pico GP0/PWM — 2 MHz square wave |
| 36 (OSC2) | No connect (external clock mode, datasheet Fig 1-11) |

### Bootstrap Entry

| MCU Pin | Connection |
|---------|------------|
| 42 (IRQ) | Hardwire to GND |

### SCI Serial

| MCU Pin | Signal | Pico Pin |
|---------|--------|----------|
| 28 (PD1/TDO) | SCI TX (dump data out) | GP5/RX1 |
| 27 (PD0/RDI) | SCI RX (baud sync in) | GP4/TX1 |

Baud: 4800 @ 2 MHz clock, 9600 @ 4 MHz clock. 8N1.

### Mode Select — Dump PROM Contents (Table 9-2)

| MCU Pin | Signal | State | Switch |
|---------|--------|-------|--------|
| 32 | PD5/SS | GND | S3=Off |
| 31 | PD4/SCK | +5V | S4=On |
| 30 | PD3/MOSI | +5V | S5=On |
| 29 | PD2/MISO | GND | S6=Off |

## Pi Pico GPIO Summary

| GPIO | Function | Target |
|------|----------|--------|
| GP0 | PWM 2 MHz clock | OSC1 (pin 37) |
| GP2 | RESET control via Q1 | RESET (pin 41) |
| GP3 | GLITCH trigger via Q2 | VDD (pin 38) |
| GP4 | UART1 TX | PD0/RDI (pin 27) |
| GP5 | UART1 RX | PD1/TDO (pin 28) |
| GND | Common ground | VSS (pin 17) |

## Glitch Attack Sequence

1. Pico sets GP2 HIGH — holds MCU in reset
2. Pico sets mode pins (hardwired for dump)
3. Pico releases reset (GP2 LOW)
4. MCU bootloader sends break character on PD1/TDO
5. Pico replies 0xFF on GP4 (baud rate sync)
6. Bootloader checks SEC bit at **$1FDF bit 3**
7. **Pico fires GP3 glitch pulse (~50-100ns)** — crowbars VDD through 33Ω
8. If SEC read is corrupted → bootloader falls through to dump
9. MCU dumps $0020-$1FFF (8160 bytes) on SCI at 4800 baud
10. If no dump → reset and try next delay offset

Automate the delay sweep — try thousands of offsets unattended.

## Components

- 2x MMBT3904 NPN (SOT-89, from GRX keypad board — marking "rla bh" / ON Semi)
- 1x 33Ω resistor (glitch current limit)
- 1x 10KΩ resistor (RESET pullup)
- 2x 1KΩ resistor (base drive)
- 1x 100µF electrolytic (bulk bypass)
- 1x 100nF ceramic (decoupling)
- 1x Raspberry Pi Pico
