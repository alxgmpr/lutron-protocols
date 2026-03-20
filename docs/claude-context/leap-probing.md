# LEAP Route Probing Results (2026-02-15)

## Overview

Probed all known LEAP routes on both RA3 (10.0.0.1) and Caseta (10.0.0.2) processors.
Key finding: **Caseta exposes rich config endpoints, RA3 does not** — RA3 config is done
via Lutron Designer, not LEAP.

## Route Availability Matrix

| Route | RA3 (03.247) | Caseta (01.x) |
|-------|-------------|---------------|
| `/server` | 200 | 200 |
| `/system` | 200 | 200 |
| `/project` | 200 | 200 |
| `/link` | 200 | 200 |
| `/zone` | 405 (use area walk) | 200 |
| `/zone/status` | 200 | 200 |
| `/zone/{id}/status/expanded` | 200 per-zone | 200 per-zone |
| `/zone/status/expanded` (all) | 400 | 400 |
| `/device` | 204 (use area walk) | 200 |
| `/device/status` | 204 | 200 |
| `/area` | 200 | 200 |
| `/area/summary` | 400 | 400 |
| `/button` | 200 (empty) | 200 |
| `/buttongroup` | 204 | 200 |
| `/buttongroup/expanded` | 400 | 400 |
| `/controlstation` | 405 | 405 |
| `/presetassignment` | 204 | 200 (103 items) |
| `/virtualbutton` | 204 | 200 |
| `/programmingmodel` | 204 | 200 (184 items) |
| `/occupancygroup` | 204 | 200 |
| `/occupancygroup/status` | 204 | 200 |
| `/timeclock` | 200 | 200 |
| `/timeclock/status` | 200 | 204 |
| `/timeclockevent` | 200 | 204 |
| `/system/action` | 400 | 200 |
| `/system/away` | 204 | 200 |
| `/system/loadshedding/status` | 200 (Disabled) | 405 |
| `/system/naturallightoptimization` | 204 | 200 |
| `/service` | 200 (Alexa) | 200 (Sonos, HomeKit) |
| `/facade` | 204 | 200 (16 facade directions) |
| `/project/contactinfo` | 200 | 204 |
| `/project/masterdevicelist/devices` | 200 | 204 |
| `/server/leap/pairinglist` | 200 (empty) | 200 (empty) |
| `/countdowntimer` | n/a | 200 (14 timers) |
| `/dimmedlevelassignment/{id}` | n/a | 200 |
| `/switchedlevelassignment/{id}` | n/a | 200 |
| `/networkinterface/1` | 200 | 200 |

### Routes that ALWAYS fail (400 BadRequest on both)
These may require query parameters or be assembled URLs (not bare endpoints):
- `/zone/status/expanded` — works per-zone (`/zone/{id}/status/expanded`), not as bulk query
- `/device/commandprocessor` — needs specific device ID prefix
- `/area/summary` — may need `?where=` filter
- `/buttongroup/expanded` — may need filter or specific ID
- `/areascene` — may only exist on HomeWorks/RA3?
- `/areasceneassignment` — same
- `/system/status/daynightstate` — unknown
- `/household` / `/favorite` — Sonos-specific, may need Sonos integration active
- `/associatedalias` — voice aliases, may need Alexa/Google integration
- `/homekitdata` — may need HomeKit paired
- `/fadefighterproperties/programmingmodel/preset` — works nested under NLO
- `/certificate/root` — provisioning only
- `/system/status/crosssign` — provisioning only

