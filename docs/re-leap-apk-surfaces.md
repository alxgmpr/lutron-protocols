# LEAP API Surfaces — Android APK Reverse Engineering

## Source: `com.lutron.lsb` v26.1.0.4 (jadx decompilation)

All LEAP commands use `CreateRequest` to a `commandprocessor` URL. Every command body wraps a `Command` object discriminated by `CommandType`.

---

## Command Processor Endpoints

From `MockLeapDataSource` and URL classes:

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

Preset assignment types: `ccolevelassignment`, `colortuninglevelassignment`, `dimmedlevelassignment`, `receptaclelevelassignment`, `shadelevelassignment`, `shadelevelwithtiltassignment`, `shadelevelwithtiltwhenclosedassignment`, `spectrumtuninglevelassignment`, `switchedlevelassignment`, `tiltassignment`, `warmdimassignment`, `whitetuninglevelassignment`

---

## ZoneControlCommand (CommandType variants)

Sent to `/zone/{id}/commandprocessor`:

```json
{"Command": {"CommandType": "<type>", ...params}}
```

| CommandType | Parameter Key | Parameter Model |
|-------------|--------------|-----------------|
| `GoToDimmedLevel` | `DimmedLevelParameters` | Level (int 0-100), FadeTime (ISO 8601 duration), DelayTime, Vibrancy (float), AutoVibrancy (float), ColorTuningStatus |
| `GoToSwitchedLevel` | `SwitchedLevelParameters` | SwitchedLevel (enum: "On"/"Off") |
| `GoToShadeLevel` | `ShadeLevelParameters` | Level (int 0-100) |
| `GoToShadeLevelWithTilt` | `ShadeWithTiltLevelParameters` | Level, Tilt |
| `GoToShadeLevelWithTiltWhenClosed` | `ShadeWithTiltWhenClosedLevelParameters` | Level |
| `GoToTilt` | `TiltParameters` | Tilt |
| `GoToSpectrumTuningLevel` | `SpectrumTuningLevelParameters` | Level (float 0-100), ColorControlBehavior? |
| `GoToWhiteTuningLevel` | `WhiteTuningLevelParameters` | WhiteAmbiance (int, CCT) |
| `GoToWarmDim` | `WarmDimParameters` | CurveDimming: { Curve: { href: "/curve/{id}" } }, Level (float) |
| `Raise` | (no params) | — |
| `Lower` | (no params) | — |
| `Stop` | (no params) | — |

### DimmedLevelParameters detail

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

- Level: 0–100 integer (percent)
- FadeTime/DelayTime: ISO 8601 extended duration (e.g. `"PT2S"` = 2 seconds)
- Vibrancy/AutoVibrancy: optional float

---

## MultiZoneControlCommand

Sent to `/zone/{id}/commandprocessor` (shared endpoint):

| CommandType | Parameter Key | Description |
|-------------|--------------|-------------|
| `GoToMixedLevel` | `MixedLevelParameters` | Sets all zone types at once |

### MixedLevelParameters fields

```
DimmedLevelParameters
SwitchedLevelParameters
SpectrumTuningLevelParameters
WhiteTuningLevelParameters
ShadeLevelParameters
ShadeWithTiltLevelParameters
ShadeWithTiltWhenClosedLevelParameters
TiltParameters
```

Pre-built constants:
- `TurnAllLightsOff`: Dimmed=0, Switched=Off, Spectrum=0, WhiteTuning=0
- `CloseAllShades`: Shade=0, ShadeWithTilt(0,0), ShadeWithTiltWhenClosed=0, Tilt=0
- `OpenAllShades`: Shade=100, ShadeWithTilt(100,50), ShadeWithTiltWhenClosed=100, Tilt=50

---

## LoadCommand

Sent to `/loadcontroller/{id}/commandprocessor`:

| CommandType | Parameter Key |
|-------------|--------------|
| `GoToDimmedLevel` | `DimmedLevelParameters` |

Same DimmedLevelParameters as ZoneControlCommand.

---

## IdentifyCommand

Sent to `/device/{id}/commandprocessor` OR `/loadcontroller/{id}/commandprocessor`:

| CommandType | Parameter Key |
|-------------|--------------|
| `StartIdentify` | `IdentifyParameters` (optional) |
| `StopIdentify` | `IdentifyParameters` (optional) |

### IdentifyParameters

```json
{
  "TimeOutDuration": "PT30S",
  "SerialNumber": 12345678,
  "Link": { "href": "/link/437" }
}
```

