# LEAP Command Surface (Reverse Engineered)

Extracted from Lutron iOS app v26.0.0 (`KMMUnifiedBackend.framework` + `Lutron` binary + `LeapModel.framework` + `SyncServiceFramework`).

The app is built with Kotlin Multiplatform Mobile (KMM) with Swift SKIE bridging. All LEAP commands flow through `com.lutron.leap.common.request.Request` using one of five communique types, targeted at command processor URLs.

## Request Communique Types

| Type | Description |
|------|-------------|
| `CreateRequest` | Create new resources / send commands |
| `ReadRequest` | Read/query resources |
| `UpdateRequest` | Modify existing resources |
| `DeleteRequest` | Remove resources |
| `SubscribeRequest` | Subscribe to real-time status changes |

## Command Processor Endpoints

Commands are sent as `CreateRequest` to `commandprocessor` URLs. Each resource type has its own command processor.

### Primary Command Processors

| Class | URL Pattern | Used By |
|-------|-------------|---------|
| `AreaHrefCommandprocessor` | `/area/{id}/commandprocessor` | AreaCommand |
| `ZoneHrefCommandprocessor` | `/zone/{id}/commandprocessor` | ZoneCommand |
| `DeviceHrefCommandprocessor` | `/device/{id}/commandprocessor` | IdentifyCommand |
| `LoadControllerHrefCommandprocessor` | `/loadcontroller/{id}/commandprocessor` | LoadCommand |
| `LinkHrefCommandprocessor` | `/link/{id}/commandprocessor` | LinkCommand |
| `NaturalShowHrefCommandprocessor` | `/naturalshow/{id}/commandprocessor` | NaturalShowCommand |
| `SystemCommandprocessorUrl` | `/system/commandprocessor` | system-level commands |
| `DatabaseHrefCommandprocessor` | `/database/commandprocessor` | ApplyDatabaseCommand |
| `DayNightModeHrefCommandprocessor` | `/daynightmode/commandprocessor` | DayNightModeCommand |

### Preset Assignment Command Processors (13 zone types)

These are used to program what a preset/scene does for each zone type. Each maps to `/preset/{id}/{type}assignment/commandprocessor`.

| Class | Zone Type |
|-------|-----------|
| `PresetHrefDimmedlevelassignmentCommandprocessor` | Dimmers |
| `PresetHrefSwitchedlevelassignmentCommandprocessor` | Switches (on/off) |
| `PresetHrefShadelevelassignmentCommandprocessor` | Shades (position only) |
| `PresetHrefShadelevelwithtiltassignmentCommandprocessor` | Shades with tilt |
| `PresetHrefShadelevelwithtiltwhenclosedassignmentCommandprocessor` | Shades with tilt-when-closed |
| `PresetHrefTiltassignmentCommandprocessor` | Tilt-only (e.g. blinds) |
| `PresetHrefCcolevelassignmentCommandprocessor` | CCO (Correlated Color Output) |
| `PresetHrefColortuninglevelassignmentCommandprocessor` | Color tuning |
| `PresetHrefSpectrumtuninglevelassignmentCommandprocessor` | Spectrum tuning (Ketra full RGB) |
| `PresetHrefWhitetuninglevelassignmentCommandprocessor` | White color temperature tuning |
| `PresetHrefWarmdimassignmentCommandprocessor` | Warm dim curve |
| `PresetHrefReceptaclelevelassignmentCommandprocessor` | Receptacles (smart outlets) |
| `PresetHrefFanspeedassignmentCommandprocessor` | Fan speed |

## LEAP Commands (16 command classes)

### 1. ZoneCommand (12 sub-commands)

The primary control command, sent to `/zone/{id}/commandprocessor`.

| Sub-command | Description | Parameters |
|-------------|-------------|------------|
| `GoToDimmedLevel` | Set dimmer level | level (0-100%), fade, delay |
| `GoToSwitchedLevel` | On/off switch control | level (0 or 100) |
| `GoToShadeLevel` | Set shade position | level (0-100%) |
| `GoToShadeLevelWithTilt` | Shade position + tilt angle | level, tilt |
| `GoToShadeLevelWithTiltWhenClosed` | Shade + tilt behavior when closed | level, tilt |
| `GoToTilt` | Tilt-only control | tilt angle |
| `GoToSpectrumTuningLevel` | Ketra spectrum tuning (full RGB) | spectrum parameters |
| `GoToWhiteTuningLevel` | White color temperature | color temp |
| `GoToWarmDim` | Warm-dim curve control | level, curveDimmingHref |
| `Raise` | Start raising (dim up / shade open) | - |
| `Lower` | Start lowering (dim down / shade close) | - |
| `Stop` | Stop raise/lower in progress | - |

