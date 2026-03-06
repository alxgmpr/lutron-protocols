# LEAP API Routes & Commands

Extracted from Lutron iOS app v26.0.0 (com.lutron.lsb, build 8).
Sources: `RequestLayerFramework`, `ResponseHandlerFramework`, `SyncServiceFramework`,
`CommandsFramework`, `LeapModel`, `KMMUnifiedBackend`, `BridgeSetupFramework`, main binary.

**VALIDATED** 2026-02-15 against RA3 (<ra3-ip>, v03.247) and Caseta (<caseta-ip>).
See `memory/leap-probing.md` for full probe results.

## Protocol Basics

- **Transport**: TLS mutual auth on port 8081 (modern), SSH on port 22 (legacy Caseta)
- **Endpoints**: TCP:8081 (LEAP), UDP:2647 (RA3 only, purpose unknown)
- **Format**: JSON with `CommuniqueType` + `Header` (Url, MessageBodyType, ClientTag) + `Body`
- **CommuniqueTypes**: `ReadRequest`, `ReadResponse`, `CreateRequest`, `CreateResponse`,
  `UpdateRequest`, `UpdateResponse`, `DeleteRequest`, `DeleteResponse`,
  `SubscribeRequest`, `SubscribeResponse`, `UnsubscribeRequest`, `UnsubscribeResponse`
- **Bonjour**: `_lutron._tcp` — advertises SSH port, TXT has MACADDR, CODEVER, SYSTYPE, SERNUM
- **Bridge discovery**: `dns-sd -B _lutron._tcp`

### RA3 vs Caseta Differences

RA3 uses area-walk style (`/area/{id}/associatedzone`, `/area/{id}/associatedcontrolstation`).
Caseta uses direct endpoints (`/zone`, `/device`). RA3 returns 405 for `/zone` and `/device`.

**Caseta exposes device config (trim, phase, timers), RA3 does not.** RA3 config is via
Lutron Designer only.

---

## Resource Routes

### Zone

| Route | Operations | RA3 | Caseta | Notes |
|-------|-----------|-----|--------|-------|
| `/zone` | Read | 405 | 200 | Caseta only — list all zones |
| `/zone/{id}` | Read, Update | 200 | 200 | Single zone |
| `/zone/{id}/status` | Read, Subscribe | 200 | 200 | Zone level/state |
| `/zone/{id}/status/expanded` | Read | 200 | 200 | Includes zone metadata + status |
| `/zone/status` | Read, Subscribe | 200 | 200 | All zone status changes |
| `/zone/status/expanded` | Read | 400 | 400 | Needs `?where=` filter, per-zone works |
| `/zone/{id}/tuningsettings` | Read, Update | n/a | 200 | HighEndTrim, EnergyTrim, LowEndTrim |
| `/zone/{id}/phasesettings` | Read, Update | n/a | 200 | Direction: Forward/Reverse (newer dimmers) |
| `/zone/{id}/commandprocessor` | Create | 200 | 200 | Send commands (GoToLevel etc) |

**Zone Update** (`UpdateRequest`):
- `requestForUpdateZoneNameRequestForZoneHref:zoneName:` — rename zone
- `requestForUpdateZoneRequestForZoneHref:zoneType:` — change zone type

### Area

| Route | Operations | Notes |
|-------|-----------|-------|
| `/area` | Read, Create | List/create areas |
| `/area/{id}` | Read, Update | Single area |
| `/area/summary` | Read | Area summaries |
| `/area/summary?where=` | Read | Filtered summaries |

### Device

| Route | Operations | Notes |
|-------|-----------|-------|
| `/device` | Read, Create | List/create devices |
| `/device/{id}` | Read, Update, Delete | Single device |
| `/device?where=SerialNumber:` | Read | Find device by serial |
| `/device/{id}/status` | Read, Subscribe | Device status |
| `/device/status` | Subscribe | All device status (suppressible) |
| `/device/status?where=Device.` | Read | Filtered device status |
| `/device/status/deviceheard` | Read, Subscribe | Device health/heard |
| `/device/{id}/led/status` | Read | LED indicator state |
| `/device/{id}/commandprocessor` | Create | Send device commands |
| `/device/commandprocessor` | Read | List command processors |
| `/device/commandprocessor?where=href:%@` | Read | Filtered command processors |

### Control Station