### Routes that work only via sub-resource navigation
- `/devicerule/{id}` → Caseta: "not supported" (exists as href but can't be read)
- `/device/{id}/buttongroup` → 204 on dimmers, 200 on picos
- `/device/{id}/led/status` → "not supported" on both

## Zone Config Endpoints (Caseta only)

### `/zone/{id}/tuningsettings` — HIGH/LOW TRIM
Returns `{ TuningSettings: { HighEndTrim, EnergyTrim, LowEndTrim } }` (percentages)
- Only present on dimmer zones, not switched/fan zones
- EnergyTrim always 100 (see below)
- Example: Zone 41 Vanity: HighEndTrim=70.1, LowEndTrim=1.2
- Example: Zone 39 Main Lights: HighEndTrim=100, LowEndTrim=28

### `/zone/{id}/phasesettings` — PHASE CONTROL
Returns `{ PhaseSettings: { Direction: "Forward" | "Reverse" } }`
- Only on newer dimmers (DVRF-5NE-XX) — NOT on older DVRF-6L
- Zone 39 (Main Lights, DVRF-5NE): Forward
- Zone 41 (Vanity, DVRF-5NE): Reverse
- Zone 42 (Shower, DVRF-5NE): Reverse

### `EnergyTrim` — What is it?
- Always returns 100 in our data
- **NOT exposed in the Caseta app UI** — no user-facing control
- App binary has: `initWithHighEndTrim:EnergyTrim:LowEndTrim:MinimumLightLevel:`
- Likely a **commercial/utility feature** for demand response / load shedding
  - Would cap max brightness below HighEndTrim (e.g. 80% energy trim = 80% max output)
  - Related to `/system/loadshedding/status` (which RA3 has, Caseta doesn't)
  - Probably only used in HomeWorks QSX / commercial deployments

### `MinimumLightLevel`
- Referenced in TuningSettings init but NOT returned by LEAP endpoint
- May be computed from LowEndTrim or only available via Lutron Designer

### RA3: No config endpoints
- `/zone/{id}/tuningsettings` → "This resource does not exist"
- `/zone/{id}/phasesettings` → "This resource does not exist"
- `/device/{id}/tuningsettings` → "This request is not supported"
- RA3 config is done exclusively via Lutron Designer software
- RA3 zones don't have TuningSettings/CountdownTimer hrefs in zone objects

## Countdown Timers (Caseta)
- **Bridge-side auto-off timers** — NOT device-side
- Bridge tracks timer and sends OFF command when timeout expires
- 14 timers across 19 zones (some zones don't have timers)
- Timeout format: "HH:MM:SS" or "MM:SS"
- Range: 15 minutes to 8 hours
- EnabledState: "Enabled" or "Disabled"
- Readable via `/countdowntimer` (list all) or `/countdowntimer/{id}` (single)

## Preset Assignments — DELAY CONFIRMED
- 103 assignments on Caseta
- Each has: `Fade` (seconds), `Delay` (seconds), `Level` (0-100), `AffectedZone`
- **All current assignments**: fade=2 delay=0 (70) or fade=0 delay=0 (33)
- No assignments with delay > 0 currently, but the FIELD EXISTS and accepts values
- `/dimmedlevelassignment/{id}` has `FadeTime` and `DelayTime` (string format, e.g. "2")
- `/switchedlevelassignment/{id}` has `DelayTime` and `SwitchedLevel: "On"/"Off"`
- **This confirms delay is a real LEAP feature** — we can create assignments with delay > 0

## Programming Models
- 184 total on Caseta
- **SingleActionProgrammingModel: 148** — standard button press → preset
- **DualActionProgrammingModel: 24** — ALL tied to OccupancyGroups (press=occupied, release=unoccupied)
- **SingleSceneRaiseProgrammingModel: 6** — pico raise buttons
- **SingleSceneLowerProgrammingModel: 6** — pico lower buttons
- **NO AdvancedToggleProgrammingModel** — confirms Caseta doesn't have toggle/double-tap scenes
- The 24 DualAction models are for occupancy sensor behavior, not user button programming

## RA3 Server Endpoint Details
- Protocol version: 03.247
- **UDP port 2647** advertised in `/server/1` Endpoints
- No reference to port 2647 in Lutron iOS app binary or KMM backend
- Not in Lutron Designer strings either (checked)
- Possibly for **Lutron integration protocol** or **device discovery broadcast**
- Could be for HomeWorks QS integration or third-party systems
- Worth probing with UDP packet capture (netcat, Wireshark)

## Cloud LEAP Proxy (DISCOVERED 2026-02-16)

**`api.iot.lutron.io/api/v2/leap/{bridge-id}`** — full LEAP relay through Lutron cloud!
- Discovered from HAR capture of firmware update check flow in Caseta app
- Auth: Bearer token from `device-login.lutron.com`
- Bridge ID format: `caseta-{md5_hash}` — opaque, server-assigned (NOT simple hash of serial/MAC/GUID)
- Sends standard LEAP CommuniqueType JSON in POST body, returns LEAP response
- **Can send ANY LEAP command** — read, create, update, subscribe
- Capture file: `captures/app-fw-update-check/Untitled.har`

### Firmware Update Check Flow (from HAR, 9 requests)
1. `GET device-login.lutron.com/api/v1/integrationapplications/userreport` → auth + bridge list
2. `GET connect.lutron.io/device-firmware/static/locales/en-US/translation.json` → UI i18n strings
3. Cloud LEAP → `ReadRequest /project` (bridge info, GUID)
4. Cloud LEAP → `ReadRequest /firmwareupdatesession` (check for existing update)
5. Cloud LEAP → `ReadRequest /project` (redundant, maybe race condition)
6. Cloud LEAP → `ReadRequest /operation/status` (check for ongoing operations)
7. Cloud LEAP → `ReadRequest /server/status/ping` (verify bridge connectivity, LEAPVersion)
8. Cloud LEAP → `ReadRequest /device/1` (bridge firmware: `08.25.17f000`, package `001.003.004r000`)
9. Cloud LEAP → `ReadRequest /link/1/associatedlinknode/expanded` (ALL 27 devices + firmware)

### New LEAP Routes (from HAR)
| Route | RA3 | Caseta | Notes |
|-------|-----|--------|-------|
| `/firmwareupdatesession` | 200 (has completed session!) | 204 | Firmware update session management |
| `/operation/status` | 200 (5 devices complete) | 204 | Firmware update progress tracking |
| `/server/status/ping` | 200 (LEAPVersion 3.247) | 200 (LEAPVersion 1.123) | Lightweight health check |
| `/link/{id}/associatedlinknode/expanded` | 200 (20 CCA + 20 CCX nodes) | 200 (27 nodes) | **THE assembled URL** — all devices in one call |
| `/fwsessiondevice/@Proc-232-Op-4` | 405 | n/a | Session detail not directly readable |

### RA3 Firmware Update Session
- RA3 has a COMPLETED background firmware update for 5 CCX devices
- Operation: `@Proc-232-Op-4`, Status: Complete, all 5 devices at 100/100 steps
- Priority: Background (doesn't interrupt normal operation)
- Devices: 2399, 2351, 2422, 3131, 2306

### Link Node Expanded Details
- `/link/1/associatedlinknode/expanded` (Caseta CCA) — 27 devices, all firmware current
- `/link/236/associatedlinknode/expanded` (RA3 CCA) — 20 devices
- `/link/234/associatedlinknode/expanded` (RA3 CCX) — 20 devices, some need updates
  - RA3 CCX link is `/link/234` (not 237 as initially guessed)
  - Found from processor's `OwnedLinks` field

### Firmware Version Strings
| Device | Type | Current FW | Available FW | Package |
|--------|------|-----------|--------------|---------|
| Caseta Bridge (L-BDG2-WH) | Bridge | `08.25.17f000` | — | `001.003.004r000` |
| RA3 Processor (JanusProcRA3) | Processor | `26.00.11f000` | — | `002.025.018r000` |
| DVRF-5NS (DivaSmartSwitch) | CCA | `003.021.000r000` | same | — |
| DVRF-6L (DivaSmartDimmer) | CCA | `003.021.000r000` | same | — |
| DVRF-5NE-XX (DivaSmartDimmer) | CCA | `003.012.000r000` | same | — |
| PD-3PCL-WH (PlugInDimmer) | CCA | `001.054.000r000` | — | — |
| PD-FSQN-XX (FanSpeedController) | CCA | `001.005.000r000` | — | — |
| RRST-PRO-N-XX (SunnataDimmer) | CCX | OS `003.014.003r000` | same | — |
| RRST-HN3RL-XX (SunnataHybridKeypad) | CCX | OS `003.014.003r000` | same | — |
| Older CCX devices | CCX | OS `001.043.005r000` | `003.014.003r000` | — |
| Picos (all) | CCA | `000.000.000r000` | — | — |

### Firmware Cloud Services
- `fwcs.lutron.com/api/v1/client/check` — NOT used for Caseta firmware check (app uses cloud LEAP)
  - No-params returns `{"Required": false, "Address": "35.172.25.236"}` (fw server IP, not user IP)
  - With CODEVER/DEVCLASS params returns `{}` — may need auth or different params
- `firmwareupdates.lutron.com:443/sources` — Lutron Designer firmware source
- `firmware-downloads.iot.lutron.io/phoenix/final/` — RA3 firmware packages
- **App checks firmware by comparing** `FirmwareImage.Contents[].OS.Firmware.DisplayName` vs `OS.AvailableForUpload.DisplayName` — if different, update available

## DeviceClass.HexadecimalEncoding (Complete)
| Hex Code | Device Type | Radio |
|----------|------------|-------|
| `45e0101` | SunnataDimmer | CCX |
| `45f0101` | SunnataSwitch | CCX |
| `1290201` | SunnataHybridKeypad | CCX |
| `1270101` | SunnataKeypad | CCX |
| `81b0101` | RadioRa3Processor | — |
| `4140201` | PlugInDimmer (addressed) | CCA |
| `4140101` | PlugInDimmer (unaddressed) | CCA |
| `40c0201` | MaestroDimmer (older) | CCA |
| `1070201` | Pico | CCA |

Note: Last digit may encode AddressedState (1=unaddressed, 2=addressed)

## NLO (Natural Light Optimization)
- Sunrise-to-sunset window, configurable per-zone
- FadeFighter (anti-lumen-depreciation) runs within NLO window
- 8 programming models (one per zone?) with presets

## Device Details
- `DeviceClass.HexadecimalEncoding` — see table above
- `AddressedState`: "Addressed" (paired) or "Unaddressed" (unpaired/removed)
- `FirmwareImage.Contents[].Type`: "CCA" or "CCX" — useful for determining radio type
- `LinkNode.LinkType`: "RF" (CCA) or "ClearConnectTypeX" (CCX)
- `RFProperties.ChannelSet.Frequency`: "434" (CCA, from Caseta bridge expanded)

## Probe Scripts Created
- `tools/leap-probe.ts` — bulk route availability test
- `tools/leap-probe-deep.ts` — follow hrefs for device/zone details
- `tools/leap-probe-config.ts` — device config, presets, scenes
- `tools/leap-probe-sub.ts` — sub-resources (device rules, link nodes, firmware)
- `tools/leap-probe-tuning.ts` — zone tuning/phase/dimming curves
- `tools/leap-probe-ra3.ts` — RA3-specific area walk exploration
- `tools/leap-probe-detail.ts` — preset assignments, programming models, timers
