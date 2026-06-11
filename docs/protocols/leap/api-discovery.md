# LEAP API Discovery — Android APK Reverse Engineering

## Source

`com.lutron.lsb` v26.1.0.4, decompiled with jadx. Cross-referenced with live
probing of RA3 processor (10.0.0.1, firmware 26.01.13f000) and Caseta bridge
(10.0.0.2, probed 2026-03-06).

## Overview

The Lutron app's Kotlin/KMM LEAP layer reveals the full API surface that the
processor supports. This document catalogs every command, endpoint, and data
model discovered, noting what works on RA3 vs Caseta and what's useful for our
tools.

---

## Command Processor Endpoints

All commands use `CreateRequest` to a `/commandprocessor` URL. The body wraps a
`Command` object discriminated by `CommandType` (PascalCase strings).

### Zone Commands → `/zone/{id}/commandprocessor`

| CommandType | Parameters | Description |
|---|---|---|
| `GoToDimmedLevel` | `DimmedLevelParameters` | Set dimmed level with fade/delay |
| `GoToSwitchedLevel` | `SwitchedLevelParameters` | Switch on/off |
| `GoToShadeLevel` | `ShadeLevelParameters` | Set shade position |
| `GoToShadeLevelWithTilt` | `ShadeWithTiltLevelParameters` | Shade + tilt |
| `GoToShadeLevelWithTiltWhenClosed` | `ShadeWithTiltWhenClosedLevelParameters` | Shade + tilt when closed |
| `GoToTilt` | `TiltParameters` | Tilt only |
| `GoToSpectrumTuningLevel` | `SpectrumTuningLevelParameters` | Color spectrum tuning |
| `GoToWhiteTuningLevel` | `WhiteTuningLevelParameters` | White/CCT tuning |
| `GoToWarmDim` | `WarmDimParameters` | Warm dim with curve reference |
| `GoToMixedLevel` | `MixedLevelParameters` | Multi-type zone control (all at once) |
| `Raise` | (none) | Start raising |
| `Lower` | (none) | Start lowering |
| `Stop` | (none) | Stop raise/lower |

#### DimmedLevelParameters

```json
{
  "Level": 75,
  "FadeTime": "PT2S",
  "DelayTime": "PT0S",
  "Vibrancy": 0.5,
  "AutoVibrancy": 0.0,
  "ColorTuningStatus": { ... }
}
```

- Level: 0–100 integer
- FadeTime/DelayTime: ISO 8601 extended duration (e.g. `"PT2S"`, `"PT0.25S"`)
- Vibrancy/AutoVibrancy: optional float
- ColorTuningStatus: optional

#### WarmDimParameters

```json
{
  "CurveDimming": { "Curve": { "href": "/curve/{id}" } },
  "Level": 75.0
}
```

#### MixedLevelParameters (GoToMixedLevel)

Sets all zone types simultaneously. Fields: `DimmedLevelParameters`,
`SwitchedLevelParameters`, `SpectrumTuningLevelParameters`,
`WhiteTuningLevelParameters`, `ShadeLevelParameters`,
`ShadeWithTiltLevelParameters`, `ShadeWithTiltWhenClosedLevelParameters`,
`TiltParameters`. App has hardcoded presets: TurnAllLightsOff, CloseAllShades,
OpenAllShades.

### Device Commands → `/device/{id}/commandprocessor`

| CommandType | Parameters | Description |
|---|---|---|
| `AddressDevice` | `AddressDeviceParameters` | Pair device (see leap-ccx-addressing.md) |
| `UnaddressDevice` | `UnaddressDeviceParameters` | Un-pair device |
| `StartIdentify` | `IdentifyParameters` (optional) | Blink device LEDs |
| `StopIdentify` | `IdentifyParameters` (optional) | Stop blinking |
| `CloudProvision` | (none) | Trigger cloud enrollment |

#### UnaddressDeviceParameters

```json
{ "DeviceOffline": true }
```

Single boolean field (required).

#### IdentifyParameters

```json
{
  "TimeOutDuration": "PT30S",
  "SerialNumber": 12345678,
  "Link": { "href": "/link/437" }
}
```

All fields optional.

### Link Commands → `/link/{id}/commandprocessor`

| CommandType | Parameters | Description |
|---|---|---|
| `CacheDeviceHeard` | `CacheDeviceHeardParameters` | Report device found via BLE |
| `RequestBeginUnassociatedDeviceDiscovery` | discovery params | Scan for un-paired devices |