| Route | Operations | Notes |
|-------|-----------|-------|
| `/controlstation` | Read | List control stations (picos, keypads) |
| `/controlstation/{id}` | Read | Single control station |
| `/controlstation/{id}/associatedcontrolstation` | Read | Associated sub-stations |
| `/controlstation/{id}/associatedcontrolstation/commandprocessor` | Create | Commands |

### Button / Button Group

| Route | Operations | Notes |
|-------|-----------|-------|
| `/button` | Read | List buttons |
| `/button/{id}` | Read, Update | Single button |
| `/buttongroup` | Read | List button groups |
| `/buttongroup/{id}` | Read, Update | Update type: `requestForUpdateButtongroupRequestWithHref:buttonGroupType:` |
| `/buttongroup/expanded` | Read | Button groups with children |

### Preset / Scene

| Route | Operations | Notes |
|-------|-----------|-------|
| `/preset/{id}` | Read | Single preset (scene) |
| `/areascene` | Read | Area scenes |
| `/areasceneassignment` | Read, Create, Update, Delete | Scene zone assignments |
| `/presetassignment` | Read, Create, Update | Preset zone assignments |
| `/virtualbutton` | Read, Update | Virtual buttons (scenes) |

### Link

| Route | Operations | Notes |
|-------|-----------|-------|
| `/link` | Read | List radio links |
| `/link/{id}` | Read, Update | Update operating mode: `createAndExecuteLinkStatusUpdateRequestForHref:operatingModes:` |

### Occupancy

| Route | Operations | Notes |
|-------|-----------|-------|
| `/occupancygroup` | Read | List occupancy groups |
| `/occupancygroup/{id}` | Read, Update | Update schedules: `createAndExecuteUpdateOccupancyGroup:andOccupiedSchedule:andUnoccupiedSchedule:` |
| `/occupancygroup/status` | Read, Subscribe | Occupancy status |

### Time Clock

| Route | Operations | Notes |
|-------|-----------|-------|
| `/timeclock` | Read | List time clocks |
| `/timeclock/{id}` | Read | Single time clock |
| `/timeclock/status` | Read, Subscribe | Time clock status |
| `/timeclockevent` | Read, Create, Update, Delete | Schedule events |
| `/timeclockevent?where=` | Read | Filtered events |
| `/timeclockevent/{id}/event/status` | Update | Enable/disable event |

### Server / System

| Route | Operations | Notes |
|-------|-----------|-------|
| `/server` | Read | Server info (firmware version, protocol version) |
| `/server/{id}` | Read, Update | Enable/disable: `createAndExecuteServerUpdateForServerHref:andServerEnableState:` |
| `/system` | Read, Update | System config (timezone, lat/lon, date) |
| `/system/action` | Read, Create, Update | Automation actions |
| `/system/away` | Read, Update, Subscribe | Away mode |
| `/system/commandprocessor` | Create | System-level commands |
| `/system/loadshedding/status` | Read, Update | Load shedding on/off |
| `/system/naturallightoptimization` | Read, Update | NLO enable/disable/time range |
| `/system/status/daynightstate` | Read | Day/night state |

### Other

| Route | Operations | Notes |
|-------|-----------|-------|
| `/project` | Read | Project info |
| `/project/contactinfo` | Read, Create, Update | Contractor info |
| `/project/masterdevicelist/devices` | Read | Master device list |
| `/service` | Create | Service sessions (discovery, etc) |
| `/household` | Read | Sonos households |
| `/favorite` | Read | Sonos favorites |
| `/detectiongroup` | Create, Update | Camera detection groups |
| `/associatedalias` | Read | Voice aliases |
| `/homekitdata` | Read | HomeKit configuration |
| `/fadefighterproperties/programmingmodel/preset` | Read | Fade fighter config |
| `/facade` | Read, Update | Zone facade (shade type) |

---

## Zone Commands (via `/zone/{id}/commandprocessor`)

Commands sent as `CreateRequest` to the zone's command processor.

### Light Dimmer
```json
{"CommuniqueType":"CreateRequest","Header":{"Url":"/zone/{id}/commandprocessor"},"Body":{"Command":{"CommandType":"GoToDimmedLevel","DimmedLevelParameters":{"Level":75,"FadeTime":"00:01"}}}}
```
- `GoToDimmedLevel` — level + optional fade
- `GoToSwitchedLevel` — on/off (`"On"` / `"Off"`)
- `Raise` / `Lower` / `Stop` — ramp control

