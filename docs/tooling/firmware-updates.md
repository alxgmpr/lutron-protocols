# Lutron Firmware Update Infrastructure

Reverse-engineered from Lutron Designer 26.0.1.100 (.NET CIL disassembly), iOS app binary
(KMM/Obj-C), and HAR captures. Covers all three firmware delivery paths: Designer (SSH push),
iOS app (cloud-orchestrated OTA), and the underlying cloud APIs.

## Firmware Download API

The legacy firmware check/download server used by Lutron Designer:

```
POST https://firmwareupdates.lutron.com:443/sources
Content-Type: application/x-www-form-urlencoded

username=lutron-bridge&password=<redacted>&macid=<ra3-mac>&deviceclass=081B0101&coderev=26.00.11f000&datestamp=5C8FA501
```

**Must be form-encoded** — JSON returns `400 Missing request parameters`.

### Parameters

| Parameter | Description | Example |
|-----------|-------------|---------|
| `username` | Fixed credential | `lutron-bridge` |
| `password` | Fixed credential | `<redacted>` |
| `macid` | Processor MAC (colon-separated) | `<ra3-mac>` |
| `deviceclass` | Processor device class (hex) | `081B0101` |
| `coderev` | Current firmware version | `26.00.11f000` |
| `datestamp` | Build timestamp (hex LE unix) | `5C8FA501` |

Discovered from CIL disassembly of `FirmwareFileServiceManager` constructor (RVA 0x3be80) in
`Lutron.Gulliver.Infrastructure.dll`. The constructor initializes a `Dictionary<string,string>`
called `FirmwareFileUrlRequestParameters` with these hardcoded defaults, which are then
overridden with actual processor values before the POST.

### Response

```json
{"Status": "200 OK", "Url": "https://firmware-downloads.iot.lutron.io/phoenix/final/26.00.13f000"}
```

Response type is `FirmwareFileServiceResponseDto` with fields `{Status, Url, Message}`.

### CDN Paths by Product Line

| CDN Path | Product | Device Classes | Latest Version |
|----------|---------|---------------|----------------|
| `phoenix/final/{ver}` | RA3 / HomeWorks QSX | 0x0811 - 0x081B | `26.00.13f000` |
| `lite-heron/final/{ver}` | Caseta | 0x0820 | `26.00.11f000` |

- **phoenix** = RA3 processor codename, **heron** = Caseta codename
- CDN is CloudFront backed by S3 (`firmware-downloads.iot.lutron.io`)
- Server always returns the latest version regardless of `coderev` sent
- Returned URLs currently 404 (`NoSuchKey`) — likely wrong URL format or missing path component
- Only processor-level device classes work; CCA/CCX device classes return `404 Unknown device class`

### Device Class Enumeration

Tested device classes 0x0811 through 0x0820:

| Range | Response | Notes |
|-------|----------|-------|
| 0x0811 - 0x081B | `200 OK` → `phoenix/final/26.00.13f000` | RA3/HW QSX processors |
| 0x081C - 0x081F | `404 Unknown device class` | Unassigned |
| 0x0820 | `200 OK` → `lite-heron/final/26.00.11f000` | Caseta bridge |
| 0x045E, 0x040C, etc. | `404 Unknown device class` | CCA/CCX device classes not supported |

## Firmware Download Flow (Lutron Designer)

From CIL disassembly of `Lutron.Gulliver.Infrastructure.dll`:

```
FirmwareFileServiceManager.ctor (RVA 0x3c892):
    restClient = new RestClient(new Uri(FirmwareUpgradeServerUrl))

GetFirmwareFileUrl (RVA 0x3c914):
    return restClient.PostAsync("", FirmwareFileUrlRequestParameters)

GetFileDownloadUrl (RVA 0x3c0d0):
    response = GetFirmwareFileUrl(params).Result
    // response is FirmwareFileServiceResponseDto {Status, Url, Message}
    return response

<DownloadFirmwareFileAsync>b__42_0 (RVA 0x3c828):
    if (GetInternetStatus()) {
        response = GetFileDownloadUrl()
        if (response != null && !String.IsNullOrWhiteSpace(response.Url)) {
            DownloadFirmwareFileFromUrl(response.Url)  // downloads ZIP
        }
    }

DownloadFirmwareFileFromUrl (RVA 0x3c16c):
    TempDirectory → download from URL → save as "lutron_firmware" → extract ZIP
    → read "device-firmware-manifest.json"
```

