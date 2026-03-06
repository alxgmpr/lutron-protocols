# LEAP API Exploration Results: RA3 Processor (<ra3-ip>)

Comprehensive documentation of the LEAP API surface on the HWQS (Homeworks QSX) processor,
firmware v03.247, explored 2026-03-06 via `ReadRequest` on TLS port 8081.

**Source data**: `data/leap-explore-<ra3-ip>-2026-03-06.json` (main), `data/leap-explore-followup.json` (href followup)

---

## 1. Executive Summary

| Metric | Count |
|--------|-------|
| Total endpoints probed | 1124 |
| 200 OK | 232 |
| 204 NoContent (valid but empty) | 74 |
| 400 BadRequest | 700 |
| 404 NotFound | ~115 |
| 405 MethodNotAllowed | 3 |
| 500 InternalServerError | ~2 |

The RA3 processor exposes a read-only LEAP API (via `ReadRequest`) that provides full visibility
into zones, devices, areas, links, services, timeclocks, and buttons. It does **not** expose
device configuration (trim, phase, fade, LED settings) -- those are Caseta-only or require
Lutron Designer via the IPL protocol. The 306 "successful" count (referenced in exploration logs)
includes 200 OK + 204 NoContent responses.

**Key architectural difference from Caseta**: RA3 uses area-walk navigation
(`/area/{id}/associatedzone`, `/area/{id}/associatedcontrolstation`) rather than flat list
endpoints (`/zone`, `/device`). The bare `/zone` endpoint returns 405, and `/device` returns
204 NoContent (empty list).

---

## 2. System Infrastructure

### `/server` -- Server Configuration

Returns both LEAP and IPL server definitions.

```json
{
  "Servers": [
    {
      "href": "/server/1",
      "Type": "LEAP",
      "EnableState": "Enabled",
      "LEAPProperties": {
        "PairingList": { "href": "/server/leap/pairinglist" }
      },
      "Endpoints": [
        { "Protocol": "TCP", "Port": 8081 },
        { "Protocol": "UDP", "Port": 2647 }
      ],
      "ProtocolVersion": "03.247"
    },
    {
      "href": "/server/ipl",
      "Type": "IPL",
      "IPLProperties": {
        "SystemNumber": 1,
        "SystemAddress": "239.0.38.1",
        "ProcessorID": 0
      },
      "Endpoints": [
        { "Protocol": "TLS", "Port": 8902 },
        { "Protocol": "WSS", "Port": 443 }
      ]
    }
  ]
}
```

**Notable**: UDP:2647 purpose is unknown. IPL on TLS:8902 and WSS:443 requires different
certificates (CN=Lutron Project SubSystem Certificate Authority) and is used by Lutron Designer.

### `/server/leap/pairinglist`

Returns empty pairing list: `{ "PairingList": { "href": "/server/leap/pairinglist" } }`.

### `/system` -- System Configuration

```json
{
  "System": {
    "href": "/system",
    "TimeZone": "America/Denver",
    "Latitude": 38.8,
    "Longitude": -104.8,
    "Date": { "Day": 6, "Month": 3, "Year": 2026 },
    "Time": { "Hour": 2, "Minute": 7, "Second": 46 }
  }
}
```

### `/system/loadshedding/status`

```json
{ "SystemLoadSheddingStatus": { "href": "/system/loadshedding/status", "State": "Disabled" } }
```

### `/system/away` -- 204 NoContent (no active away mode)

### `/system/naturallightoptimization` -- 204 NoContent

### `/system/naturallightoptimization/status` -- 204 NoContent

### `/project` -- Project Info

```json
{
  "Project": {
    "href": "/project",
    "Name": "Example Residence",
    "ProductType": "Lutron HWQS Project",
    "MasterDeviceList": { "Devices": [{ "href": "/device/435" }] },
    "Contacts": [{ "href": "/contactinfo/102" }],
    "TimeclockEventRules": { "href": "/project/timeclockeventrules" },
    "ProjectModifiedTimestamp": { "Year": 2026, "Month": 3, "Day": 6, ... }
  }
}
```

### `/project/contactinfo`

Returns installer contact info (name, phone, email, organization).

### `/project/masterdevicelist/devices`

Returns the processor device with full detail: DeviceType, SerialNumber, ModelNumber,
MAC address, IPv6 ULA, OwnedLinks, FirmwareImage, DeviceFirmwarePackage, DeviceClass,
AddressedState, and associated databases.

### `/database/@Project` -- Database Metadata

```json
{
  "Database": {
    "href": "/database/@Project",
    "Type": "Project",
    "Version": { "Schema": 168 },
    "TransferGUID": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "ConfigurationStateRevision": "CxNzzd1QStCzMfxhBipwMw",
    "UnsynchronizedChanges": { "WithSourceOfTruth": { "Count": 0 } },
    "InstalledOnDevices": [{ "href": "/device/435" }]
  }
}
```

### `/networkinterface/1` -- Network Configuration