### Shade
- `GoToShadeLevel` — `ShadeLevelParameters` with `Level`
- `GoToShadeLevelWithTilt` — `ShadeWithTiltLevelParameters` with `Level` + `Tilt`
- `GoToShadeLevelWithTiltWhenClosed` — `ShadeWithTiltWhenClosedLevelParameters`
- `GoToTilt` — `TiltParameters` with `Tilt`
- `ShadeLimitCommand` — set open/close limits (with `actionType`)
- `StopIfMoving`

### Fan
- `GoToFanSpeed` — `FanSpeedParameters` with level

### CCO (Contact Closure Output)
- `CCOZoneGotoLevelCommand` — binary level

### Receptacle
- `ReceptacleZoneGotoLevelCommand` — on/off

### Spectrum / Ketra Zones
- `GoToSpectrumTuningLevel` — HSV or XY color
- `GoToWhiteTuningLevel` — color temperature + level
- `GoToBrightnessLevel` — brightness only
- `GoToVibrancyLevel` — vibrancy + brightness
- `EnableAutoVibrancy`
- `GoToCurveDimming` — select dimming curve by href
- `GoToWarmDim` — warm dim level with curve href
- `GoToNaturalShow` — natural light show mode

### Area Group Command
- `createAndExecuteAreaGoToGroupLightingLevelForAreaHref:commandParameters:` — set all zones in area

---

## Device Configuration (via UpdateRequest)

### LED Settings (CONFIRMED 2026-02-16)

**Read**: `GET /device/{id}/ledsettings` → `OneLEDSettingsDefinition`
**Update**: `UpdateRequest` to `/ledsettings/{id}`

```json
{
  "LEDSettings": {
    "href": "/ledsettings/66",
    "IdleLED": { "EnabledState": "Disabled" },
    "NightlightLED": { "EnabledState": "Disabled" }
  }
}
```
- `IdleLED.EnabledState` = "Enabled" / "Disabled" — status LED when lights are off (idle)
- `NightlightLED.EnabledState` = "Enabled" / "Disabled" — nightlight mode
- Discovered via KMM backend: `KMMUBLeapLedSettingsModel`, `KMMUBLeapLedSettingUpdateBody`
- NOT at `/device/{id}/led/status` (400) — that was a red herring

### Fade Settings (NOT SUPPORTED on Caseta v01.123)

**URL pattern**: `/zone/{id}/fadesettings` or `/device/{id}/fadesettings`
- Returns 400 on Caseta — may be RA3-only or newer firmware
- KMM classes: `KMMUBLeapFadeSettingsModel`, `KMMUBLeapFadeSettingsUpdateBody`
- Fields from binary: `FadeRate`, `FadeTime`, `onFade`, `offFade`
- Feature-gated: `apmFadeSettingsFeatureEnabled` flag in device settings director

### Countdown Timer (CONFIRMED)

**Read**: `GET /zone/{id}/countdowntimer` or direct `/countdowntimer/{id}`
**Create**: `CreateRequest` to `/zone/{id}/countdowntimer`
**Update**: `UpdateRequest` to `/countdowntimer/{id}`

```json
{
  "CountdownTimer": {
    "href": "/countdowntimer/4",
    "Timeout": "15:00",
    "EnabledState": "Enabled",
    "AssociatedZone": { "href": "/zone/15" }
  }
}
```
- `Timeout` = "MM:SS" format
- `EnabledState` = "Enabled" / "Disabled"
- Feature-gated: `countdownTimerRockhopperFeatureEnabled`

### Trim (High/Low End)
```
requestForUpdateTuningSettingsRequestWithHref:lowEndTrim:highEndTrim:clientTag:andFormat:
```
- `href` = device href
- `lowEndTrim`, `highEndTrim` = trim values

### Phase Control
```
requestForUpdatePhaseSettingsRequestWithHref:direction:clientTag:andFormat:
```
- `direction` = forward / reverse / auto-detect

### Dimming Curve
```
createAndExecuteCurveDimmingRequestWithZoneHref:curveHref:format:
```
- Selects a dimming curve by href for a zone

### Facade (Shade Type)
```
requestForUpdateFacadeRequestForZoneHref:facadeHref:clientTag:andFormat:
```

---

## Preset Assignment Operations

