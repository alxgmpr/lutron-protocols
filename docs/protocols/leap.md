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

---

# Route Reference (from iOS App Binary RE)

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

---

## Command Processor Endpoints

Commands are sent as `CreateRequest` to `commandprocessor` URLs.

| Class | URL Pattern | Used By |
|-------|-------------|---------|
| `ZoneHrefCommandprocessor` | `/zone/{id}/commandprocessor` | ZoneCommand |
| `AreaHrefCommandprocessor` | `/area/{id}/commandprocessor` | AreaCommand |
| `DeviceHrefCommandprocessor` | `/device/{id}/commandprocessor` | IdentifyCommand |
| `LoadControllerHrefCommandprocessor` | `/loadcontroller/{id}/commandprocessor` | LoadCommand |
| `LinkHrefCommandprocessor` | `/link/{id}/commandprocessor` | LinkCommand |
| `NaturalShowHrefCommandprocessor` | `/naturalshow/{id}/commandprocessor` | NaturalShowCommand |
| `SystemCommandprocessorUrl` | `/system/commandprocessor` | system-level commands |
| `DatabaseHrefCommandprocessor` | `/database/commandprocessor` | ApplyDatabaseCommand |
| `DayNightModeHrefCommandprocessor` | `/daynightmode/commandprocessor` | DayNightModeCommand |

### Preset Assignment Command Processors (13 zone types)

Each maps to `/preset/{id}/{type}assignment/commandprocessor`:
Dimmers, Switches, Shades (position/tilt/tilt-when-closed), Tilt, CCO, ColorTuning, SpectrumTuning, WhiteTuning, WarmDim, Receptacle, FanSpeed.

---

## Non-Zone Command Classes

| # | Command | Endpoint | Sub-commands |
|---|---------|----------|-------------|
| 2 | AreaCommand | `/area/{id}/commandprocessor` | `GoToGroupLightingLevel` |
| 3 | LoadCommand | `/loadcontroller/{id}/commandprocessor` | `GoToDimmedLevel` (direct load controller) |
| 4 | MultiZoneCommand | (system) | `GoToMixedLevel` (atomic multi-zone) |
| 5 | IdentifyCommand | `/device/{id}/commandprocessor` | `Start`, `Stop` (flash LED) |
| 6 | LinkCommand | `/link/{id}/commandprocessor` | `CacheDeviceHeard` (pairing) |
| 7 | TuningSettingsCommand | | `TestHighEndTrim`, `TestLowEndTrim` |
| 8 | ApplyDatabaseCommand | `/database/commandprocessor` | `ApplyNow` |
| 9 | BeginTransferSessionCommand | | `BeginTransferSession` (firmware) |
| 10 | CloudProvisionCommand | | `CloudProvision` |
| 11 | DayNightModeCommand | `/daynightmode/commandprocessor` | `EditDayNightMode` |
| 12 | GenerateLogPackageCommand | | `GenerateLogPackage` |
| 13 | NaturalShowCommand | `/naturalshow/{id}/commandprocessor` | `EditNaturalShowRamp` |
| 14 | PresetAssignmentCommand | | `Filter` |
| 15 | DeviceDiscoveryCommand | | `DeviceDiscovery` (scan for unpaired) |
| 16 | UnassignmentCommand | | (remove device assignments) |

---

## CRUD Operations (SyncServiceFramework)

Higher-level service operations the app uses, built on LEAP request primitives.

### Read Operations

| Service | Description |
|---------|-------------|
| `ZoneSceneRead` | Read scenes for a zone |
| `ZoneDetailsRead` | Read zone details by hrefs |
| `PaginatedZoneExpandedStatusWhereOnRead` | All zone statuses (paginated) |
| `DeviceStatusRead` / `DeviceDefinitionRead` | Device status and definitions |
| `AreaSummaryDefinitionRead` | Area summaries |
| `ControlStationDetailsRead` | Keypad details |
| `CurveDimmingRead` | Dimming curve definitions |
| `LEDStatusRead` | LED bar status on device |
| `LinksRead` | All radio links |
| `OperationStatusRead` | Firmware/operation status |
| `PaginatedAssociatedLinkNodesExpandedRead` | All devices on a link (expanded) |

### Create/Update Operations