The Designer downloads the firmware ZIP, extracts it, reads the device manifest, then pushes
firmware to the processor via SSH.

## Firmware Download Flow (iOS App)

The iOS app uses a cloud-orchestrated approach via LEAP:

1. `getCcaFirmwareUpdateSupportedDevices` → list of updatable devices
2. `fetchCCADeviceFirmwareUpdateDetails` → firmware details per device
3. `BeginTransferSession` LEAP command → tells processor to download from cloud
4. Processor downloads firmware directly from S3 (not through the app)
5. Processor OTAs firmware to devices over RF (CCA 433MHz) or Thread (CCX)
6. App tracks progress via `/operation/status` subscription

### BeginTransferSession LEAP Command

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

Protocol enum: `"HTTP"`, `"HTTPS"`, `"sftp"`, `"S3"` (S3 uses `{Bucket, Key, VersionId}`).

From KMM framework classes: `KMMUBLeapBeginTransferSessionCommand`,
`KMMUBLeapBeginTransferSessionParametersDownload`,
`KMMUBLeapDownloadFromModel` with `initWithProtocol:HttpsParameters:` or `S3Parameters:`.

### Firmware Update Session LEAP Endpoints

| Endpoint | Methods | Purpose |
|----------|---------|---------|
| `/firmwareupdatesession` | Read, Create | Check/start firmware sessions |
| `/operation/status` | Read, Subscribe | Track upload progress |
| `/server/1/commandprocessor` | Create | Send BeginTransferSession |
| `/server/status/ping` | Read | Health check |

### Operation State Machine

`idle` → `active`/`inProgress`/`uploading` → `complete`/`done`/`success`

Error states: `failed`, `error`, `cancelled`, `unknown`

Progress fields: `Steps.Completed`/`.Total`, `EstimatedTimeRemaining`, `Priority.Category`.

## Firmware Package Structure

Both RA3 and Vive firmware use the same ZIP-based encrypted package format:

```
lutron_firmware (ZIP)
├── firmware.tar.enc               AES-128-CBC encrypted firmware tar
├── key.tar
│   ├── key.enc                    Encrypted AES key
│   ├── iv.hex                     AES initialization vector (hex string)
│   ├── algorithm                  "-aes-128-cbc"
│   └── message_digest             "md5" (key derivation hash)
├── manifest                       SHA256 checksums of all files
├── sigFiles/
│   └── manifest_2.sig             Digital signature
├── device-firmware-manifest.json  Device class → firmware mapping
├── versionInfo                    Version string (e.g. "26.00.13f000")
├── EULA                           License text
└── EULA.zip                       Compressed license
```

### Encryption

- **Algorithm**: AES-128-CBC
- **Key wrapping differs by product**:
  - Vive hub: `key.enc` = 512 bytes (RSA-4096 encrypted AES key)
  - RA3 package: `key.enc` = 48 bytes base64 (different wrapping scheme)
- **Decryption happens on the processor** — neither Designer nor iOS app decrypt firmware
- The processor's RSA private key decrypts `key.enc` to recover the AES key, then
  decrypts `firmware.tar.enc` with that key + `iv.hex`

### Extracted Packages

| Source | Version | Size | Location |
|--------|---------|------|----------|
| Lutron Designer MSIX | `26.00.13f000` | 98 MB | `QuantumResi/BinDirectory/Firmware/phoenix/lutron_firmware` |
| Vive hub file | `01.24.07f000` | 112 MB | `vive-hub-v01.24.07f000.vive` |

## Device Firmware Manifest

Extracted from `device-firmware-manifest.json` in the RA3 firmware package (v002.025.019r000).
Contains 25 device types with firmware paths inside `firmware.tar.enc`.

### Internal Codenames