#### CacheDeviceHeardParameters

```json
{
  "SerialNumber": 12345678,
  "DiscoveryMechanism": "UserInteraction",
  "ClearConnectTypeXDeviceProperties": {
    "DeviceClass": { "HexadecimalEncoding": "..." },
    "FormFactor": 0,
    "IPv6Properties": { "UniqueLocalUnicastAddresses": ["..."] },
    "SystemType": 0
  }
}
```

DiscoveryMechanism: `UserInteraction`, `UnassociatedDeviceDiscovery`, `UserInitiatedChannelChange`

#### RequestBeginUnassociatedDeviceDiscoveryParameters

```json
{
  "PowerCycleDiscovery": "AllDevices",
  "RemoteAddressingDeviceAccessibility": "AllDevices"
}
```

PowerCycleDiscovery: `AllDevices` | `PowerCycledDevices`
RemoteAddressingDeviceAccessibility: `AllDevices` | `AccessibleDevices` | `InaccessibleDevices`

### LoadController Commands → `/loadcontroller/{id}/commandprocessor`

| CommandType | Parameters |
|---|---|
| `GoToDimmedLevel` | `DimmedLevelParameters` |
| `StartIdentify` / `StopIdentify` | `IdentifyParameters` |

### Other Command Endpoints

| Endpoint | CommandTypes |
|---|---|
| `/database/{id}/commandprocessor` | `ApplyNow`, `BeginTransferSession` |
| `/daynightmode/{id}/commandprocessor` | DayNightMode commands |
| `/naturalshow/{id}/commandprocessor` | NaturalShow commands |
| `/system/commandprocessor` | SystemStatusUpdate |
| `/preset/{id}/{type}assignment/commandprocessor` | PresetAssignment commands |

Preset assignment types: `ccolevelassignment`, `colortuninglevelassignment`,
`dimmedlevelassignment`, `receptaclelevelassignment`, `shadelevelassignment`,
`shadelevelwithtiltassignment`, `shadelevelwithtiltwhenclosedassignment`,
`spectrumtuninglevelassignment`, `switchedlevelassignment`, `tiltassignment`,
`warmdimassignment`, `whitetuninglevelassignment`

---

## Resource Endpoints (Read/Update)

### Device Status → `/device/{id}/status`

**Works on RA3.** Returns availability, battery, and config transfer status.

```json
{
  "DeviceStatus": {
    "href": "/device/694/status",
    "Device": { "href": "/device/694" },
    "ConfigurationTransferStatus": "NotRequired",
    "Availability": "Unknown",
    "BatteryStatus": { "LevelState": "Good" },
    "StatusAccuracy": "Good"
  }
}
```

| Field | Values | Notes |
|---|---|---|
| Availability | `Available`, `Unavailable`, `Unknown` | Processor shows `Available`, most devices `Unknown` |
| BatteryStatus.LevelState | `Good`, `Bad`, `Unknown` | Pico shows `Good`, wired devices `Unknown` |
| ConfigurationTransferStatus | `NotRequired`, others | Processor omits this field entirely |

### Expanded Zone Status → `/zone/{id}/status/expanded`

**Works on RA3.** Richer than basic zone status — includes zone metadata inline.

```json
{
  "ZoneExpandedStatus": {
    "href": "/zone/518/status",
    "Level": 100,
    "StatusAccuracy": "Good",
    "ZoneLockState": "Unlocked",
    "Zone": {
      "href": "/zone/518",
      "XID": "jYxAhkFrTtiqx6Cl6x1j8w",
      "Name": "Light",
      "AvailableControlTypes": ["Dimmed"],
      "Category": { "Type": "", "IsLight": true },
      "AssociatedArea": { "href": "/area/32" },
      "SortOrder": 0,
      "ControlType": "Dimmed"
    }
  }
}
```

ZoneLockState: `Unlocked` | `NonEmergencyLocked` | `EmergencyLocked`

### Full Device Model → `/device/{id}`

**Works on RA3.** Key fields not typically captured in dumps:

Processor (device/435):
```json
{
  "DeviceType": "HWQSProcessor",
  "SerialNumber": 100000001,
  "ModelNumber": "DualRadioProcResidential",
  "DeviceClass": { "HexadecimalEncoding": "8180101" },
  "AddressedState": "Addressed",
  "IsThisDevice": true,
  "NetworkInterfaces": [{ "MACAddress": "a0:b1:c2:d3:e4:f5" }],
  "OwnedLinks": [
    { "href": "/link/439", "LinkType": "RF" },
    { "href": "/link/437", "LinkType": "ClearConnectTypeX" }
  ],
  "FirmwareImage": {
    "Firmware": { "DisplayName": "26.01.13f000" },
    "Installed": { "Year": 2026, "Month": 3, "Day": 19, ... }
  },
  "DeviceFirmwarePackage": {
    "Package": { "DisplayName": "002.025.024r000" }
  },
  "Databases": [{ "href": "/database/@Project", "Type": "Project" }]
}
```

CCX device (SunnataDimmer, device/1496):
```json
{
  "DeviceType": "SunnataDimmer",
  "SerialNumber": 72396826,
  "ModelNumber": "HRST-PRO-N-XX",
  "DeviceClass": { "HexadecimalEncoding": "45e0101" },
  "AddressedState": "Addressed",
  "LocalZones": [{ "href": "/zone/1512" }],
  "FirmwareImage": {
    "href": "/firmwareimage/1496",
    "Contents": [{
      "Type": "CCX",
      "OS": {
        "Firmware": { "DisplayName": "003.014.013r000" },
        "AvailableForUpload": { "DisplayName": "003.014.013r000" }
      },
      "Boot": {
        "Firmware": { "DisplayName": "001.006.000r000" },
        "AvailableForUpload": { "DisplayName": "001.006.000r000" }
      }
    }]
  }
}
```

CCA device (Pico4Button, device/694):
```json
{
  "DeviceType": "Pico4Button",
  "SerialNumber": 141110640,
  "ModelNumber": "PJ2-4B-XXX-L01",
  "DeviceClass": { "HexadecimalEncoding": "1070201" },
  "AddressedState": "Addressed",
  "AssociatedLink": { "href": "/link/439" }
}
```

### LED Settings → `/device/{id}/ledsettings`

**Caseta only.** RA3 returns 500.

Works on wired Caseta devices (DivaSmartDimmer, DivaSmartSwitch). Returns 404
for Picos and SmartBridge.

```json
{
  "LEDSettings": {
    "href": "/ledsettings/6",
    "IdleLED": { "EnabledState": "Enabled" },
    "NightlightLED": { "EnabledState": "Enabled" }
  }
}
```

Update via `UpdateRequest /ledsettings/{id}` with same body structure.
EnabledState: `Enabled` | `Disabled`

### Load Shedding → `/system/loadshedding/status`

**Works on RA3.**

```json
{
  "SystemLoadSheddingStatus": {
    "href": "/system/loadshedding/status",
    "State": "Disabled"
  }
}
```

### Link Nodes → `/device/{id}/linknode/{nodeId}`

**Works on RA3.**

```json
{
  "LinkNode": {
    "href": "/device/435/linknode/436",
    "Parent": { "href": "/device/435" },
    "LinkType": "ClearConnectTypeX",
    "RFProperties": {},
    "AssociatedLink": { "href": "/link/437" }
  }
}
```

---

## Subscribe-Only Endpoints

### Device Heard → `/device/status/deviceheard`

**RA3: subscribe works, read returns 405.** Fires when a new CCX device is
discovered on Thread. The app subscribes to this during commissioning to detect
power-cycled or newly-joined devices.

---

## Endpoint Compatibility Matrix (RA3 vs Caseta)

| Endpoint | RA3 | Caseta |
|---|---|---|
| `/device/{id}/status` | 200 OK | 200 OK |
| `/zone/{id}/status/expanded` | 200 OK | 200 OK |
| `/device/{id}` (full model) | 200 OK | 200 OK |
| `/system/loadshedding/status` | 200 OK | ? |
| `/device/{id}/linknode/{id}` | 200 OK | ? |
| `/device/{id}/ledsettings` | 500 Error | 200 OK (wired only) |
| `/device/status/deviceheard` | Subscribe only | Subscribe only |
| `/certificate/root` | 400 | Used during pairing |
| `/softwareupdate` | 400 | ? |
| `/softwareupdate/status` | 400 | ? |
| `/operatingstatus` | 400 | ? |
| `/log` | 400 | ? |
| `/networkinterface` | 400 | ? |
| `/device/{id}/firmwareimage` | 400 | ? |
| `/device/{id}/addressedstate` | 400 (but field in /device/{id}) | ? |
| `/virtualbutton` | 204 NoContent | ? |
| `/system/away` | 204 NoContent | ? |
| `/occupancygroup/status` | 204 NoContent | ? |
| `/programmingmodel` | 204 NoContent | ? |
| `/facade` | 204 NoContent | ? |