```json
{
  "NetworkInterface": {
    "href": "/networkinterface/1",
    "MACAddress": "<ra3-mac>",
    "IPv4Properties": {
      "Type": "DHCP",
      "IP": "<ra3-ip>",
      "SubnetMask": "255.255.255.0",
      "Gateway": "<gateway-ip>",
      "DNS1": "<dns-ip>"
    },
    "IPv6Properties": {
      "UniqueLocalUnicastAddresses": [
        "<ra3-ipv6-ula1>",
        "<ra3-ipv6-ula2>"
      ]
    },
    "AdapterType": "Ethernet",
    "SOCKS5ProxyProperties": { "EnabledState": "Disabled" }
  }
}
```

**Notable**: Two IPv6 ULA addresses. SOCKS5 proxy support exists (disabled). Bare
`/networkinterface` returns 400.

---

## 3. Services

### `/service` -- Service List

Returns 7 services: Alexa, Google Home, BACnet, HomeKit, IFTTT, Sonos, NTPServer.

### Alexa (`/service/alexa`)

Sub-endpoints: `/service/alexa/config`, `/service/alexa/datasummary` -- both return empty
configuration objects (not configured).

### Google Home (`/service/googlehome`)

`/service/googlehome/config` contains `"Follows": { "href": "/service/alexa/config" }` --
Google Home config follows Alexa config.

### BACnet (`/service/bacnet`)

Full BACnet IP integration support:

```json
{
  "BACnetProperties": {
    "Enabled": false,
    "NetworkNumber": 20000,
    "Port": 47808,
    "BBMDIPAddress": "",
    "BBMDTTL": 1800,
    "InstanceStrategy": "Custom",
    "Settings": { "href": "/service/bacnet/bacnetsettings" },
    "Instances": { "href": "/service/bacnet/bacnetinstances" },
    "NetworkSettings": { "href": "/service/bacnet/bacnetnetworksettings" }
  }
}
```

**Sub-endpoints** (all return data via followup probing):

- `/service/bacnet/bacnetsettings` -- Global BACnet settings (port, network number, BBMD)
- `/service/bacnet/bacnetinstances` -- Per-area BACnet object instances (11 areas mapped)
  - Each area gets a unique instance number (e.g., area/32 = 1761001, area/912 = 1761003)
- `/service/bacnet/bacnetnetworksettings` -- Per-device network settings
  - Shows processor device/435 with DeviceInstanceType "NormalObjectInstance"
  - Has nested instances endpoint at `bacnetnetworksettings/435/bacnetinstances`

### HomeKit (`/service/homekit`)

```json
{
  "HomeKitProperties": {
    "Configuration": { "href": "/service/homekit/config" },
    "DataSummary": { "href": "/service/homekit/datasummary" },
    "BonjourServiceName": "Lutron Processor",
    "BridgeAccessory": { "SerialNumber": "10005000000XX" },
    "MaxAssociations": 149
  }
}
```

**MaxAssociations: 149** -- this is the HomeKit accessory limit.

### IFTTT (`/service/ifttt`)

Config includes `"Follows": { "href": "/service/alexa/config" }` -- mirrors Alexa config pattern.

### Sonos (`/service/sonos`)

Minimal: `{ "Type": "Sonos" }` -- no sub-properties.

### NTP Server (`/service/ntpserver`)

```json
{
  "NTPServerProperties": {
    "PropertiesType": "Static",
    "Endpoints": [{ "href": "/service/ntpserver/1", "Endpoint": "time.iot.lutron.io" }]
  }
}
```

---

## 4. Links & Radios

### `/link` -- Link List

Two links on this dual-radio processor:

| Link | Type | Key Properties |
|------|------|----------------|
| `/link/439` | RF (CCA) | Channel 26, SubnetAddress 33495 |
| `/link/437` | ClearConnectTypeX (CCX/Thread) | Channel 25, PANID 12345 |

### Link 437: CCX (Thread)

```json
{
  "Link": {
    "href": "/link/437",
    "LinkType": "ClearConnectTypeX",
    "LinkNumber": 1,
    "ClearConnectTypeXLinkProperties": {
      "PANID": 12345,
      "ExtendedPANID": "<thread-xpanid-b64>",
      "Channel": 25,
      "NetworkName": "",
      "NetworkMasterKey": "<thread-master-key-b64>"
    }
  }
}
```

**This is the Thread network credential dump** -- PANID, extended PAN ID (base64), channel,
and master key (base64) are all here. Sufficient to join the Thread network with an external
radio (confirmed working with nRF52840 dongle).

### Link 439: RF (CCA)

```json
{
  "Link": {
    "href": "/link/439",
    "LinkType": "RF",
    "LinkNumber": 2,
    "RFProperties": {
      "Channel": 26,
      "DefaultChannel": 26,
      "SubnetAddress": 33495
    }
  }
}
```

### Link Status (`/link/{id}/status`)

Both return `"OperatingModes": ["Normal"]`.

### `/link/{id}/associatedlinknode` -- Device List per Link

Returns all devices on a given link as LinkNode references with parent device href and link type.

- **Link 439 (CCA)**: 9 devices (1 processor, 5 plug-in dimmers, 2 Pico 4-button remotes, 1 PowPak CCO)
- **Link 437 (CCX)**: 24 devices (1 processor, 8 Sunnata hybrid keypads, 3 Sunnata dimmers, plus various others)