| Codename | Product Line | Radio | Notes |
|----------|-------------|-------|-------|
| **dart** | Sunnata | CCX | dimmer, switch, keypad, fan, hybrid keypad |
| **pegasus** | Smart bulb, downlight | CCX | basic Thread devices |
| **powerbird** | Next-gen keypads/dimmers | CCX | newer than dart |
| **hercules** | Unknown (+ sensor variant) | CCX | two device classes |
| **robin** | Trim kit | CCX | |
| **lorikeet** | MG12 radio module | CCX | also called "mg12" |
| **omnikeet** | Radio module | CCX | |
| **thin-mint** | Unknown | CCX | |
| **lutron-dynamic** | Unknown | CCX | |
| **eagle-owl** | CCA device | CCA | 3 hardware variants |
| **bananaquit** | CCA device | CCA | "avis" subtype |
| **basenji** | CCA device | CCA | |

### CCX Device Firmware

| DeviceClass | Codename | LEAP DeviceType | App FW | Boot FW |
|------------|----------|-----------------|--------|---------|
| `0x045E0101` | dart-rf-dimmer | SunnataDimmer | `003.014.003` | `001.006.000` |
| `0x045F0101` | dart-rf-switch | SunnataSwitch | `003.014.003` | `002.000.005` |
| `0x01270101` | dart-keypad | SunnataKeypad | `003.014.003` | `002.000.005` |
| `0x04670101` | dart-rf-fan-control | — | `003.014.003` | `002.000.015` |
| `0x01290201` | dart-hybrid-keypad-main | SunnataHybridKeypad | `003.014.003` | `002.000.005` |
| `0x012D0201` | powerbird-keypad | — | `003.013.004` | `002.000.015` |
| `0x012B0201` | powerbird-hybrid-dimmer-main | — | `003.013.004` | `002.000.015` |
| `0x012E0101` | powerbird-hybrid-switch-main | — | `003.013.004` | `002.000.015` |
| `0x1B010101` | bulb-pegasus | — | `002.000.020` | `002.000.005` |
| `0x1B030101` | downlight-pegasus | — | `002.000.021` | `002.000.005` |
| `0x1B060101` | thin-mint | — | `002.003.022` | `002.000.015` |
| `0x1B080101` | lutron-dynamic | — | `002.003.022` | `002.000.015` |
| `0x06140101` | n3-radio-pegasus-broadcast | — | `002.000.023` | `002.000.005` |
| `0x06190201` | rf-dongle-pegasus-broadcast | — | `002.000.022` | `002.000.005` |
| `0x16261301` | hercules-rf | — | `003.003.012` | `001.004.000` |
| `0x16271301` | hercules-sensor | — | `003.003.012` | `001.004.000` |
| `0x061A0101` | mg12-lorikeet | — | `003.014.013r01` | `002.000.005` |
| `0x061E0101` | omnikeet | — | `003.014.012r01` | `002.000.015` |
| `0x1B070301` | robin-trimkit | — | `003.011.015` | `002.000.012` |

### CCA Device Firmware

All CCA devices share the same firmware version `002.026.000r000`:

| DeviceClass | Codename | App FW | Boot FW |
|------------|----------|--------|---------|
| `0x03120101` | eagle-owl (HW rev 1) | `002.026.000` | `001.001.000` |
| `0x03120102` | eagle-owl (HW rev 2) | `002.026.000` | `001.001.000` |
| `0x03120103` | eagle-owl (HW rev 3) | `002.026.000` | `001.001.000` |
| `0x03140601` | bananaquit-avis | `002.026.000` | `002.000.000` |
| `0x030A0601` | bananaquit-avis (shared FW) | `002.026.000` | `002.000.000` |
| `0x03150201` | basenji | `002.026.000` | `002.000.000` |

### Firmware Image Format

- `.pff` files (Pegasus Firmware Format) inside `firmware.tar.enc`
- Each device has separate App and Boot images
- `LinkFileName` field (e.g. `"0a"`, `"1b"`) — short name used on processor filesystem
- `EstimatedFastUploadTimeInSeconds` — typically 604s for app, 14s for boot
- `MinimumRevisions` — required boot version before app can be updated
- SHA256 hash per image for integrity verification

## Lutron Designer Internals

### Source Binary