---

## Certificate & Security Architecture

From APK decompilation of `com.lutron.bridgesetup`, `com.lutron.mmw.communication`,
and `com.lutron.sharedutils`.

### `/certificate/root` Endpoint

Used **only during initial pairing** (LAP = Lutron Authentication Protocol).
The app:

1. Connects to the bridge on the LEAP port without client certs
2. Sends `ReadRequest /certificate/root`
3. Receives `Body.Certificate.Certificate` — a PEM-encoded X.509 root cert
4. Generates an EC keypair (secp256r1) and CSR
5. Sends CSR to `/pair` endpoint
6. Receives a signed client certificate back
7. Stores both the root cert and client cert for future mTLS connections

**This is the bridge's TLS root CA — not a firmware signing key.** It's the
trust anchor for all subsequent LEAP connections. The root cert is specific to
each bridge instance (self-signed CA).

The RA3 processor returns 400 for this endpoint because we're already paired
(authenticated via mTLS). The endpoint is likely only available on the
unauthenticated LEAP listener used during initial setup.

### What it can NOT do

- **Not firmware decryption**: No firmware-related crypto found in APK.
  Encryption code is limited to AES-128-CBC for log file protection.
- **Not SSH access**: No SSH client code in the APK whatsoever.
- **Not a master key**: Each bridge generates its own root CA. The cert only
  authenticates LEAP TLS connections to that specific bridge.

### Hardcoded Certificates in APK Assets

| File | Purpose |
|---|---|
| `security/caseta_root_cert.pem` | Caseta bridge root (pre-paired) |
| `security/phoenix_root_cert.pem` | Phoenix (RA3/CCX) root |
| `security/app_cert.pem` + `private_key.pem` | Pre-provisioned app client cert |
| `security/ketra_devices_trusted_chain.pem` | BLE device trust chain (production) |
| `security/pegasus_ketra_alpha_devices_trust_chain_2022.pem` | Dev/alpha device chain |
| `security/revoked_certs.pem` | Certificate revocation list |
| `security/orion_poc_devices_trust_chain.pem` | Orion POC devices |

The `phoenix_root_cert.pem` is interesting — "Phoenix" is the RA3 platform
codename. This cert is loaded alongside the per-bridge cert, suggesting there
may be a platform-wide root CA that all RA3 processors share.

### TLS Configuration

- TLSv1.2 exclusively (no TLS 1.3)
- Mutual TLS (mTLS) — both client and server present certificates
- EC keys using secp256r1 curve, signed with SHA256withECDSA
- RSA-2048 used for legacy/Caseta pairing paths

---

## Link Properties (from APK Models)

### CcaLinkProperties

```json
{ "Channel": 1, "DefaultChannel": 1 }
```

Both optional UInt. Maps to the 433 MHz CCA channel number.

### ThreadLinkProperties

```json
{
  "Channel": 25,
  "PANID": "7w==",
  "ExtendedPANID": "base64...",
  "NetworkName": "LutronThread",
  "NetworkMasterKey": "base64..."
}
```

All required. PANID serialized as 2-byte little-endian base64. This is how the
app reads Thread network credentials — could be used to extract Thread
credentials directly via LEAP if the link exposes them.

### TolkienLinkProperties

```json
{
  "NetworkID": "hex...",
  "NetworkMasterKey": "base64...",
  "ChannelHoppingSequence": [byte array]
}
```

"Tolkien" is Lutron's proprietary wireless protocol (distinct from CCA and CCX).
The `ChannelHoppingSequence` confirms Tolkien uses frequency hopping — stored as
a raw byte array. NetworkID is hex-encoded, NetworkMasterKey is base64.

---

## Device Type Codenames

### Obfuscated (base64-like) device types

These are newer products where Lutron stopped using human-readable type names:

| Constant Name | DeviceType String |
|---|---|
| Aviena | `OBJH7KtiTV2Sa0nL0YkX8Q` |
| Coastal Source VIA Node | `R2GXLB8oSAyLznxe0L4uYQ` |
| Ketra Coastal Source VIA Light | `NmZJSEU-QUuSADbEzoKXuA` |
| Inline Fan Control | `yf7S5LHEQEWzvgEI1WLR3w` |
| Lite Heron Processor | `q5vImK4dQkev0K1y1TC_SQ` |
| Ketra D2R | `4cFDw2luShuQobjvaAmoQw` |
| Lumaris 230V A20 | `J4W333KPTLqCHvGi-L9-1Q` |
| Lumaris Downlight | `Oz_PzXfpRkuF6_fSMGJ-2Q` |
| Orluna Downlight | `66r0N7shT3GnTmPQ7wfPtA` |
| Palladiom Drapery Shade | `vyLtjPiDRouvoHu8GMLmSQ` |

### All Known Device Types (from LeapConstant.java)

AlisseKeypad, AthenaProcessor, AthenaWirelessNode, AthenaWirelessNodeWithSensor,
AutoDetectKetra, AuxRepeater, CasetaFanSpeedController, CenterDrawDrape,
DivaSmartDimmer, DivaSmartSwitch, DMXInterface, FourGroupRemote, GrafikEye,
GrafikTDimmer, GrafikTHybridKeypad, GrafikTSwitch, HomeownerKeypad,
HWQSProcessor, InLineDimmer, InLineSwitch, KetraA20, KetraD3, KetraD4R,
KetraG2, KetraX96 (KitKat), KetraL3I, KetraL4R, KetraN3, KetraP4, KetraS30,
KetraS38, LeftDrawDrape, Lumaris, MaestroDimmer, MaestroDualDimmer,
MaestroDualDimmerSwitch, MaestroDualLightFanDimmer, MaestroFanSpeedController,
MaestroSensorDimmer, MaestroSensorSwitch, MaestroSwitch, myRoomProcessor,
OutdoorPlugInSwitch, PaddleSwitchPico, PalladiomKeypad, PalladiomWireFreeShade,
Pico1Button, Pico2Button, Pico2ButtonRaiseLower, Pico4Button, ...

---

## LEAP Query Parameters

The app uses URL query parameters for filtering:

| Query Key | Example | Description |
|---|---|---|
| `Category.IsLight` | `?where=Category.IsLight:true` | Filter zones to lights only |
| `Device.href` | `?where=Device.href:/device/X` | Filter by device |
| `SerialNumber` | `?where=SerialNumber:12345` | Filter by serial |
| `ConfigurationTransferStatus` | `?where=ConfigurationTransferStatus:X` | Config transfer state |
| `ScheduleType` | `?where=ScheduleType:X` | Filter schedules |
| `$1/assignableresource` | Special filter | Get assignable resources for preset |
| `Category` | Generic category filter | |
| `DayOfWeek` | Schedule day filter | |
| `ByDate` | Date-based filter | |

---

## Subscriptions the App Uses

The app subscribes to 11 resource types for live events:

| Subscription URL | Events |
|---|---|
| `/zone/status` | Level/state changes |
| `/device/status` | Availability + battery changes |
| `/device/status/deviceheard` | New device discovered on network |
| `/link/status` | Link state changes |
| `/occupancygroup/status` | Occupancy sensor state |
| `/system` | System events |
| `/database` | Database transfer events |
| `/timeclock/status` | Timeclock state |
| `/tuningsettings` | Tuning changes |
| `/loadcontroller/status` | Load controller status |
| `/naturallightoptimization/status` | NLO state |

---

## Actionable Improvements for Our Tools

### leap-dump.ts

- Add `DeviceClass.HexadecimalEncoding` to device records
- Add `AddressedState` per device
- Add `FirmwareImage` (version strings) per device
- Add `ModelNumber` per device
- Add `IsThisDevice` to identify the processor
- Add `OwnedLinks` with `LinkType` for the processor
- Add `BatteryStatus.LevelState` from `/device/{id}/status`
- Add `Availability` from `/device/{id}/status`
- Add `LocalZones` for CCX devices
- Query `/system/loadshedding/status`

### Sniffer / Bridge

- Subscribe to `/device/status/deviceheard` to detect new CCX devices joining
- Subscribe to `/device/status` for availability/battery monitoring
- Use `/zone/{id}/status/expanded` instead of basic status to get
  `ZoneLockState` and inline zone metadata

### New tool ideas

- `leap-identify.ts` — blink a device's LEDs via StartIdentify/StopIdentify
- `leap-unaddress.ts` — un-pair a device via UnaddressDevice
- `leap-discover.ts` — trigger device discovery on a link
- Extract Thread credentials from `ThreadLinkProperties` via link status