### Dimmed Level Assignment
```
createAndExecutePresetAssignmentCreateRequestForParentInfo:andAffectedZoneInfo:andFade:andDelay:andLevel:andPresetType:andClientTag:andFormat:
createAndExecutePresetAssignmentUpdateRequestForHref:andParentInfo:andAffectedZoneInfo:andFade:andDelay:andLevel:andPresetType:andClientTag:andFormat:
```
Parameters: `fade`, `delay`, `level`, `presetType`

### Fan Speed Assignment
```
createAndExecutePresetAssignmentCreateRequestForParentInfo:andAffectedZoneInfo:andFanSpeed:andDelay:andClientTag:andFormat:
```

### Shade Assignment (with tilt variants)
- `ShadePresetAssignmentAdd/UpdateCommand` — level + delay
- `ShadeWithTiltPresetAssignmentAdd/UpdateCommand` — level + tilt + delay
- `ShadeWithTiltOnlyPresetAssignmentAdd/UpdateCommand` — tilt + delay
- `ShadeWithTiltWhenClosedPresetAssignmentAdd/UpdateCommand` — level + tilt + delay

### White Tuning Assignment
```
createAndExecuteWhiteTuningPresetAssignmentCreateRequestWithPresetHref:zoneHref:level:temperature:fade:clientTag:format:
```

### Spectrum Tuning Assignment
```
generateCreateSpectrumPresetAssignmentRequestWithZoneHref:presetHref:level:vibrancy:autoVibrancy:whiteTuningLevel:hue:saturation:curveDimmingHref:fade:clientTag:format:
```

---

## Device Management

### Discovery & Pairing
```
createAndExecuteDeviceActivationRequestForActivationMode:andClientTag:andProjectEtag:andFormat:
createAndExecuteDeviceCreateRequestForUnpairedDeviceDiscoveryWithClientTag:andFormat:
createAndExecuteDeviceDeleteRequestForCancelUnpairedDeviceDiscoveryWithSessionKey:andClientTag:andFormat:
createAndExecuteDeviceCreateRequestForStartIdentifyDeviceWithSerialNumber:andClientTag:andFormat:
createAndExecuteDeviceCreateRequestForStopIdentifyDeviceWithSerialNumber:andClientTag:andFormat:
createAndExecuteDeviceCreateRequestForDeviceName:areaHref:serialNumber:sessionHref:clientTag:userRef:timeOfActivation:andFormat:
```

### Address / Unaddress
```
createAndExecuteAddressDeviceRequestForHref:serialNumber:ipAddress:deviceClass:clientTag:andFormat:
createAndExecuteUnaddressDeviceRequestForHref:clientTag:isDeviceOffline:andFormat:
```

### Device Extraction
```
createAndExecuteDeviceExtractionRequestForSerialNumber:andClientTag:andFormat:
createAndExecuteDeviceExtractionRequestForSession:clientTag:andFormat:
```

### Retry Missed Devices
```
createAndExecuteRetryMissedDevicesWithForce:clientTag:deviceHrefs:andFormat:
```

---

## Provisioning & Setup (via `/api/` routes)

| Route | Purpose |
|-------|---------|
| `/api/v1/provisioning/client` | Client provisioning (v1) |
| `/api/v2/provisioning/client` | Client provisioning (v2) |
| `/api/v2/remotepairing/application/association` | Remote pairing association |
| `/certificate/root` | Fetch bridge root certificate |
| `/system/status/crosssign` | Cross-signing sync status |
| `/systems/{id}/pair` | Pairing endpoint |

---

## Cloud API Routes (not local LEAP)

| Endpoint | Purpose |
|----------|---------|
| `device-login.lutron.com` | OAuth device login |
| `connect.lutron.io/device-firmware` | Firmware updates |
| `connect.lutron.io/nlo-activity-viewer` | NLO activity viewer |
| `connect.lutron.io/share` | System sharing |
| `api.data.lutron.io/v1/preference-manager/preferences/user` | User preferences |
| `api.design.lutron.io/api/v1/design/place/` | Design/place management |
| `fwcs.lutron.com` | Firmware cloud services |
| `umslogin.lutron.com` | UMS SSO login |
| `ring.integrations.iot.lutron.io/api/v1` | Ring integration |
| `sonos.integrations.iot.lutron.io` | Sonos integration |
| `/api/v1/devices/friendlyname` | Device friendly names (cloud) |
| `/api/v1/users/devices` | User devices (cloud) |
| `/api/v1/users/account` | User account (cloud) |
| `/api/IdentityService/GetUserFullProfile/` | User profile (cloud) |