`Lutron Designer 26.0.1.100.msix` (657 MB) is a ZIP-based MSIX package containing:
- `Lutron.Gulliver.QuantumResi.exe` — thin .NET WPF launcher
- `Lutron.Gulliver.Infrastructure.dll` (7.7 MB) — core logic including firmware management
- `Lutron.Gulliver.LutronCloudApiIntegration.dll` (365 KB) — cloud API integration
- 238 embedded QS firmware files (`.s19`, `.ldf`, `.zip`) in `QuantumResi/BinDirectory/Firmware/`
- `FirmwareHeaderFile.xml` (205 KB) — QS device class → firmware file mapping

### Analysis Method

Binary Ninja cannot decompile .NET CIL bytecode. Used `dnfile` Python library for:
- .NET PE metadata table parsing (MethodDef, Field, MemberRef, TypeRef, TypeDef)
- CIL opcode disassembly with metadata token resolution
- `#US` (User String) heap reading for embedded string literals
- FieldRVA table for static byte array initializers

Python venv at `/tmp/dnfile-venv/` with `dnfile` package.

### Config String Encryption (Crypto class)

`Lutron.Gulliver.Infrastructure.Utilities.Crypto.Decrypt` (RVA 0x14194):

1. Base64-decode input string
2. Load 13-byte password from static field (FieldRVA 0x7562c8)
3. **Password = `"Ivan Medvedev"`** (developer name, 13 bytes ASCII)
4. Create `Rfc2898DeriveBytes` with password + salt (from arg1)
5. Derive 32-byte AES key via `GetBytes(32)`
6. Derive 16-byte IV via `GetBytes(16)`
7. Decrypt with AES, return Unicode string

### Static Key Material

34 FieldRVA entries with static byte arrays. Notable:

| Field | RVA | Size | Content |
|-------|-----|------|---------|
| 8387 | `0x7562c8` | 13 | `"Ivan Medvedev"` — PBKDF2 password |
| 8399 | `0x7563d8` | 16 | `00 11 22 33 44 55 66 77 88 99 AA BB CC DD EE FF` — test AES key |

### Production API URLs

Extracted from embedded JSON config in Infrastructure.dll:

```
BackendCloudBaseUrl:           https://api.iot.lutron.io
SystemDeployApiBaseUrl:        https://api.iot.lutron.io/api/v1/deploy
DTDTApiBaseUrl:                https://api.design.lutron.io/api/v1
MSIXPackageSeviceUrl:          https://designer-services.lutron.com
IoTSupportFileUploadApiBase:   https://support-file-api.support.iot.lutron.io
IoTSupportFileXApiKeyValue:    eh7sRNvZ0j4VE893AfGOn6cuYgk6QDzIMvvYAjJb
CondorApiBaseUrl:              https://models.data.lutron.io/
PStoreOcpApimSubscriptionTkn:  66b40b966c7b49eaa2ca0a19b205c546
LutronAnalyticServiceUrl:      https://puekakk076.execute-api.us-east-1.amazonaws.com/prod/data
FirmwareUpgradeServerUrl:      https://firmwareupdates.lutron.com:443/sources
FirmwareUpgradeCloudServerUrl: https://firmware-downloads.iot.lutron.io/phoenix/final/
```

Both Staging and Production configs were extracted. Staging URLs use `*.dev.*` subdomains
and different subscription tokens.

## Firmware Cloud Services

### firmwareupdates.lutron.com (Lutron Designer)

- `POST /sources` — returns firmware download URL (see above)
- Form-encoded only, JSON returns 400
- Hosted on AWS (54.227.x.x), DigiCert TLS cert

### fwcs.lutron.com (iOS app, legacy check)

- `GET /api/v1/client/check` → `{"Required": false, "Address": "35.172.25.236"}`
- `GET /api/v1/client/check?CODEVER=...&DEVCLASS=...` → `{}` (no update needed)
- `POST /` → `{"message": "Missing Authentication Token"}`
- NOT used for Caseta — app uses cloud LEAP proxy instead

### firmware-downloads.iot.lutron.io (CDN)

- CloudFront distribution backed by S3
- Paths: `phoenix/final/`, `lite-heron/final/`
- Returned URLs currently 404 (`NoSuchKey`) — URL format may need additional path components
- No bucket listing (returns `NoSuchKey` for `index.html` default)