| Service | Description |
|---------|-------------|
| `ZoneUpdateName` / `AreaSceneUpdateName` | Rename zone or scene |
| `CountdownTimerCreate` / `CountdownTimerUpdate` | Countdown timers |
| `KeypadButtonPress` | Simulate button press |
| `WidgetZoneUpdateCommand` | iOS widget zone control |
| `VoiceControlCreateAlias` / `AddHomeKitResource` | Voice/HomeKit integration |

---

## Data Models

### Zone Control Types (`LeapZoneControlType`)

Dimmed, Switched, Shade, ShadeWithTilt, ShadeWithTiltWhenClosed, Tilt, SpectrumTuning (Ketra RGB), WhiteTuning, WarmDim, CCO, Receptacle, FanSpeed.

### Zone Status Types

ZoneStatus, ZoneStatusFanSpeed, ITiltStatus, OccupancyStatus, CountdownTimer, ZoneLockState, Temperature, NaturalLightOptimizationStatus, DeviceStatus.

### Notable Findings

1. `/loadcontroller/{id}/commandprocessor` targets the physical load controller (separate from zone).
2. `MultiZoneCommand.GoToMixedLevel` enables atomic multi-zone scene activation.
3. `LinkCommand.CacheDeviceHeard` is the LEAP-side pairing mechanism.
4. `ApplyDatabaseCommand.ApplyNow` triggers immediate programming changes.
5. `WidgetZoneUpdateCommand` is the iOS home screen widget's simplified command path.

---

# CCX Device Addressing via LEAP

Discovery notes from 2026-03-28. Successfully addressed CCX (Thread) devices via LEAP
without physical hardware. The Lutron iOS/Android app's BLE commissioning flow was
reverse-engineered from the Android APK (jadx decompilation) to find the exact LEAP JSON payload.

## The Working AddressDevice Flow

### Prerequisites
1. CCX link must be in **Association** mode
2. Exactly **one** IPv6 address must be provided in `IPv6Properties.UniqueLocalUnicastAddresses`
3. The IPv6 address must be **reachable on Thread** — the processor's own RLOC works

### LEAP Request

```
CreateRequest /device/{deviceId}/commandprocessor
```

```json
{
  "Command": {
    "CommandType": "AddressDevice",
    "AddressDeviceParameters": {
      "SerialNumber": 90000001,
      "DeviceClassParameters": {
        "Action": "Overwrite",
        "DeviceClass": {
          "HexadecimalEncoding": "45e0101"
        }
      },
      "IPv6Properties": {
        "UniqueLocalUnicastAddresses": ["fd00::ff:fe00:3800"]
      }
    }
  }
}
```

### Post-Addressing
- Revert link to Normal mode
- Device shows `AddressedState: "Addressed"` and `SerialNumber: <value>`
- Zone `StatusAccuracy` remains "Bad" until a DEVICE_REPORT is received

## What We Tried and Why It Failed

### Wrong IPv6 format (ErrorCode 11)
- `"IPAddress": "fd00::1"` — wrong key name, processor ignores it
- No IPv6 at all — processor returns ErrorCode 11 ("Failed to activate")
- Random IPv6 addresses — processor tries to contact device, gets no response

### Missing Association mode
- Without Association mode, AddressDevice still fails with ErrorCode 11
- Both Association mode AND correct IPv6 are required

### Empty/multiple addresses (400 BadRequest)
- `"UniqueLocalUnicastAddresses": []` → "must contain only one IPv6Address but got 0"
- `"UniqueLocalUnicastAddresses": ["a","b"]` → "must contain only one IPv6Address but got 2"

### CCA-style AddressDevice (no IPv6Properties)
- Works for CCA devices (RF link) but fails for CCX (Thread) devices
- CCX requires the IPv6Properties field

### Re-addressing already-addressed devices
- Returns 204 NoContent (success) without needing Association mode or IPv6
- The "activate" step only runs on first-time addressing

## Key Findings from Android APK RE

### Source: `com.lutron.lsb` v26.1.0.4 (APK decompiled with jadx)

### LEAP Model Classes (Kotlin/KMM)

