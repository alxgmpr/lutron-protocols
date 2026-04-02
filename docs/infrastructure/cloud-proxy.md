# Cloud LEAP Proxy & Firmware Update Flow

**Discovered 2026-02-16** from HAR capture of Caseta iOS app firmware update check.

## Cloud LEAP Proxy

The Lutron iOS app can relay **any LEAP command** to a bridge through the cloud:

```
POST https://api.iot.lutron.io/api/v2/leap/{bridge-id}
Authorization: Bearer {token}
Content-Type: application/json

{
  "CommuniqueType": "ReadRequest",
  "Header": { "Url": "/zone/12/status" }
}
```

- **Auth**: Bearer token from `device-login.lutron.com`
- **Bridge ID format**: `caseta-{32-char-hex}` — opaque, server-assigned
  - NOT a simple hash of serial, MAC, or GUID (all tested, none match)
  - Our bridge: `caseta-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`
- **Full LEAP relay**: sends standard CommuniqueType JSON, returns LEAP response
- Can send ANY command type: ReadRequest, CreateRequest, UpdateRequest, SubscribeRequest

### Bridge Registration

`GET device-login.lutron.com/api/v1/integrationapplications/userreport` returns:
```json
{
  "integrations": [
    {
      "mac_address": "A0B1C2D3E4F5",
      "applications": [{
        "application_id": 2,
        "application_name": "Smart Bridge Application",
        "application_client_id": "e001a4471eb6152b7b3f35e549905fd8589dfcf57eb680b6fb37f20878c28e5a"
      }]
    }
  ]
}
```

Two bridges registered: `A0B1C2D3E4F5` (Caseta) and `A0B1C2D3E4F6` (second MAC).

## Firmware Update Check Flow

Complete sequence from HAR capture (9 requests):

| # | Target | Request | Purpose |
|---|--------|---------|---------|
| 1 | `device-login.lutron.com` | GET `/api/v1/integrationapplications/userreport` | Auth + bridge list |
| 2 | `connect.lutron.io` | GET `/device-firmware/static/locales/en-US/translation.json` | UI i18n strings |
| 3 | Cloud LEAP | ReadRequest `/project` | Bridge info, project GUID |
| 4 | Cloud LEAP | ReadRequest `/firmwareupdatesession` | Check for existing update session |
| 5 | Cloud LEAP | ReadRequest `/project` | (redundant, maybe race condition) |
| 6 | Cloud LEAP | ReadRequest `/operation/status` | Check for ongoing operations |
| 7 | Cloud LEAP | ReadRequest `/server/status/ping` | Verify bridge connectivity |
| 8 | Cloud LEAP | ReadRequest `/device/1` | Bridge firmware version |
| 9 | Cloud LEAP | ReadRequest `/link/1/associatedlinknode/expanded` | ALL devices + firmware |

### How Firmware Check Works

The app does **NOT** use `fwcs.lutron.com` for Caseta. Instead:

1. Reads `/link/{id}/associatedlinknode/expanded` via cloud proxy
2. Each device has `FirmwareImage.Contents[].OS`:
   - `Firmware.DisplayName` = current firmware version
   - `AvailableForUpload.DisplayName` = latest available version
3. If they differ → device needs update
4. All our devices currently match (up to date)

### Bridge Device Details (from cloud)

```json
{
  "Device": {
    "Name": "Smart Bridge 2",
    "DeviceType": "SmartBridge",
    "SerialNumber": 100000002,
    "ModelNumber": "L-BDG2-WH",
    "FirmwareImage": {
      "Firmware": { "DisplayName": "08.25.17f000" },
      "Installed": { "Year": 2026, "Month": 1, "Day": 24 }
    },
    "DeviceFirmwarePackage": {
      "Package": { "DisplayName": "001.003.004r000" }
    },
    "RepeaterProperties": { "IsRepeater": true },
    "IsThisDevice": true
  }
}
```

## New LEAP Routes Discovered

| Route | Caseta | RA3 | Notes |
|-------|--------|-----|-------|
| `/firmwareupdatesession` | 204 | 200 | Firmware update session management |
| `/operation/status` | 204 | 200 (completed session!) | Firmware upload progress |
| `/server/status/ping` | 200 (v1.123) | 200 (v3.247) | Lightweight health check |
| `/link/{id}/associatedlinknode/expanded` | 200 (27 nodes) | 200 (20+20 nodes) | **THE assembled URL** |

### `/link/{id}/associatedlinknode/expanded`