### Other Firmware URLs

| URL | Purpose |
|-----|---------|
| `connect.lutron.io/device-firmware/{hash}` | Web portal firmware page |
| `connect.dev.lutron.io/device-firmware/{hash}` | Dev portal (from app binary) |
| `api.iot.lutron.io/api/v1/deploy` | System deployment API |

## Firmware Version Inventory

### Processor Firmware

| Product | Model | Current FW | Latest Available |
|---------|-------|-----------|-----------------|
| RA3 Processor | JanusProcRA3 | `26.00.11f000` | `26.00.13f000` |
| Caseta Bridge | L-BDG2-WH | `08.25.17f000` | `26.00.11f000` (lite-heron) |

### CCA Devices (on Caseta bridge)

| Model | Type | Current FW |
|-------|------|-----------|
| DVRF-5NS | DivaSmartSwitch | `003.021.000r000` |
| DVRF-6L | DivaSmartDimmer | `003.021.000r000` |
| DVRF-5NE-XX | DivaSmartDimmer | `003.012.000r000` |
| PD-3PCL-WH | PlugInDimmer | `001.054.000r000` |
| PD-FSQN-XX | FanSpeedController | `001.005.000r000` |
| PJ2-* | Picos | `000.000.000r000` |

### CCX Devices (on RA3 processor)

| Model | Type | Current OS | Available |
|-------|------|-----------|-----------|
| RRST-PRO-N-XX | SunnataDimmer | `003.014.003r000` | same |
| RRST-HN3RL-XX | SunnataHybridKeypad | `003.014.003r000` | same |
| Older CCX (5 devices) | Various | `001.043.005r000` | `003.014.003r000` |

### DeviceClass Hex Encoding

| Hex | LEAP DeviceType | Radio |
|-----|-----------------|-------|
| `045E0101` | SunnataDimmer | CCX |
| `045F0101` | SunnataSwitch | CCX |
| `01270101` | SunnataKeypad | CCX |
| `01290201` | SunnataHybridKeypad | CCX |
| `081B0101` | RadioRa3Processor | — |
| `04140201` | PlugInDimmer (addressed) | CCA |
| `04140101` | PlugInDimmer (unaddressed) | CCA |
| `040C0201` | MaestroDimmer | CCA |
| `01070201` | Pico | CCA |

Last digit may encode AddressedState (1=unaddressed, 2=addressed).

## QS Legacy Firmware (Embedded in Designer)

`FirmwareHeaderFile.xml` maps QS hardware family/product/revision to firmware files:

```xml
<DeviceTypeFamily family="0x01">        <!-- QS Keypads -->
  <DeviceTypeProduct product="0x01">    <!-- seeTouch -->
    <DeviceTypeHardwareRev hardwarerev="0x01">
      <OSFirmwareFile>
        <Filename>qs_firmware_and_tools\QSWS2\Gen1\v7.008.s19</Filename>
        <MajorRev>7</MajorRev>
        <MinorRev>008</MinorRev>
        <DeltaTime>10</DeltaTime>
        <FirmwareUpdateSpeed>614</FirmwareUpdateSpeed>
      </OSFirmwareFile>
    </DeviceTypeHardwareRev>
  </DeviceTypeProduct>
</DeviceTypeFamily>
```

238 firmware files in `.s19` (Motorola S-record) and `.ldf` (Lutron Device Firmware) formats
for QS keypads, shades, dimmers, panels, DMX interfaces, thermostats, IR eyes, etc.

## Open Questions

- **Firmware decryption**: Processor's RSA private key needed to unwrap `key.enc`.
  Could potentially be extracted via SSH to processor or from a firmware dump.
- **CDN URL format**: Returned URLs 404 — may need file extension, auth headers,
  or different path construction than what the server returns
- **CCA OTA protocol**: What RF packet types are used for 433MHz firmware updates?
  Capturing a CCA firmware update would reveal new packet formats.
- **RA3 CCX update**: 5 devices need updates (`001.043` → `003.014`). Triggering
  this would capture Thread-based OTA traffic.
- **CCA device class → product mapping**: eagle-owl, bananaquit, basenji codenames
  need mapping to physical product models (Diva, Maestro, etc.)