```
com.lutron.leap.common.model.AddressDevice
  @JsonClassDiscriminator("CommandType")
  └─ Address (@SerialName("AddressDevice"))
     └─ AddressDeviceParameters: AddressDeviceParametersModel

com.lutron.leap.zone.loadcontroller.AddressDeviceParametersModel
  ├─ SerialNumber: UInt (kotlin.UInt, serialized as integer)
  ├─ DeviceClassParameters: DeviceClassParametersModel (required)
  │   ├─ Action: String ("Overwrite")
  │   └─ DeviceClass: DeviceClass
  │       └─ HexadecimalEncoding: String
  └─ IPv6Properties: IPv6Properties? (optional, nullable)
      └─ UniqueLocalUnicastAddresses: List<String> (exactly 1 entry required)

com.lutron.leap.common.request.body.AssignmentCommandBody
  └─ Command: AddressDevice (field name = "Command")
```

### Assignment Flow (CcxDeviceRepo.kt + BleAssignmentStrategy.kt)

1. `enterAddressing(linkHref)` — sets link to Association mode
2. `addressDevice(deviceHref, bleDeviceInfo)` — builds AddressDeviceParametersModel:
   - SerialNumber from BLE device info
   - DeviceClassParameters("Overwrite", deviceClass from BLE metadata)
   - IPv6Properties(listOf(staticAddress from BLE assignment data))
3. Wraps in AssignmentCommandBody(AddressDevice.Address(params))
4. Sends CreateRequest to `/device/{id}/commandprocessor`
5. On error NOT_IN_ADDRESSING_MODE → retry
6. On error SERIAL_NUMBER_ALREADY_ACTIVATED → handle
7. `exitAddressing(linkHref)` — reverts link to Normal mode

### Request Metadata (Header)

The app also sends `UnverifiedMetadata` in the LEAP Header:
```json
{
  "Header": {
    "Url": "/device/{id}/commandprocessor",
    "ClientTag": "...",
    "UnverifiedMetadata": {
      "UnverifiedUserPrincipal": "updaterRef",
      "UnverifiedTimestamp": "2026-03-28T00:00:00Z"
    }
  }
}
```
This metadata is NOT required for AddressDevice to succeed (tested without it).

## Processor Behavior

- ErrorCode 11 = "Failed to activate device with serial number: N"
  - Occurs when IPv6Properties is missing or address is unreachable
  - NOT a serial number validation (any serial triggers same error)
  - NOT a cloud check (no network traffic during attempt)
  - The processor attempts to contact the device at the provided IPv6 via CoAP
  - Using the processor's own RLOC bypasses this check (it can always reach itself)

- 204 NoContent = success (device addressed)
- 400 BadRequest = malformed body (wrong types, wrong list size)

## Network Topology Reference

- RA3 Processor: 10.0.0.1 (LEAP port 8081, TLS)
- CCX Link: /link/437 (ClearConnectTypeX)
- Thread: channel 25, PAN ID 0xXXXX, mesh-local fd00::/64
- Processor RLOC: 0x3800 → fd00::ff:fe00:3800

## LEAP Route Probing Results (2026-02-15)

### Overview

Probed all known LEAP routes on both RA3 (10.0.0.1) and Caseta (10.0.0.2) processors.
Key finding: **Caseta exposes rich config endpoints, RA3 does not** — RA3 config is done
via Lutron Designer, not LEAP.

### Route Availability Matrix

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

### Zone Config Endpoints (Caseta only)

#### `/zone/{id}/tuningsettings` — HIGH/LOW TRIM
Returns `{ TuningSettings: { HighEndTrim, EnergyTrim, LowEndTrim } }` (percentages)
- Only present on dimmer zones, not switched/fan zones
- EnergyTrim always 100 (see below)
- Example: Zone 41 Vanity: HighEndTrim=70.1, LowEndTrim=1.2
- Example: Zone 39 Main Lights: HighEndTrim=100, LowEndTrim=28

#### `/zone/{id}/phasesettings` — PHASE CONTROL
Returns `{ PhaseSettings: { Direction: "Forward" | "Reverse" } }`
- Only on newer dimmers (DVRF-5NE-XX) — NOT on older DVRF-6L
- Zone 39 (Main Lights, DVRF-5NE): Forward
- Zone 41 (Vanity, DVRF-5NE): Reverse
- Zone 42 (Shower, DVRF-5NE): Reverse