### 2. AreaCommand (1 sub-command)

Sent to `/area/{id}/commandprocessor`.

| Sub-command | Description |
|-------------|-------------|
| `GoToGroupLightingLevel` | Set entire area to a scene/level |

### 3. LoadCommand (1 sub-command)

Sent to `/loadcontroller/{id}/commandprocessor`. This is separate from ZoneCommand and targets the load controller directly.

| Sub-command | Description |
|-------------|-------------|
| `GoToDimmedLevel` | Direct load controller dimming |

### 4. MultiZoneCommand (1 sub-command)

Atomic multi-zone control in a single command. This is how the app updates scenes affecting multiple zones simultaneously.

| Sub-command | Description |
|-------------|-------------|
| `GoToMixedLevel` | Set multiple zones to different levels in one request |

### 5. IdentifyCommand (2 sub-commands)

Sent to `/device/{id}/commandprocessor`.

| Sub-command | Description |
|-------------|-------------|
| `Start` | Flash device LED for identification |
| `Stop` | Stop identification flash |

### 6. LinkCommand (1 sub-command)

Sent to `/link/{id}/commandprocessor`.

| Sub-command | Description |
|-------------|-------------|
| `CacheDeviceHeard` | Notify processor that a device was heard on RF (used during pairing) |

### 7. TuningSettingsCommand (2 sub-commands)

| Sub-command | Description |
|-------------|-------------|
| `TestHighEndTrim` | Test high-end trim level on dimmer |
| `TestLowEndTrim` | Test low-end trim level on dimmer |

### 8. ApplyDatabaseCommand (1 sub-command)

Sent to `/database/commandprocessor`.

| Sub-command | Description |
|-------------|-------------|
| `ApplyNow` | Apply pending database/programming changes immediately |

### 9. BeginTransferSessionCommand (1 sub-command)

| Sub-command | Description |
|-------------|-------------|
| `BeginTransferSession` | Start a firmware transfer session |

### 10. CloudProvisionCommand (1 sub-command)

| Sub-command | Description |
|-------------|-------------|
| `CloudProvision` | Provision device for Lutron cloud access |

### 11. DayNightModeCommand (1 sub-command)

| Sub-command | Description |
|-------------|-------------|
| `EditDayNightMode` | Change day/night mode settings |

### 12. GenerateLogPackageCommand (1 sub-command)

| Sub-command | Description |
|-------------|-------------|
| `GenerateLogPackage` | Generate diagnostic log package for support |

### 13. NaturalShowCommand (1 sub-command)

Sent to `/naturalshow/{id}/commandprocessor`. Ketra natural lighting feature.

| Sub-command | Description |
|-------------|-------------|
| `EditNaturalShowRamp` | Edit natural light show ramp parameters |

### 14. PresetAssignmentCommand (1 sub-command)

| Sub-command | Description |
|-------------|-------------|
| `Filter` | Filter/query preset assignments |

### 15. RequestBeginUnassociatedDeviceDiscoveryCommand (1 sub-command)

| Sub-command | Description |
|-------------|-------------|
| `DeviceDiscovery` | Start scanning for unassociated (unpaired) devices |

### 16. UnassignmentCommand

Body class exists (`KMMUBLeapUnassignmentCommandBody`) but no named sub-commands. Used to remove device assignments from zones/areas.

## CRUD Operations (SyncServiceFramework)

These are the higher-level service operations the app uses, built on top of the LEAP request primitives.

### Read Operations

| Service | Description |
|---------|-------------|
| `ZoneSceneRead` | Read scenes for a zone |
| `ZoneDetailsRead` | Read zone details by hrefs |
| `PaginatedZoneExpandedStatusWhereOnRead` | Read all zone statuses (paginated, where=on) |
| `DeviceStatusRead` | Read device status |
| `DeviceDefinitionRead` | Read device definitions by hrefs |
| `AreaSummaryDefinitionRead` | Read area summaries |
| `ControlStationDetailsRead` | Read control station (keypad) details |
| `CurveDimmingRead` | Read dimming curve definitions |
| `LEDStatusRead` | Read LED bar status on device |
| `LinksRead` | Read all links (radios) |
| `OperationStatusRead` | Read firmware/operation status |
| `LoadSheddingStatusRead` | Read load shedding status |
| `ReadNLOService` | Read Natural Light Optimization status |
| `FanSpeedConfiguration` read | Read fan speed configuration |
| `PaginatedAssociatedLinkNodesExpandedRead` | Read all devices on a link (paginated, expanded) |

### Create/Update Operations