### `/link/{id}/associatedlinknode/expanded` -- Full Device Detail

The most valuable single endpoint. Returns every device on a link with full metadata including:
- Name, DeviceType, SerialNumber, ModelNumber
- AssociatedArea, AssociatedControlStation
- LocalZones (which zone(s) the device controls)
- FirmwareImage with Contents array (CCX OS, Boot, LightEngine versions)
- DeviceClass hex encoding
- AddressedState, AssociatedLink

Example device from expanded response:
```json
{
  "href": "/device/2138/linknode/2140",
  "LinkType": "ClearConnectTypeX",
  "Parent": {
    "Name": "Device 1",
    "DeviceType": "SunnataDimmer",
    "href": "/device/2138",
    "SerialNumber": 71146122,
    "ModelNumber": "HRST-PRO-N-XX",
    "LocalZones": [{ "href": "/zone/2154" }],
    "FirmwareImage": {
      "href": "/firmwareimage/2138",
      "Contents": [
        {
          "Type": "CCX",
          "OS": { "Firmware": { "DisplayName": "003.014.003r000" } },
          "Boot": { "Firmware": { "DisplayName": "001.006.000r000" } }
        }
      ]
    },
    "DeviceClass": { "HexadecimalEncoding": "45e0101" },
    "AddressedState": "Addressed"
  }
}
```

### Device Types Found on This System

| DeviceType | ModelNumber | Link | Count |
|-----------|-------------|------|-------|
| HWQSProcessor | DualRadioProcResidential | Both | 1 |
| SunnataDimmer | HRST-PRO-N-XX | CCX | 3+ |
| SunnataHybridKeypad | HRST-HN4B-XX, HRST-HN3RL-XX | CCX | 5+ |
| PlugInDimmer | HQR-3LD, HQR-3PD-1 | CCA | 5+ |
| Pico4Button | PJ2-4B-XXX-L01 | CCA | 2 |
| PowPakCCO | LMJ-CCO1-24-B | CCA | 1 |

---

## 5. Areas

### `/area` -- Area List

Returns all areas in a flat list. This system has 11 areas under one root:

| href | Name | IsLeaf |
|------|------|--------|
| `/area/3` | Example Residence (root) | false |
| `/area/32` | Office | true |
| `/area/912` | Garage | true |
| `/area/1208` | Hallway | true |
| `/area/1220` | Bathroom | true |
| `/area/1232` | Basement | true |
| `/area/1256` | Patio | true |
| `/area/1280` | Master Bedroom | true |
| `/area/1304` | Kitchen | true |
| `/area/1316` | Living Room | true |
| `/area/1328` | Dining Room | true |
| `/area/1617` | Stairs | true |

### Per-Area Endpoints

| Endpoint | Status | Notes |
|----------|--------|-------|
| `/area/{id}` | 200 | Area detail with AssociatedZones, AssociatedControlStations, SortOrder |
| `/area/{id}/associatedzone` | 200 | Zone list for area (204 if no zones, e.g., root area) |
| `/area/{id}/associatedcontrolstation` | 200 | Control station list (204 if none, e.g., Patio) |
| `/area/{id}/associatedareascene` | 400 | Not supported on RA3 |
| `/area/{id}/associatedoccupancygroup` | 400 | Not supported on RA3 |
| `/area/summary` | 400 | Not supported on RA3 |

Example zone listing from `/area/32/associatedzone`:
```json
{
  "Zones": [
    {
      "href": "/zone/518",
      "Name": "Light",
      "AvailableControlTypes": ["Dimmed"],
      "Category": { "Type": "", "IsLight": true },
      "AssociatedArea": { "href": "/area/32" },
      "ControlType": "Dimmed"
    }
  ]
}
```

---

## 6. Zones

### Per-Zone Endpoints

| Endpoint | Status | Notes |
|----------|--------|-------|
| `/zone/{id}` | 200 | Zone detail (Name, ControlType, AvailableControlTypes, Category, AssociatedArea) |
| `/zone/{id}/status` | 200 | Level (0-100), StatusAccuracy, ZoneLockState |
| `/zone/{id}/status/expanded` | 200 | Status + full zone metadata in one call |
| `/zone/{id}/naturalshow` | 204 | Returns NoContent (Ketra natural show -- not active) |
| `/zone/{id}/commandprocessor` | 400 | Not supported via ReadRequest (requires CreateRequest) |
| `/zone/{id}/tuningsettings` | 404 | "This resource does not exist" |
| `/zone/{id}/phasesettings` | 404 | "This resource does not exist" |
| `/zone/{id}/fadesettings` | 400 | Not supported |
| `/zone/{id}/countdowntimer` | 404 | "This resource does not exist" |
| `/zone/{id}/facade` | 400 | Not supported |
| `/zone/{id}/loadcontroller` | 400 | Not supported |
| `/zone/{id}/curvedimming` | 400 | Not supported |
| `/zone/{id}/associatedareascene` | 400 | Not supported |
| `/zone/{id}/ledsettings` | 400 | Not supported |

### `/zone/status` -- All Zone Statuses

Returns all zone statuses in a single call (200 OK). Useful for bulk status polling.