#### `EnergyTrim` — What is it?
- Always returns 100 in our data
- **NOT exposed in the Caseta app UI** — no user-facing control
- App binary has: `initWithHighEndTrim:EnergyTrim:LowEndTrim:MinimumLightLevel:`
- **HYPOTHESIS:** A **commercial/utility feature** for demand response / load shedding
  - Would cap max brightness below HighEndTrim (e.g. 80% energy trim = 80% max output)
  - Related to `/system/loadshedding/status` (which RA3 has, Caseta doesn't)
  - Probably only used in HomeWorks QSX / commercial deployments

#### `MinimumLightLevel`
- Referenced in TuningSettings init but NOT returned by LEAP endpoint
- May be computed from LowEndTrim or only available via Lutron Designer

#### RA3: No config endpoints
- `/zone/{id}/tuningsettings` → "This resource does not exist"
- `/zone/{id}/phasesettings` → "This resource does not exist"
- `/device/{id}/tuningsettings` → "This request is not supported"
- RA3 config is done exclusively via Lutron Designer software
- RA3 zones don't have TuningSettings/CountdownTimer hrefs in zone objects

### Countdown Timers (Caseta)
- **Bridge-side auto-off timers** — NOT device-side
- Bridge tracks timer and sends OFF command when timeout expires
- 14 timers across 19 zones (some zones don't have timers)
- Timeout format: "HH:MM:SS" or "MM:SS"
- Range: 15 minutes to 8 hours
- EnabledState: "Enabled" or "Disabled"
- Readable via `/countdowntimer` (list all) or `/countdowntimer/{id}` (single)

### Preset Assignments — DELAY CONFIRMED
- 103 assignments on Caseta
- Each has: `Fade` (seconds), `Delay` (seconds), `Level` (0-100), `AffectedZone`
- **All current assignments**: fade=2 delay=0 (70) or fade=0 delay=0 (33)
- No assignments with delay > 0 currently, but the FIELD EXISTS and accepts values
- `/dimmedlevelassignment/{id}` has `FadeTime` and `DelayTime` (string format, e.g. "2")
- `/switchedlevelassignment/{id}` has `DelayTime` and `SwitchedLevel: "On"/"Off"`
- **This confirms delay is a real LEAP feature** — we can create assignments with delay > 0

### Programming Models
- 184 total on Caseta
- **SingleActionProgrammingModel: 148** — standard button press → preset
- **DualActionProgrammingModel: 24** — ALL tied to OccupancyGroups (press=occupied, release=unoccupied)
- **SingleSceneRaiseProgrammingModel: 6** — pico raise buttons
- **SingleSceneLowerProgrammingModel: 6** — pico lower buttons
- **NO AdvancedToggleProgrammingModel** — confirms Caseta doesn't have toggle/double-tap scenes
- The 24 DualAction models are for occupancy sensor behavior, not user button programming

### RA3 Server Endpoint Details
- Protocol version: 03.247
- **UDP port 2647** advertised in `/server/1` Endpoints
- No reference to port 2647 in Lutron iOS app binary or KMM backend
- Not in Lutron Designer strings either (checked)
- **HYPOTHESIS:** Possibly for Lutron integration protocol, device discovery broadcast, HomeWorks QS integration, or third-party systems
- Worth probing with UDP packet capture (netcat, Wireshark)

### Cloud LEAP Proxy (DISCOVERED 2026-02-16)

**`api.iot.lutron.io/api/v2/leap/{bridge-id}`** — full LEAP relay through Lutron cloud!
- Discovered from HAR capture of firmware update check flow in Caseta app
- Auth: Bearer token from `device-login.lutron.com`
- Bridge ID format: `caseta-{md5_hash}` — opaque, server-assigned (NOT simple hash of serial/MAC/GUID)
- Sends standard LEAP CommuniqueType JSON in POST body, returns LEAP response
- **Can send ANY LEAP command** — read, create, update, subscribe
- Capture file: `captures/app-fw-update-check/Untitled.har`

#### Firmware Update Check Flow (from HAR, 9 requests)
1. `GET device-login.lutron.com/api/v1/integrationapplications/userreport` → auth + bridge list
2. `GET connect.lutron.io/device-firmware/static/locales/en-US/translation.json` → UI i18n strings
3. Cloud LEAP → `ReadRequest /project` (bridge info, GUID)
4. Cloud LEAP → `ReadRequest /firmwareupdatesession` (check for existing update)
5. Cloud LEAP → `ReadRequest /project` (redundant, maybe race condition)
6. Cloud LEAP → `ReadRequest /operation/status` (check for ongoing operations)
7. Cloud LEAP → `ReadRequest /server/status/ping` (verify bridge connectivity, LEAPVersion)
8. Cloud LEAP → `ReadRequest /device/1` (bridge firmware: `08.25.17f000`, package `001.003.004r000`)
9. Cloud LEAP → `ReadRequest /link/1/associatedlinknode/expanded` (ALL 27 devices + firmware)

#### New LEAP Routes (from HAR)
| Route | RA3 | Caseta | Notes |
|-------|-----|--------|-------|
| `/firmwareupdatesession` | 200 (has completed session!) | 204 | Firmware update session management |
| `/operation/status` | 200 (5 devices complete) | 204 | Firmware update progress tracking |
| `/server/status/ping` | 200 (LEAPVersion 3.247) | 200 (LEAPVersion 1.123) | Lightweight health check |
| `/link/{id}/associatedlinknode/expanded` | 200 (20 CCA + 20 CCX nodes) | 200 (27 nodes) | **THE assembled URL** — all devices in one call |
| `/fwsessiondevice/@Proc-232-Op-4` | 405 | n/a | Session detail not directly readable |

#### RA3 Firmware Update Session
- RA3 has a COMPLETED background firmware update for 5 CCX devices
- Operation: `@Proc-232-Op-4`, Status: Complete, all 5 devices at 100/100 steps
- Priority: Background (doesn't interrupt normal operation)
- Devices: 2399, 2351, 2422, 3131, 2306

#### Link Node Expanded Details
- `/link/1/associatedlinknode/expanded` (Caseta CCA) — 27 devices, all firmware current
- `/link/236/associatedlinknode/expanded` (RA3 CCA) — 20 devices
- `/link/234/associatedlinknode/expanded` (RA3 CCX) — 20 devices, some need updates
  - RA3 CCX link is `/link/234` (not 237 as initially guessed)
  - Found from processor's `OwnedLinks` field

#### Firmware Version Strings
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

#### Firmware Cloud Services
- `fwcs.lutron.com/api/v1/client/check` — NOT used for Caseta firmware check (app uses cloud LEAP)
  - No-params returns `{"Required": false, "Address": "35.172.25.236"}` (fw server IP, not user IP)
  - With CODEVER/DEVCLASS params returns `{}` — may need auth or different params
- `firmwareupdates.lutron.com:443/sources` — Lutron Designer firmware source
- `firmware-downloads.iot.lutron.io/phoenix/final/` — RA3 firmware packages
- **App checks firmware by comparing** `FirmwareImage.Contents[].OS.Firmware.DisplayName` vs `OS.AvailableForUpload.DisplayName` — if different, update available

### DeviceClass.HexadecimalEncoding (Complete)
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

### NLO (Natural Light Optimization)
- Sunrise-to-sunset window, configurable per-zone
- FadeFighter (anti-lumen-depreciation) runs within NLO window
- 8 programming models (one per zone?) with presets

### Device Details
- `DeviceClass.HexadecimalEncoding` — see table above
- `AddressedState`: "Addressed" (paired) or "Unaddressed" (unpaired/removed)
- `FirmwareImage.Contents[].Type`: "CCA" or "CCX" — useful for determining radio type
- `LinkNode.LinkType`: "RF" (CCA) or "ClearConnectTypeX" (CCX)
- `RFProperties.ChannelSet.Frequency`: "434" (CCA, from Caseta bridge expanded)

### Probe Scripts Created
- `tools/leap-probe.ts` — bulk route availability test
- `tools/leap-probe-deep.ts` — follow hrefs for device/zone details
- `tools/leap-probe-config.ts` — device config, presets, scenes
- `tools/leap-probe-sub.ts` — sub-resources (device rules, link nodes, firmware)
- `tools/leap-probe-tuning.ts` — zone tuning/phase/dimming curves
- `tools/leap-probe-ra3.ts` — RA3-specific area walk exploration
- `tools/leap-probe-detail.ts` — preset assignments, programming models, timers