This is the most valuable single endpoint — returns ALL devices on a link with full details inline:
- Device name, type, serial, model
- FullyQualifiedName (area path)
- LocalZones, ButtonGroups
- FirmwareImage with current + available versions
- AddressedState, DeviceRules
- EngravingKit (for picos)
- RFProperties.ChannelSet.Frequency: "434" (on bridge)

### RA3 Firmware Update Session

RA3 has a **completed background firmware update** for 5 CCX devices:
```json
{
  "FirmwareUpdateSessions": [{
    "href": "/fwsessiondevice/@Proc-232-Op-4",
    "DeviceFirmwareUploadProgress": [{ "href": "/operation/@Proc-232-Op-4" }]
  }]
}
```

Operation status shows all 5 devices at 100/100 steps, Status: Complete, Priority: Background.

## Firmware Version Inventory

### CCA Devices (Caseta)
| Model | Type | Current FW | Available FW |
|-------|------|-----------|--------------|
| L-BDG2-WH | SmartBridge | `08.25.17f000` | — |
| DVRF-5NS | DivaSmartSwitch | `003.021.000r000` | same |
| DVRF-6L | DivaSmartDimmer | `003.021.000r000` | same |
| DVRF-5NE-XX | DivaSmartDimmer | `003.012.000r000` | same |
| PD-3PCL-WH | PlugInDimmer | `001.054.000r000` | — |
| PD-FSQN-XX | FanSpeedController | `001.005.000r000` | — |
| PJ2-* | Picos (all) | `000.000.000r000` | — |

### CCX Devices (RA3)
| Model | Type | OS FW | Boot FW | Available |
|-------|------|-------|---------|-----------|
| JanusProcRA3 | Processor | `26.00.11f000` | — | — |
| RRST-PRO-N-XX | SunnataDimmer | `003.014.003r000` | `001.006.000r000` | same |
| RRST-HN3RL-XX | SunnataHybridKeypad | `003.014.003r000` | `002.000.005r000` | same |
| Older CCX devices | Various | `001.043.005r000` | — | `003.014.003r000` |

### DeviceClass.HexadecimalEncoding
| Hex | Type | Radio |
|-----|------|-------|
| `45e0101` | SunnataDimmer | CCX |
| `45f0101` | SunnataSwitch | CCX |
| `1290201` | SunnataHybridKeypad | CCX |
| `1270101` | SunnataKeypad | CCX |
| `81b0101` | RadioRa3Processor | — |
| `4140201` | PlugInDimmer (addressed) | CCA |
| `4140101` | PlugInDimmer (unaddressed) | CCA |
| `40c0201` | MaestroDimmer | CCA |
| `1070201` | Pico | CCA |

Last digit may encode AddressedState (1=unaddressed, 2=addressed).

## Firmware Cloud Services (fwcs.lutron.com)

**NOT used for Caseta firmware checks** — app uses cloud LEAP proxy instead.

