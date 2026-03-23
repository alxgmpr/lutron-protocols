# Telnet Integration Protocol Analysis (2026-02-09)

Source: `telnet-reference.pdf` — Lutron Integration Protocol Guide, Revision AH, 172 pages.
Covers: QS Standalone, RadioRA 2, Quantum, Athena, HomeWorks QS, myRoom plus.

## Key Mapping: Telnet Action Numbers <-> CCA/CCX

The telnet protocol's action numbers are consistent across ALL Lutron systems and map to CCA/CCX binary protocols:

### OUTPUT Actions (zone/load control — maps to bridge/Vive format 0x0E)
| Action | # | CCA | CCX |
|--------|---|-----|-----|
| Set Zone Level | 1 | Format 0x0E SET_LEVEL (level + fade + delay) | Type 0 LEVEL_CONTROL |
| Start Raising | 2 | Hold-start 0x09 + dim steps 0x0b (raise) | Type 2 DIM_HOLD |
| Start Lowering | 3 | Same (lower direction) | Type 2 DIM_HOLD |
| Stop Raise/Lower | 4 | Hold-release | - |
| Start Flashing | 5 | Unknown in CCA | - |
| Pulse Time | 6 | CCO pulse | - |
| Tilt Level | 9 | Shade tilt | CCX COMPONENT_CMD? |
| Lift & Tilt | 10 | Shade lift+tilt | CCX COMPONENT_CMD? |
| Motor Jog | 18-21 | - | CCX COMPONENT_CMD params? |

### DEVICE Actions (component control — maps to pico/keypad packets)
| Action | # | CCA | CCX |
|--------|---|-----|-----|
| Press / Occupied | 3 | Button press packet | Type 1 BUTTON_PRESS |
| Release / Unoccupied | 4 | Button release | - |
| Hold | 5 | CCA hold command | - |
| Double-tap | 6 | CCA double-tap | - |
| Scene | 7 | - | Type 36 SCENE_RECALL |
| LED State | 9 | Format 0x11 LED config | - |
| Light Level | 14 | Pico set-level (through zone controller) | - |
| Zone Lock | 15 | Config format? | - |
| Scene Lock | 16 | Config format? | - |
| Raise | 18 | Start raising | - |
| Lower | 19 | Start lowering | - |
| Stop | 20 | Stop | - |
| Hold Release | 32 | Hold-release packet | - |

## OUTPUT vs DEVICE: The Fundamental Split

This is the most important architectural insight:
- **OUTPUT** = direct zone/load control with level + fade + delay. Maps to bridge format 0x0E (8-byte payload with fade at byte 19).
- **DEVICE** = component-based control (buttons, LEDs, zone controllers). Maps to pico/keypad packets (5-byte payload, no fade field).

### Implications for Pico Set-Level
- DEVICE action 14 (Set Light Level) DOES accept level + fade + delay parameters in QS Standalone
- But for RadioRA 2: "Use OUTPUT command with equivalent action number" — i.e., RadioRA 2 devices expect level+fade via OUTPUT, not DEVICE
- Pico is strictly a DEVICE — its telnet integration only supports Press(3) and Release(4)
- The pico set-level hack works because DEVICE action 14 carries a level value, but the ~1-2 min slow fade is likely the dimmer's **default ramp rate** for non-OUTPUT commands
- The slow fade is NOT a bug — it's the dimmer applying its programmed/default fade rate when receiving a level change through a DEVICE path rather than an OUTPUT path

## Quarter-Second Fade Resolution is Universal

Doc states: "Fractional seconds will be rounded down to the nearest quarter second" — appears in EVERY command with fade/delay. Confirms CCA byte 19 encoding: `byte19 = seconds * 4` (quarter-seconds). Default fade = 1 second (0x04). Min = 0.25s (0x01).

## Component Number Patterns

### Pico (DEVICE)
- Non-4B: Button 1=2, Button 2=3, Button 3=4, Raise=5, Lower=6
- PJ2-4B: Button 1=8, Button 2=9, Button 3=10, Button 4=11

### Keypads (seeTouch, Hybrid, etc.)
- Buttons: component 1-17 (varies by model)
- **LEDs = button number + 80** (LED 1=81, LED 2=82, etc.)
- Raise/Lower: component 16-25 range

### GRAFIK Eye QS
- Zone controllers: 1-24
- Scene buttons: 70,71,76,77,83
- Scene controller: 141
- LEDs: 201, 210, 219, 228, 237 (scene LEDs)
- Occupancy sensors: 500-529 (wireless), 700-763 (EcoSystem)

## Fan Speed Level Bands
0%=Off, 1-25%=Low, 26-50%=Medium, 56-75%=Med-High, 76-100%=High.
Same 0-100% level encoding, just interpreted in bands.

## Device Serial Numbers = 8-char Hex (32-bit)
`?INTEGRATIONID,1,5678EFEF` — the 8-char hex is the same 32-bit device ID we use in CCA (e.g., 0x0595E68D).

## MONITORING Types -> CCA Packet Categories
| Type | # | CCA Relevance |
|------|---|---------------|
| Diagnostic | 1 | Debug/diag |
| Button | 3 | BTN packets |
| LED | 4 | LED config (0x11) |
| Zone | 5 | STATE_RPT / level feedback |
| Occupancy | 6 | Occ sensor packets |
| Scene | 8 | Scene recall |
| HVAC | 17 | HVAC packets |
| Mode | 18 | System mode |
| Shade Group | 23 | Shade group packets |

## AREA Model
- Areas contain zones and devices
- Scenes: 0-32 (0=Off), per-area
- Scene activation = action 6 with scene number
- Occupancy states: 3=Occupied, 4=Unoccupied, 255=Unknown (same as Press/Release!)
- Maps to CCX SCENE_RECALL (type 36) and DEVICE_REPORT (type 27)

## "Clear Connect Device" (CCD) Prefix
Page 145: Maestro dimmer models include "Clear Connect Device Models (CCD-W)" — official name for the CCA-family devices.

## Systems Covered
- **QS Standalone**: QS Link (RS485), integration via QSE-CI-NWK-E
- **RadioRA 2**: RF (CCA), integration via Main Repeater telnet/RS232
- **Quantum**: Commercial, integration via QSE-CI-NWK-E
- **Athena**: Newest commercial (Ketra + QS + EcoSystem), integration via QSE-CI-NWK-E
- **HomeWorks QS**: Premier residential, integration via HQP6-2 processor
- **myRoom plus**: Hospitality, integration via GCU-HOSP

All share the same command structure, action numbers, and device model. The binary CCA/CCX protocols are the RF/Thread transport for these same logical commands.