---

## App Credentials (provisioning-time only)

These credentials are shipped in the app bundle but only work during initial bridge setup
(factory reset state). After provisioning, per-bridge certificates are used.

| File | Type | Passphrase |
|------|------|------------|
| `casetaapp.pem` | RSA private key (unencrypted) | n/a |
| `casetaappSignedByLutron.crt` | Client cert (CN=Caseta Application) | n/a |
| `lutronelectronics.crt` | CA cert (Caseta Local Access Protocol Cert Authority) | n/a |
| `phoenix.crt` | Root CA chain (CN=lutron-root, RA3/Phoenix) | n/a |
| `ssh_connection_id_rsa.txt` | RSA private key (AES-128-CBC) | `leapserver` |
| `id_rsa.txt` | RSA private key (AES-128-CBC) | unknown |

SSH username: `leap`

---

## KMM URL Types (from KMMUnifiedBackend)

These Kotlin class names reveal the URL structure used internally:

```
LeapAreaUrl, LeapAreaSummaryUrl, LeapAreaSummaryUrlQuery
LeapButtonUrl, LeapButtongroupUrl
LeapControlStationHrefQuery
LeapDeviceUrl, LeapDeviceUrlQuery, LeapDeviceStatusUrl, LeapDeviceStatusUrlQuery
LeapDeviceStatusDeviceheardUrl, LeapDeviceCommandprocessorUrl
LeapFacadeUrl
LeapOccupancygroupUrl, LeapOccupancygroupStatusUrl
LeapProjectContactinfoUrl, LeapProjectMasterdevicelistDevicesUrl
LeapServerUrl, LeapServiceUrl
LeapSystemUrl, LeapSystemActionUrl, LeapSystemAwayUrl
LeapSystemCommandprocessorUrl
LeapSystemNaturallightoptimizationUrl, LeapSystemNaturallightoptimizationStatusUrl
LeapTimeclockUrl, LeapTimeclockStatusUrl
LeapVirtualbuttonUrl
LeapZoneUrl, LeapZoneUrlQuery, LeapZoneStatusUrl
LeapZoneStatusExpandedUrl, LeapZoneStatusExpandedUrlQuery
LeapZoneCommandprocessorUrl, LeapZoneCommandprocessorUrlQuery
```

---

## Request Creators (from RequestLayerFramework)

Each handles a specific LEAP operation type:

```
ActionRequestCreator          GoToSceneRequestCreator
AddressDeviceRequestCreator   HomekitResourceRequestCreator
AffectedResourceRequestCreator  LEAPEncoder
AffectedZoneRequestCreator    LinkStatusUpdateRequestCreator
AreaRequestCreator            LoadSheddingRequestCreator
AreaSceneRequestCreator       NestServiceRequestCreator
AutoProgrammingRequestCreator NetworkInterfaceRequestCreator
AwayDefinitionRequestCreator  NLORequestCreator
AwayStatusRequestCreator      OccupancyGroupRequestCreator
ButtonGroupRequestCreator     PhaseSettingsRequestCreator
ButtonRequestCreator          PresetAssignmentRequestCreator
ButtonUpdateRequestCreator    PresetRequestCreator
ContractorInfoRequestCreator  ProjectRequestCreator
DetectionGroupRequestCreator  ServiceCreateRequestCreator
DeviceRequestCreator          ShadePresetAssignmentWithZoneSceneRequestCreator
DimmedLevelRequestCreator     ShadeWithTiltPresetAssignmentRequestCreator
DomainObjectRequestCreator    SingleSpeakerAssignmentRequestCreator
EventRequestCreator           SonosFavoriteHouseholdRequestCreator
FanPresetAssignmentRequestCreator  SonosPlayAssignmentRequestCreator
SpectrumTuningPresetAssignmentRequestCreator
SpectrumZoneRequestCreator
SubscribeRequestCreator       WhiteTuningPresetAssignmentRequestCreator
TiltRequestCreator            WhiteTuningRequestCreator
TimeClockEventRequestCreator  ZoneRequestCreator
TimeClockRequestCreator
TuningSettingsRequestCreator
UnaddressDeviceRequestCreator
UnsubscribeRequestCreator
```