### `/zone` (bare) -- 405 MethodNotAllowed

RA3 does not expose a zone list endpoint. Must use area walk:
`/area` -> `/area/{id}/associatedzone` -> `/zone/{id}`.

### Zone Status Example

```json
{
  "ZoneStatus": {
    "href": "/zone/518/status",
    "Level": 100,
    "Zone": { "href": "/zone/518" },
    "StatusAccuracy": "Good",
    "ZoneLockState": "Unlocked"
  }
}
```

### Zone Expanded Status Example

```json
{
  "ZoneExpandedStatus": {
    "href": "/zone/518/status",
    "Level": 100,
    "StatusAccuracy": "Good",
    "ZoneLockState": "Unlocked",
    "Zone": {
      "href": "/zone/518",
      "Name": "Light",
      "AvailableControlTypes": ["Dimmed"],
      "Category": { "Type": "", "IsLight": true },
      "AssociatedArea": { "href": "/area/32" },
      "ControlType": "Dimmed"
    }
  }
}
```

**Key finding**: `tuningsettings` and `phasesettings` return 404 ("does not exist") rather
than 400 ("not supported"), suggesting the resource type is recognized but not populated --
these are managed exclusively via Lutron Designer on HWQS systems.

---

## 7. Devices

### `/device` (bare) -- 204 NoContent

Unlike Caseta, RA3 returns an empty response for the device list endpoint.
Use `/link/{id}/associatedlinknode/expanded` instead for full device enumeration.

### `/device/status` -- 204 NoContent

### `/device/status/deviceheard` -- 405 MethodNotAllowed

### Per-Device Endpoints

| Endpoint | Status | Notes |
|----------|--------|-------|
| `/device/{id}` | 200 | Full device detail |
| `/device/{id}/status` | 200 | ConfigurationTransferStatus, Availability, BatteryStatus, StatusAccuracy |
| `/device/{id}/buttongroup` | 200/204 | Button groups (204 for devices without buttons, e.g., dimmers) |
| `/device/{id}/buttongroup/expanded` | 200/204 | Buttons with engravings, programming models, LEDs |
| `/device/{id}/ledsettings` | 500 | InternalServerError on all devices tested |
| `/device/{id}/led/status` | 400 | Not supported |
| `/device/{id}/fadesettings` | 400 | Not supported |
| `/device/{id}/tuningsettings` | 400 | Not supported |
| `/device/{id}/phasesettings` | 400 | Not supported |
| `/device/{id}/firmwareimage` | 400 | Not supported (use `/firmwareimage/{id}` directly) |
| `/device/{id}/networkinterface` | 400 | Not supported |
| `/device/{id}/associatedzone` | 400 | Not supported |
| `/device/{id}/associatedarea` | 400 | Not supported |
| `/device/{id}/componentstatus` | 400 | Not supported |
| `/device/{id}/loadcontroller` | 400 | Not supported |
| `/device/{id}/databaseproperties` | 400 | Not supported |
| `/device/{id}/addressedstate` | 400 | Not supported |

### Processor Device Example (`/device/435`)

```json
{
  "Device": {
    "Name": "Processor 001",
    "DeviceType": "HWQSProcessor",
    "href": "/device/435",
    "SerialNumber": 100000001,
    "ModelNumber": "DualRadioProcResidential",
    "NetworkInterfaces": [{ "MACAddress": "<ra3-mac>" }],
    "OwnedLinks": [
      { "href": "/link/439", "LinkType": "RF" },
      { "href": "/link/437", "LinkType": "ClearConnectTypeX" }
    ],
    "FirmwareImage": {
      "Firmware": { "DisplayName": "26.00.11f000" },
      "Installed": { "Year": 2026, "Month": 1, "Day": 26 }
    },
    "DeviceFirmwarePackage": { "Package": { "DisplayName": "002.025.018r000" } },
    "DeviceClass": { "HexadecimalEncoding": "8180101" },
    "AddressedState": "Addressed",
    "IsThisDevice": true
  }
}
```

### Device Status Examples

Processor (always available):
```json
{
  "DeviceStatus": {
    "href": "/device/435/status",
    "Device": { "href": "/device/435" },
    "Availability": "Available"
  }
}
```

Remote device (keypad/dimmer/pico):
```json
{
  "DeviceStatus": {
    "href": "/device/483/status",
    "Device": { "href": "/device/483" },
    "ConfigurationTransferStatus": "NotRequired",
    "Availability": "Unknown",
    "BatteryStatus": { "LevelState": "Unknown" },
    "StatusAccuracy": "Good"
  }
}
```

Pico remote (battery-powered):
```json
{
  "DeviceStatus": {
    "href": "/device/694/status",
    "ConfigurationTransferStatus": "NotRequired",
    "Availability": "Unknown",
    "BatteryStatus": { "LevelState": "Good" }
  }
}
```

### Button Group Expanded Example

`/device/483/buttongroup/expanded` for a Sunnata hybrid keypad (HRST-HN3RL-XX):