| Service | Description |
|---------|-------------|
| `ZoneUpdateName` | Rename a zone |
| `AreaSceneUpdateName` | Rename an area scene |
| `CountdownTimerCreate` | Create a countdown timer |
| `CountdownTimerUpdate` | Update a countdown timer |
| `FanSpeedConfigurationUpdate` | Update fan speed configuration |
| `NaturalLightOptimizationStatusUpdate` | Update NLO enabled/disabled status |
| `TimeClockStatusUpdate` | Enable/disable a time clock |
| `LoadSheddingStatusUpdate` | Enable/disable load shedding |
| `KeypadButtonPress` | Simulate a keypad button press (href + buttonAction) |
| `WidgetZoneUpdateCommand` | iOS widget zone control (level, fanSpeed, tilt, zoneType) |
| `ContractorInfoCreate` | Create contractor contact info |
| `ContractorInfoUpdate` | Update contractor contact info |
| `VoiceControlCreateAlias` | Create voice control alias (Siri) |
| `VoiceControlUpdateAlias` | Update voice control alias |
| `VoiceControlDeleteAlias` | Delete voice control alias |
| `VoiceControlAddAlexaResource` | Add Alexa voice resource |
| `AddHomeKitResource` | Add zone to HomeKit |
| `DeleteResourceFromHomekitConfiguration` | Remove zone from HomeKit |

### Subscribe Operations

| Service | Description |
|---------|-------------|
| `NLOStatusSubscribe` | Subscribe to NLO status changes |
| `OperationStatusDownload` | Subscribe to operation/firmware status |
| `TimeClockStatusSubscribe` | Subscribe to time clock status changes |

## Data Models

### Zone Control Types

The `LeapZoneControlType` enum determines which ZoneCommand sub-command and preset assignment type to use:

- Dimmed (dimmers)
- Switched (on/off)
- Shade (position)
- ShadeWithTilt
- ShadeWithTiltWhenClosed
- Tilt
- SpectrumTuning (Ketra RGB)
- WhiteTuning (color temperature)
- WarmDim
- CCO (correlated color output)
- Receptacle (smart outlet)
- FanSpeed

### Fan Speed

`FanSpeedEnum` values: Off, Low, Medium, MediumHigh, High

`FanSpeedConfigurationModel` includes:
- TotalFanSpeeds count
- Per-speed settings (Low, Medium, MediumHigh, High)
- FanSpeedConfigurationSupported flag

### Zone Status Types

The app tracks these status types per zone:
- `ZoneStatus` (level, fan speed)
- `ZoneStatusFanSpeed`
- `ZoneStatusExpandedFanSpeed`
- `ITiltStatus` (tilt angle)
- `IZoneStatus` (generic)
- `OccupancyStatus`
- `CountdownTimer`
- `ZoneLockState`
- `Temperature`
- `NaturalLightOptimizationStatus`
- `DeviceStatus`

### Other Notable Models

- `LEAPResponse` / `LEAPExceptionResponse` — Response parsing
- `LeapLinkType` — Link radio types (CCA, CCX, etc.)
- `DeviceAddressedState` — Whether device has been addressed/configured
- `DeviceTransfer` / `DeviceTransferStatus` — Device migration between processors
- `CurveDimming` — Warm-dim curve definitions
- `AreaSceneAssignment` — Scene-to-area bindings
- `SystemLoadSheddingStatus` — System-wide load shedding
- `AlexaConfiguration` / `AssociatedAliasURL` — Alexa integration
- `HomekitAccessory` / `HomekitConfigurationResponse` — HomeKit integration
- `PegasusDeviceType` — Ketra/Pegasus bulb types

## Notable Findings

1. **`/loadcontroller/{id}/commandprocessor`** is a separate endpoint from `/zone/{id}/commandprocessor`. LoadCommand targets the physical load controller, while ZoneCommand targets the logical zone.

2. **13 preset assignment types** cover every possible zone control type, including several Ketra-specific ones (spectrum tuning, color tuning, warm dim, CCO) that are not documented elsewhere.

3. **`MultiZoneCommand.GoToMixedLevel`** enables atomic multi-zone updates. This is how scene activation works without visible staggering.

4. **`LinkCommand.CacheDeviceHeard`** is the LEAP-side mechanism for pairing — the app tells the processor which devices it heard on RF during discovery.

5. **`DayNightModeCommand`** controls a feature not visible in standard Caseta/RA3 UI — likely Ketra/Palladiom day/night scheduling.

6. **`ApplyDatabaseCommand.ApplyNow`** triggers immediate application of programming changes, rather than waiting for the normal sync cycle.

7. **`WidgetZoneUpdateCommand`** is the iOS home screen widget's simplified command path, accepting level + fanSpeed + tilt + zoneType in a single call.

8. **`BeginTransferSessionCommand`** and `OperationStatusDownload` (subscribe) are the firmware update pipeline commands.