- `GET fwcs.lutron.com/api/v1/client/check` (no params):
  ```json
  {"Required": false, "Address": "35.172.25.236"}
  ```
  - `Required` = whether firmware update is required
  - `Address` = firmware server IP (NOT user's IP)
  - Passing old CODEVER might return `Required: true` + download info

- `GET fwcs.lutron.com/api/v1/client/check?CODEVER=26.00.11f000&DEVCLASS=081B0101` → `{}`
- `GET fwcs.lutron.com/summary?CODEVER=...&DEVCLASS=...` → untested
- `POST fwcs.lutron.com` → `{"message":"Missing Authentication Token"}`

### Other Firmware URLs
| URL | Purpose |
|-----|---------|
| `firmwareupdates.lutron.com:443/sources` | Lutron Designer firmware source |
| `firmware-downloads.iot.lutron.io/phoenix/final/` | RA3 firmware packages |
| `connect.lutron.io/device-firmware/{sha1_hash}` | Web portal (not direct download) |
| `connect.dev.lutron.io/device-firmware/ff6ebda0f36670a4a6c634b00b82217cd68a6a01` | Dev URL from app binary |

## Firmware Update Initiation (Reverse-Engineered from App Binary)

Two distinct firmware update paths exist in the app:

### Path A: Bridge Firmware (Legacy, SSH + Cloud WebView)
- Used for updating the bridge/processor itself
- SSH-based: `"SSH connection established - let us go for a round of firmware update"`
- Loads a cloud WebView from `connect.lutron.io/device-firmware` to orchestrate
- `FirmwareUpgradeHelper` class (Obj-C), source: `MMWService helper/FirmwareUpgradeHelper.m`
- `CheckFirmwareStatusCommand` sends LEAP command, gets `Required` status
- `checkIfFirmwareSolutioningReqd:andDevClass:` — checks by device class

### Path B: CCA/CCX Device Firmware (KMM-based, via LEAP)
- Used for updating paired devices (dimmers, switches, keypads)
- KMM framework: `KMMUnifiedBackend.framework`
- Flow:
  1. `getCcaFirmwareUpdateSupportedDevices` → list of updatable devices
  2. `fetchCCADeviceFirmwareUpdateDetails` → firmware details per device
  3. `BeginTransferSessionCommand` → tell processor to download firmware
  4. Processor downloads firmware from cloud, OTAs to devices over RF/Thread
  5. Track progress via `/operation/status` subscription

### BeginTransferSession LEAP Command

Reconstructed from KMM class hierarchy:

```json
{
  "CommuniqueType": "CreateRequest",
  "Header": { "Url": "/server/1/commandprocessor" },
  "Body": {
    "Command": {
      "BeginTransferSession": {
        "BeginTransferSessionParameters": {
          "Download": {
            "DownloadFrom": {
              "Protocol": "HTTPS",
              "HttpsParameters": { "...": "firmware download URL" }
            }
          },
          "FilePackage": {
            "FilePackageDestination": { "...": "destination on processor" }
          }
        }
      }
    }
  }
}
```

**Protocol enum**: `"HTTP"`, `"HTTPS"`, `"sftp"`, `"S3"`

**Related classes**:
- `KMMUBLeapBeginTransferSessionCommand` → top-level command
- `KMMUBLeapBeginTransferSessionCommandBody` → body wrapper
- `KMMUBLeapBeginTransferSessionParametersDownload` → download source
- `KMMUBLeapBeginTransferSessionParametersFilePackage` → destination
- `KMMUBLeapDownloadFromModel` → `initWithProtocol:HttpsParameters:` or `initWithProtocol:S3Parameters:`

### Firmware Update Session LEAP Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/firmwareupdatesession` | Read | Check for active session |
| `/firmwareupdatesession` | Create | Start new update session |
| `/operation/status` | Read/Subscribe | Track upload progress |
| `/server/1/commandprocessor` | Create | Send BeginTransferSession command |

### Operation State Machine

From binary string analysis, firmware operations progress through:
`idle` → `active`/`inProgress`/`uploading` → `complete`/`done`/`success`

Error states: `failed`, `error`, `cancelled`, `unknown`

Progress tracking fields:
- `DeviceFirmwareUploads[].Steps.Completed` / `.Total` — step progress (e.g. 100/100)
- `TimeMetrics.InProgress.EstimatedTimeRemaining` — ETA string
- `Priority.Category` — `"Background"` for non-blocking updates

### RA3 Firmware Update Session (Live Data)

RA3 has a completed session for 5 CCX devices. Despite showing "Complete" (100/100 steps),
the devices are still on old firmware (`001.043.x`), not the available `003.014.003r000`.
This suggests the session may have been a check/prepare step, not the actual flash.

| Device | Current OS | Available | Session Status |
|--------|-----------|-----------|----------------|
| 2399 | `001.043.008r000` | `003.014.003r000` | Complete |
| 2351 | `001.043.005r000` | `003.014.003r000` | Complete |
| 2422 | `001.043.005r000` | `003.014.003r000` | Complete |
| 3131 | `001.043.005r000` | `003.014.003r000` | Complete |
| 2306 | `001.043.005r000` | `003.014.003r000` | Complete |

### Untested / Future Work

- **CreateRequest `/firmwareupdatesession`** on Caseta — all devices up to date, likely rejected
- **Triggering RA3 CCX update** — devices genuinely need updates, would capture Thread OTA
- **Capturing CCA OTA RF packets** — firmware update over 433MHz would reveal new packet types
- **fwcs.lutron.com with old CODEVER** — may return `Required: true` + download URL
- **`firmware-downloads.iot.lutron.io/phoenix/final/`** — RA3 firmware packages, URLs 404 (wrong format?)

## HAR Capture Details

File: `captures/app-fw-update-check/Untitled.har`

Contains 9 requests captured during firmware update check in Caseta iOS app (v26.0.0).
All responses are base64-encoded in the HAR file.

### i18n Translation Strings (from request 2)
The firmware update UI strings reveal:
- "Updates may take up to 15 minutes per device"
- "Wireless control may be delayed and lights may briefly turn off while updates are in progress"
- "Updates will continue in background if you navigate away"
- Separate messaging for CCA ("Clear Connect Type A") devices
- Support for Caseta, RadioRA 3, and HomeWorks QSX firmware updates