```json
{
  "ButtonGroupsExpanded": [{
    "href": "/buttongroup/493",
    "ProgrammingType": "Freeform",
    "Buttons": [
      {
        "href": "/button/494",
        "ButtonNumber": 1,
        "ProgrammingModel": {
          "href": "/programmingmodel/626",
          "ProgrammingModelType": "AdvancedToggleProgrammingModel"
        },
        "Name": "Button 1",
        "Engraving": { "Text": "Office" },
        "AssociatedLED": { "href": "/led/490" }
      }
    ]
  }]
}
```

---

## 8. Firmware

### `/firmwareimage/{id}`

Returns firmware version details for individual devices. Not available via `/device/{id}/firmwareimage`
(400) -- must use the direct href.

Example for a CCX dimmer with LightEngine:
```json
{
  "FirmwareImage": {
    "href": "/firmwareimage/1091",
    "Device": { "href": "/device/1091" },
    "Contents": [
      {
        "Type": "CCX",
        "OS": {
          "Firmware": { "DisplayName": "003.014.003r000" },
          "AvailableForUpload": { "DisplayName": "003.014.003r000" }
        },
        "Boot": {
          "Firmware": { "DisplayName": "002.000.005r000" },
          "AvailableForUpload": { "DisplayName": "002.000.005r000" }
        }
      },
      {
        "Type": "LightEngine",
        "OS": {
          "Firmware": { "DisplayName": "003.014.003r000" },
          "AvailableForUpload": { "DisplayName": "003.014.003r000" }
        }
      }
    ]
  }
}
```

When `Firmware.DisplayName != AvailableForUpload.DisplayName`, a firmware update is pending.

---

## 9. Buttons, Presets, Scenes

### `/button` -- 200 OK (empty object `{}`)

Returns 200 but with no button data. Individual buttons accessible via `/button/{id}`.

### `/button/{id}` -- Button Detail

```json
{
  "Button": {
    "href": "/button/1024",
    "ButtonNumber": 1,
    "ProgrammingModel": {
      "href": "/programmingmodel/1025",
      "ProgrammingModelType": "SingleActionProgrammingModel"
    },
    "Parent": { "href": "/buttongroup/1023" },
    "Name": "Button 1",
    "Engraving": { "Text": "On" }
  }
}
```

### `/buttongroup/{id}` -- Button Group Detail

```json
{
  "ButtonGroup": {
    "href": "/buttongroup/1023",
    "Parent": { "href": "/device/1020" },
    "SortOrder": 0,
    "Category": { "Type": "Lights" },
    "ProgrammingType": "Freeform"
  }
}
```

### `/programmingmodel/{id}` -- Programming Model

```json
{
  "ProgrammingModel": {
    "href": "/programmingmodel/1025",
    "Parent": { "href": "/button/1024" },
    "ProgrammingModelType": "SingleActionProgrammingModel",
    "Preset": { "href": "/preset/1026" }
  }
}
```

Programming model types observed: `SingleActionProgrammingModel`, `AdvancedToggleProgrammingModel`,
`SingleSceneRaiseProgrammingModel`, `SingleSceneLowerProgrammingModel`.

### `/controlstation/{id}` -- Control Station

```json
{
  "ControlStation": {
    "href": "/controlstation/1018",
    "Name": "Desk Pedestal",
    "AssociatedArea": { "href": "/area/912" },
    "AssociatedGangedDevices": [{
      "Device": {
        "href": "/device/1020",
        "DeviceType": "Pico4Button",
        "AddressedState": "Addressed"
      },
      "GangPosition": 0
    }]
  }
}
```

### Bare Endpoint Status

| Endpoint | Status |
|----------|--------|
| `/buttongroup` | 204 NoContent |
| `/buttongroup/expanded` | 400 |
| `/presetassignment` | 204 NoContent |
| `/virtualbutton` | 204 NoContent |
| `/programmingmodel` | 204 NoContent |
| `/preset` | 400 |
| `/areascene` | 400 |
| `/areasceneassignment` | 400 |
| `/controlstation` | 405 MethodNotAllowed |

---

## 10. Occupancy & Time Clocks

### `/occupancygroup` -- 204 NoContent

No occupancy groups configured on this system.

### `/occupancygroup/status` -- 204 NoContent

### `/timeclock`

```json
{
  "Timeclocks": [{
    "href": "/timeclock/4",
    "Parent": { "href": "/project" },
    "Name": "Sunrise/sunset"
  }]
}
```

### `/timeclock/status`

```json
{
  "TimeclockStatuses": [{
    "href": "/timeclock/4/status",
    "Timeclock": { "href": "/timeclock/4" },
    "EnabledState": "Enabled"
  }]
}
```

### `/timeclockevent` -- Scheduled Events

Two astronomic events configured:

```json
{
  "TimeclockEvents": [
    {
      "href": "/timeclockevent/651",
      "Parent": { "href": "/timeclock/4" },
      "ProgrammingModel": { "href": "/programmingmodel/656" },
      "Name": "Evening",
      "ScheduleType": "DayOfWeek",
      "Sunday": true, "Monday": true, "Tuesday": true,
      "Wednesday": true, "Thursday": true, "Friday": true, "Saturday": true,
      "BeginDate": { "Day": 18, "Month": 2, "Year": 2026 },
      "TimeclockEventType": "Astronomic",
      "AstronomicEventType": "Sunset",
      "AstronomicTimeOffset": "0"
    },
    {
      "href": "/timeclockevent/676",
      "Name": "Morning",
      "TimeclockEventType": "Astronomic",
      "AstronomicEventType": "Sunrise",
      "AstronomicTimeOffset": "0"
    }
  ]
}
```