---

## Command Surfaces

Full command processor surface from `MockLeapDataSource` and URL classes in the APK.

### Complete Endpoint → Body Type Map

| Target | Endpoint | Body Type |
|--------|----------|-----------|
| Area | `/area/{id}/commandprocessor` | AreaCommandBody |
| Database | `/database/{id}/commandprocessor` | ApplyDatabaseCommandBody, BeginTransferSessionCommandBody |
| DayNightMode | `/daynightmode/{id}/commandprocessor` | DayNightModeCommandBody |
| Device | `/device/{id}/commandprocessor` | AssignmentCommandBody, UnassignmentCommandBody, CloudProvisionCommandBody, IdentifyCommandBody |
| Link | `/link/{id}/commandprocessor` | LinkCommandBody, RequestBeginUnassociatedDeviceDiscoveryCommandBody |
| LoadController | `/loadcontroller/{id}/commandprocessor` | LoadCommandBody, IdentifyCommandBody, CommandTuningSettingsBody |
| NaturalShow | `/naturalshow/{id}/commandprocessor` | NaturalShowCommandBody |
| System | `/system/commandprocessor` | SystemStatusUpdateBody |
| Zone | `/zone/{id}/commandprocessor` | ZoneControlCommandBody, CommandTuningSettingsBody, EnterShadeLimitSetModeCommandBody, ExitShadeLimitSetModeCommandBody, ShadeLimitLowerLiftCommandBody, ShadeLimitRaiseLiftCommandBody, ShadeLimitSaveClosedLiftCommandBody, ShadeLimitSaveOpenLiftCommandBody, TestCloseLimitCommandBody, TestOpenLimitCommandBody |
| Preset (various) | `/preset/{id}/{type}assignment/commandprocessor` | PresetAssignmentCommandBody |

> **Discovery:** Zone command processor accepts shade limit calibration commands (`EnterShadeLimitSetMode`, `ShadeLimitSaveOpenLift`, etc.) and tuning settings (`CommandTuningSettingsBody`) — not just level/raise/lower. LoadController also accepts `CommandTuningSettingsBody`.

### MultiZoneControlCommand (GoToMixedLevel)

Pre-built constants in the app:

| Constant | Values |
|----------|--------|
| `TurnAllLightsOff` | Dimmed=0, Switched=Off, Spectrum=0, WhiteTuning=0 |
| `CloseAllShades` | Shade=0, ShadeWithTilt(0,0), ShadeWithTiltWhenClosed=0, Tilt=0 |
| `OpenAllShades` | Shade=100, ShadeWithTilt(100,50), ShadeWithTiltWhenClosed=100, Tilt=50 |

### AddressDevice Full Envelope

```json
{
  "Command": {
    "CommandType": "AddressDevice",
    "AddressDeviceParameters": {
      "SerialNumber": 90000001,
      "DeviceClassParameters": {
        "Action": "Overwrite",
        "DeviceClass": { "HexadecimalEncoding": "45e0101" }
      },
      "IPv6Properties": {
        "UniqueLocalUnicastAddresses": ["fd00::ff:fe00:3800"]
      }
    }
  }
}
```

### CloudProvisionCommand

```json
{
  "Command": { "CommandType": "CloudProvision" }
}
```

No parameters — bare command type.

### BeginTransferSessionCommand

Sent to `/database/{id}/commandprocessor`. `BeginTransferSessionParameters` is polymorphic:
- **Download**: contains `DownloadFrom` model
- **FilePackage**: contains `FilePackageDestination` model

### ApplyDatabaseCommand

Sent to `/database/{id}/commandprocessor`:

| CommandType | Parameter Key |
|-------------|--------------|
| `ApplyNow` | `ApplyNowParameters` → `EndDeviceTransferParameters` |

### Serialization Notes

- All `CommandType` values are PascalCase strings (e.g. `"GoToDimmedLevel"`, `"AddressDevice"`)
- `@JsonClassDiscriminator("CommandType")` annotation confirms `CommandType` is the discriminator in every command body
- Duration fields use ISO 8601 extended format via `Iso8601ExtendedDurationSerializer` (e.g. `"PT2S"`, `"PT0.5S"`)
- SerialNumber fields are `kotlin.UInt` (serialized as unsigned integer)
- Level fields in `DimmedLevelParameters` are integers (0-100), but in `WarmDimParameters` and `SpectrumTuningLevelParameters` they are floats