All fields optional. `TimeOutDuration` is ISO 8601 duration.

---

## AddressDevice / UnaddressDevice

### AddressDevice (documented in leap-ccx-addressing.md)

Sent to `/device/{id}/commandprocessor`:

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

### UnaddressDevice

Sent to `/device/{id}/commandprocessor`:

```json
{
  "Command": {
    "CommandType": "UnaddressDevice",
    "UnaddressDeviceParameters": {
      "DeviceOffline": true
    }
  }
}
```

Single boolean field: `DeviceOffline` (required).

---

## LinkCommand

Sent to `/link/{id}/commandprocessor`:

| CommandType | Parameter Key | Description |
|-------------|--------------|-------------|
| `CacheDeviceHeard` | `CacheDeviceHeardParameters` | Notify processor of a device heard via BLE |

### CacheDeviceHeardParameters

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

DiscoveryMechanism values: `UserInteraction`, `UnassociatedDeviceDiscovery`, `UserInitiatedChannelChange`

---

## RequestBeginUnassociatedDeviceDiscovery

Sent to `/link/{id}/commandprocessor`:

```json
{
  "Command": {
    "CommandType": "RequestBeginUnassociatedDeviceDiscovery",
    "RequestBeginUnassociatedDeviceDiscoveryParameters": {
      "PowerCycleDiscovery": "AllDevices",
      "RemoteAddressingDeviceAccessibility": "AllDevices"
    }
  }
}
```

### Enum values

PowerCycleDiscovery: `AllDevices`, `PowerCycledDevices`
RemoteAddressingDeviceAccessibility: `AllDevices`, `AccessibleDevices`, `InaccessibleDevices`

---

## CloudProvisionCommand

Sent to `/device/{id}/commandprocessor`:

```json
{
  "Command": { "CommandType": "CloudProvision" }
}
```

No parameters — bare command type.

---

## ApplyDatabaseCommand

Sent to `/database/{id}/commandprocessor`:

| CommandType | Parameter Key |
|-------------|--------------|
| `ApplyNow` | `ApplyNowParameters` → `EndDeviceTransferParameters` |

---

## BeginTransferSessionCommand

Sent to `/database/{id}/commandprocessor`:

| CommandType | Parameter Key |
|-------------|--------------|
| `BeginTransferSession` | `BeginTransferSessionParameters` |

BeginTransferSessionParameters variants (polymorphic):
- **Download**: `DownloadFrom` model
- **FilePackage**: `FilePackageDestination` model

---

## Link Properties (from Link model)

### CcaLinkProperties (CCA/RF)

```json
{
  "Channel": 1,
  "DefaultChannel": 1
}
```

Both optional UInt fields.

### ThreadLinkProperties (CCX/Thread)

```json
{
  "Channel": 25,
  "PANID": "7w==",
  "ExtendedPANID": "base64...",
  "NetworkName": "LutronThread",
  "NetworkMasterKey": "base64..."
}
```

- Channel: UByte
- PANID: `BytesUShortLittleEndianSerializer` (base64 of 2 LE bytes)
- ExtendedPANID: base64
- NetworkMasterKey: base64
- All fields required

### TolkienLinkProperties (Tolkien/proprietary wireless)

```json
{
  "NetworkID": "hex...",
  "NetworkMasterKey": "base64...",
  "ChannelHoppingSequence": [byte array]
}
```

- NetworkID: hex string serializer
- NetworkMasterKey: base64
- ChannelHoppingSequence: raw byte array serializer
- All fields required

---

## Warm Dim Control Detail

```json
{
  "Command": {
    "CommandType": "GoToWarmDim",
    "WarmDimParameters": {
      "CurveDimming": {
        "Curve": { "href": "/curve/{curveId}" }
      },
      "Level": 75.0
    }
  }
}
```

- CurveDimming is required (references a curve resource)
- Level is optional (float, 0-100)

---

## Notes

- All `CommandType` values are serialized as PascalCase strings (e.g. `"GoToDimmedLevel"`, `"AddressDevice"`)
- Duration fields use ISO 8601 extended format via `Iso8601ExtendedDurationSerializer` (e.g. `"PT2S"`, `"PT0.5S"`)
- SerialNumber fields are `kotlin.UInt` (serialized as unsigned integer)
- The `@JsonClassDiscriminator("CommandType")` annotation confirms `CommandType` is the discriminator in every command body
- Level fields in DimmedLevelParameters are integers (0-100), but in WarmDimParameters and SpectrumTuningLevelParameters they are floats