---

## 11. IPL (Integration Protocol)

The IPL server is exposed at:
- **TLS:8902** -- direct TLS connection
- **WSS:443** -- WebSocket Secure

```json
{
  "Server": {
    "href": "/server/ipl",
    "Type": "IPL",
    "IPLProperties": {
      "SystemNumber": 1,
      "SystemAddress": "239.0.38.1",
      "ProcessorID": 0
    }
  }
}
```

IPL is a text-based integration protocol (not JSON like LEAP). It requires certificates
signed by `CN=Lutron Project SubSystem Certificate Authority` -- different from the LEAP
certificates. Used by Lutron Designer and professional integrators for programming and
real-time integration.

The multicast SystemAddress `239.0.38.1` is used for processor discovery on the local network.

---

## 12. What RA3 Does NOT Expose via LEAP ReadRequest

### Device Configuration (all return 400 "not supported")

These are Caseta-only via LEAP, or Designer-only on HWQS:

- `/device/{id}/ledsettings` -- 500 InternalServerError (present but broken)
- `/device/{id}/led/status` -- 400
- `/device/{id}/fadesettings` -- 400
- `/device/{id}/tuningsettings` -- 400
- `/device/{id}/phasesettings` -- 400
- `/zone/{id}/fadesettings` -- 400
- `/zone/{id}/tuningsettings` -- 404 (resource doesn't exist)
- `/zone/{id}/phasesettings` -- 404 (resource doesn't exist)
- `/zone/{id}/countdowntimer` -- 404

### List Endpoints (405 MethodNotAllowed)

- `/zone` -- must use area walk
- `/controlstation` -- must use `/area/{id}/associatedcontrolstation`
- `/device/status/deviceheard` -- subscribe-only

### Empty or Inactive (204 NoContent)

- `/device` -- returns empty (use link walk instead)
- `/device/status` -- returns empty
- `/daynightmode` -- present but no content
- `/facade` -- no shades on system
- `/naturalshow` -- no Ketra devices
- `/occupancygroup` -- none configured

### Not Supported at All (400)

- `/area/summary` -- not supported on RA3
- `/area/{id}/associatedareascene` -- not supported
- `/area/{id}/associatedoccupancygroup` -- not supported
- `/homekitdata`, `/associatedalias` -- not supported
- `/household`, `/favorite` -- Sonos integration not configured
- `/firmware`, `/firmware/status`, `/operatingstatus` -- not supported
- `/softwareupdate`, `/softwareupdate/status` -- not supported
- `/log`, `/certificate/root` -- not supported
- `/database` (bare) -- not supported (only `/@Project` works)
- `/system/status/daynightstate`, `/system/action` -- not supported
- `/system/status/crosssign` -- not supported
- `/loadcontroller`, `/curvedimming`, `/spectrum`, `/whitetuning`, `/warmdim` -- not supported
- `/fanspeedconfiguration`, `/cco`, `/receptacle` -- not supported
- `/fadefighterproperties/programmingmodel/preset` -- not supported
- `/detectiongroup` -- not supported
- `/device/commandprocessor` -- not supported via ReadRequest
- `/buttongroup/expanded` (bare) -- not supported
- `/preset` (bare), `/areascene`, `/areasceneassignment` -- not supported

### Provisioning/Management (400)

- `/api/v1/provisioning/client`, `/api/v2/provisioning/client`
- `/api/v2/remotepairing/application/association`
- `/cloudprovision`, `/crosssign`
- `/devicediscovery`, `/deviceactivation`, `/deviceextraction`
- `/unpaireddevice`, `/pairing`, `/commissioning`, `/addressing`
- `/migration`, `/transfer`
- `/diagnostics`, `/debug`, `/logging`, `/crash`
- `/reset`, `/factory`, `/backup`, `/restore`, `/export`, `/import`

---

## 13. Speculative Endpoints Tested (all 400)

These endpoints were probed speculatively and all returned 400 "This request is not supported":

**Networking**: `/network`, `/wifi`, `/ethernet`, `/bluetooth`, `/thread`, `/zigbee`, `/rf`,
`/radio`, `/antenna`, `/channel`

**Device management**: `/sensor`, `/motionsensor`, `/photosensor`, `/temperaturesensor`,
`/devicediscovery`, `/deviceactivation`, `/deviceextraction`, `/unpaireddevice`,
`/pairing`, `/commissioning`, `/addressing`, `/migration`, `/transfer`

**System management**: `/diagnostics`, `/debug`, `/logging`, `/crash`, `/reset`, `/factory`,
`/backup`, `/restore`, `/export`, `/import`

**Automation**: `/schedule`, `/automation`, `/rule`, `/trigger`, `/condition`, `/action`,
`/notification`, `/alert`

**Auth/security**: `/user`, `/client`, `/session`, `/permission`, `/role`, `/access`, `/security`

**Status/telemetry**: `/update`, `/version`, `/status`, `/health`, `/info`, `/config`,
`/settings`, `/preferences`, `/telemetry`, `/metrics`, `/counters`, `/statistics`, `/performance`

**Energy**: `/power`, `/energy`, `/loadshedding` (bare), `/peak`, `/demand`

---

## Navigation Patterns for RA3

Since RA3 lacks flat list endpoints, use these traversal patterns:

**All zones**: `/area` -> for each area: `/area/{id}/associatedzone` -> `/zone/{id}/status`

**All devices**: `/link` -> for each link: `/link/{id}/associatedlinknode/expanded`
(single call gives all device detail + firmware versions)

**Zone control**: `/zone/{id}/commandprocessor` via `CreateRequest` (not ReadRequest)

**Buttons/scenes**: `/device/{id}/buttongroup/expanded` -> `/programmingmodel/{id}` -> `/preset/{id}`

---

# LEAP API Exploration Results: Caseta Processor (<caseta-ip>)

Caseta Smart Bridge 2, firmware v01.123, explored 2026-03-06.

**Source data**: `data/leap-explore-<caseta-ip>-2026-03-06.json`, `data/leap-explore-caseta-followup.json`

---

## Executive Summary

| Metric | Count |
|--------|-------|
| Total endpoints probed | 963 |
| Successful (200 OK) | 316 |
| Failed (400/404/405) | 647 |

Caseta exposes **more configuration endpoints** than RA3 — device settings (LED, trim, phase),
countdown timers, occupancy groups, and system actions are all accessible. It also supports flat
list endpoints (`/zone`, `/device`, `/controlstation`) unlike RA3's area-walk model.

## RA3 vs Caseta Comparison

| Feature | RA3 (HWQS v03.247) | Caseta (v01.123) |
|---------|---------------------|-------------------|
| `/zone` list | 405 MethodNotAllowed | 200 OK |
| `/device` list | 204 NoContent | 200 OK |
| `/controlstation` list | 405 MethodNotAllowed | 200 OK |
| `/device/{id}/ledsettings` | 400 BadRequest | **200 OK** |
| `/zone/{id}/tuningsettings` | 400 BadRequest | **200 OK** |
| `/zone/{id}/phasesettings` | 400 BadRequest | **200 OK** |
| `/zone/{id}/countdowntimer` | 400 BadRequest | **200 OK** |
| `/occupancygroup/{id}` | 204 NoContent | **200 OK** |
| `/system/action` | 400 BadRequest | **200 OK** |
| `/system/loadshedding/status` | **200 OK** | 405 MethodNotAllowed |
| `/link/{id}` (direct read) | **200 OK** | 404 NotFound |
| IPL server (TLS:8902, WSS:443) | **Available** | Not available |
| BACnet service | **Available** | Not available |
| Thread/CCX link | **Yes** (link/437) | No (RF only) |
| Services | 7 (incl. BACnet, NTP) | 6 (incl. AutoProgrammer) |
| `/area/summary` | **200 OK** | 400 BadRequest |

## Caseta System Info

```json
// /server — single LEAP server, no IPL
{
  "Servers": [{
    "href": "/server/1",
    "Type": "LEAP",
    "EnableState": "Enabled",
    "LEAPProperties": { "PairingList": { "href": "/server/leap/pairinglist" } },
    "Endpoints": [{ "Protocol": "TCP", "Port": 8081 }],
    "ProtocolVersion": "01.123"
  }]
}

// /project
{
  "Project": {
    "Name": "Smart Bridge Project",
    "ProductType": "Lutron Smart Bridge Project",
    "GUID": "04D0B59115F38AFB1A140D20B2D6AB0939EFEA4A",
    "DeviceRules": { "href": "/project/devicerule/1" }
  }
}

// /networkinterface/1 — no IPv6, no SOCKS5 proxy (simpler than RA3)
{
  "NetworkInterface": {
    "MACAddress": "<caseta-mac>",
    "IPv4Properties": { "Type": "DHCP", "IP": "<caseta-ip>" },
    "AdapterType": "Ethernet"
  }
}
```

## Caseta Device Configuration (not available on RA3)

### LED Settings — `/device/{id}/ledsettings`

```json
{
  "LEDSettings": {
    "href": "/ledsettings/64",
    "IdleLED": { "EnabledState": "Enabled" },
    "NightlightLED": { "EnabledState": "Enabled" }
  }
}
```
Writable via `UpdateRequest` to `/ledsettings/{id}`.

### Tuning Settings — `/zone/{id}/tuningsettings`

```json
{
  "TuningSettings": {
    "href": "/zone/12/tuningsettings",
    "HighEndTrim": 100,
    "EnergyTrim": 100,
    "LowEndTrim": 1.2
  }
}
```
All dimmer zones expose trim. Energy trim is always 100% (not user-configurable via app).

Writable via `UpdateRequest`:
```json
{ "TuningSettings": { "HighEndTrim": 95, "LowEndTrim": 5 } }
```

### Phase Settings — `/zone/{id}/phasesettings`

```json
{ "PhaseSettings": { "href": "/zone/41/phasesettings", "Direction": "Reverse" } }
```
Only present on dimmer zones with phase-selectable hardware. Values: `"Forward"`, `"Reverse"`.

### Countdown Timers — `/zone/{id}/countdowntimer`

```json
{
  "CountdownTimer": {
    "href": "/countdowntimer/18",
    "Timeout": "4:00:00",
    "EnabledState": "Enabled",
    "AssociatedZone": { "href": "/zone/10" }
  }
}
```

All configured timers on this Caseta system:

| Zone | Timeout | Enabled |
|------|---------|---------|
| 6 | 1:00:00 | Yes |
| 10 | 4:00:00 | Yes |
| 12 | 4:00:00 | Yes |
| 15 | 15:00 | Yes |
| 20 | 2:00:00 | Yes |
| 21 | 3:00:00 | Yes |
| 22 | 2:00:00 | Yes |
| 25 | 30:00 | Yes |
| 28 | 15:00 | Yes |
| 41 | 2:00:00 | Yes |
| 42 | 4:00:00 | Yes |

Creatable via `CreateRequest` to `/zone/{id}/countdowntimer`, updatable via `UpdateRequest` to `/countdowntimer/{id}`.

## Caseta-Only Features

### System Actions — `/system/action`

```json
{
  "Actions": [
    {
      "href": "/system/action/1",
      "Name": "Arrive",
      "Statements": [{
        "Do": {
          "Type": "Command",
          "Resource": { "href": "/virtualbutton/1/commandprocessor" },
          "Command": { "CommandType": "PressAndRelease" }
        }
      }]
    },
    {
      "href": "/system/action/2",
      "Name": "Leave",
      "Statements": [{
        "Do": {
          "Type": "Command",
          "Resource": { "href": "/virtualbutton/2/commandprocessor" },
          "Command": { "CommandType": "PressAndRelease" }
        }
      }]
    }
  ]
}
```

### Virtual Buttons — `/virtualbutton/{id}`

```json
{
  "VirtualButton": {
    "href": "/virtualbutton/1",
    "Name": "Arriving Home",
    "ButtonNumber": 0,
    "ProgrammingModel": { "href": "/programmingmodel/2" },
    "IsProgrammed": false
  }
}
```

### AutoProgrammer Service — `/service/autoprog`

Caseta-only. Automatically programs default scenes for newly paired devices.
```json
{ "Service": { "Type": "AutoProgrammer", "AutoProgrammerProperties": { "EnabledState": "Enabled" } } }
```

### Occupancy Groups — `/occupancygroup/{id}`

```json
{
  "OccupancyGroup": {
    "href": "/occupancygroup/1",
    "AssociatedAreas": [{ "Area": { "href": "/area/2" } }],
    "ProgrammingType": "Freeform",
    "OccupiedActionSchedule": { "ScheduleType": "None" },
    "UnoccupiedActionSchedule": { "ScheduleType": "None" }
  }
}
```

### Natural Light Optimization — `/naturallightoptimization/1`

```json
{
  "NaturalLightOptimization": {
    "StartTime": { "AstronomicEventType": "Sunrise", "AstronomicTimeOffset": "0" },
    "EndTime": { "AstronomicEventType": "Sunset", "AstronomicTimeOffset": "0" },
    "FadeFighterProperties": {
      "href": "/naturallightoptimization/1/fadefighterproperties",
      "ProgrammingModels": [
        { "href": "/programmingmodel/103" },
        { "href": "/programmingmodel/106" }
      ]
    }
  }
}
```
Status: `{ "EnabledState": "Disabled" }` — configurable via `UpdateRequest`.

### Device Rules — `/project/devicerule/1`

```json
{ "DeviceRules": { "Rules": [{ "MaxAllowed": 75 }] } }
```
Maximum 75 devices on Caseta Smart Bridge.

## Caseta Link (RF Only)

Single CCA/RF link, no Thread/CCX:
```json
{
  "Links": [{
    "href": "/link/1",
    "LinkType": "RF",
    "RFProperties": { "Channel": 26, "DefaultChannel": 26 }
  }]
}
```
24 devices on `/link/1/associatedlinknode/expanded`.

## Home Assistant Integration Notes

For Home Assistant users wanting to leverage these endpoints:

1. **Countdown timers** — Create/update via LEAP to add auto-off behavior to any zone
2. **LED settings** — Control status LEDs on dimmers/switches (Caseta only)
3. **Trim settings** — Adjust dimmer range remotely (Caseta only)
4. **Phase settings** — Switch forward/reverse dimming phase (Caseta only)
5. **NLO** — Enable/disable natural light optimization with sunrise/sunset scheduling
6. **Virtual buttons** — Trigger "Arrive"/"Leave" scenes programmatically
7. **System actions** — Read automation rules and their trigger commands
8. **Zone commands** — Full control via `/zone/{id}/commandprocessor` with `GoToDimmedLevel`, `GoToSwitchedLevel`, `Raise`, `Lower`, `Stop`
9. **Occupancy groups** — Configure occupancy-based automation schedules
10. **Firmware monitoring** — Track device firmware versions via `/firmwareimage/{id}`
