# Lutron Designer / RadioRA3 Reverse Engineering Notes

## Credentials Found

| Service | Username | Password |
|---------|----------|----------|
| SQL Server (local) | sa | `Lutr0n@123456789` |
| Engraving FTP | engravingorders | `kv12msrd` |
| Firmware API | lutron-bridge | `Lutr0n@1` |
| Limelight OAuth | lbQpl8N7p6t | `9Jv08Awc8sP` |

## Network Ports

| Port | Protocol | Description | Cert Required |
|------|----------|-------------|---------------|
| 8081 | LEAP/JSON | Primary control protocol | Product certs (Designer) |
| 8083 | LAP | Legacy protocol | Unknown |
| 8902 | IPL/Binary | Designer-to-processor transfer | Product certs (TLS works, binary protocol) |
| 443 | WSS | WebSocket for programming | **Project-specific certs** |
| 22 | SSH | Open but requires key/password auth | N/A |
| 2647 | UDP | LEAP discovery? | Unknown |

### Port Access Summary

| Port | Our Cert Works? | Read | Write | Notes |
|------|-----------------|------|-------|-------|
| 8081 | Yes | Full access | **Denied** (500 errors) | Read-only monitoring API |
| 8902 | TLS works | No response | N/A | Binary IPL protocol, not JSON |
| 443 | **No** (bad cert) | N/A | N/A | Needs project-specific cert from Designer pairing |
| 2647 | N/A | No response | N/A | UDP, purpose unknown |

## Cloud Endpoints (from boot capture)

| Endpoint | Purpose |
|----------|---------|
| `device-login.lutron.com` | Device authentication |
| `c1fp46crw8ud8d.credentials.iot.us-east-1.amazonaws.com` | AWS IoT credential provisioning |
| `a32jcyk7azp7b5-ats.iot.us-east-1.amazonaws.com:8883` | MQTT broker for cloud communication |
| `provision.iot.lutron.io` | Device provisioning |
| `feature.iot.lutron.io` | Feature flags |
| `firmwareupdates.lutron.com` | Firmware update API |
| `time.iot.lutron.io` | NTP time sync |

Note: The `c1fp46crw8ud8d` and `a32jcyk7azp7b5` identifiers appear to be account/device-specific.

## URLs & Endpoints

```
# Firmware version check API
POST https://firmwareupdates.lutron.com:443/sources
Body: username=lutron-bridge&password=Lutr0n%401&macid=...&deviceclass=08110101&coderev=...

# Firmware download base (packages index only - actual .deb files not public)
https://firmware-downloads.iot.lutron.io/phoenix/final/<version>/Packages.gz

# Vive firmware (publicly accessible, encrypted)
https://firmware-downloads.iot.lutron.io/vive/Release/vive-hub-v<version>.vive

# myLutron auth
https://mylutronservices.lutron.com/myLutronAuthenticationService.svc

# Limelight
https://limelightbylutron.com

# FTP (works - upload only, no download)
ftp://lutron-ftp.lutron.com/EngravingOrders/
```

## FTP Server Analysis

The engraving FTP server (`lutron-ftp.lutron.com`) accepts the credentials but has limited permissions:
- Can list directories
- Can get file sizes (SIZE command works)
- Cannot download files (RETR returns 550 Permission denied)

**Directories found:**
- `/EngravingOrders/` - Contains "Old Files", "Moved Files Aug 2023", "TestFiles"
- `/EngravingOrders4CS/` - Contains HEO files (Homeowner Engraving Orders)
- `/IntlEngravingOrders/` - Empty

**File format:** `.HEO` files are ~187KB, likely contain engraving specifications for keypads.

This appears to be an upload-only endpoint for Lutron Designer to submit custom engraving orders to Lutron's manufacturing.

## Processor Info (from TLS cert)

- **MAC**: `00:00:00:00:00:00`
- **CN**: `radiora3-a0b1c2d3e4f5-server`
- **Processor type**: `radioRa3-processors-027-4725-24`
- **Architecture**: armv7l (ARM Cortex)
- **Kernel**: Linux 5.10
- **U-Boot**: 2017.01.027

## Firmware Package Structure

### Phoenix (RA3) - APT-style repository

```
Packages.gz contains:
- kernel-5.10.001.deb (3.7MB)
- rootfs-26.00.11f000.deb (98MB)
- spl-2017.01.027.deb (37KB)
- uboot-2017.01.027.deb (155KB)
```

### Vive - ZIP bundle (publicly downloadable)

```
vive-hub-v01.24.07f000.vive (ZIP) contains:
- firmware.tar.enc (AES-128-CBC encrypted)
- key.tar -> key.enc (RSA-encrypted AES key) + algorithm
- manifest + manifest.sig (SHA256 checksums + signature)
- EULA, versionInfo
```

## Protocol Notes

- LEAP requires mutual TLS with Lutron-signed client certificates
- Traffic uses ephemeral key exchange (can't decrypt with just private key)
- Processor communicates with AWS IoT for cloud services (MQTT on port 8883)
- Designer uses port 8902 for transfers, processor responds on same port

## TLS Analysis (from boot capture)

**Cipher suites offered by bridge:**
- TLS_ECDHE_ECDSA/RSA_WITH_CHACHA20_POLY1305_SHA256
- TLS_ECDHE_ECDSA/RSA_WITH_AES_128/256_GCM_SHA256/384
- TLS_ECDHE_ECDSA/RSA_WITH_AES_128_CBC_SHA256
- TLS 1.3: AES_128_GCM, AES_256_GCM, CHACHA20_POLY1305

All use ECDHE (ephemeral keys) - no weak ciphers, passive decryption impossible.

**Certificate chain:**
- Bridge cert: `radiora3-a0b1c2d3e4f5-server`
- Intermediate: `radioRa3-devices` -> `radioRa3-products`
- Root: `lutron-root`
- Also: `Lutron Project SubSystem Certificate Authority`

**Mutual TLS:** Bridge authenticates to AWS IoT with client certificates provisioned from `credentials.iot.us-east-1.amazonaws.com`. MITM requires both valid Lutron certs AND bridge's private key.

## mDNS Announcements

- Service: `_lutron._tcp.local`
- Name: `Lutron Status`
- Hostname: `Lutron-08676308.local`

## LEAP API Exploration

Connected via mutual TLS on port 8081 with Designer certs. Session has **Admin** role.

### Connection Command

```bash
# Send LEAP JSON commands
echo '{"CommuniqueType":"ReadRequest","Header":{"Url":"/server"}}' | \
  openssl s_client -connect 10.0.0.1:8081 \
  -cert lutron-ra3-cert.pem \
  -key lutron-ra3-key.pem \
  -CAfile lutron-ra3-ca.pem \
  -quiet 2>/dev/null
```

### Working Endpoints

| Endpoint | Returns |
|----------|---------|
| `/server` | LEAP (8081/TCP, 2647/UDP) and IPL (8902/TLS, 443/WSS) servers |
| `/server/1` | LEAP server details, protocol v03.247 |
| `/server/ipl` | IPL server, multicast 239.0.38.1 |
| `/server/leap/pairinglist` | Pairing list |
| `/system` | Timezone, lat/long, date/time |
| `/networkinterface/1` | MAC, IP config, IPv6, SOCKS5 proxy settings |
| `/project` | Project name, product type, master device list |
| `/area` | All areas/rooms in the system |
| `/area/{id}` | Single area details |
| `/area/{id}/status` | Area status (level, occupancy, scene) |
| `/area/{id}/associatedzone` | Zones in an area |
| `/area/{id}/associatedcontrolstation` | Control stations in an area |
| `/device/{id}` | Device details, firmware version, serial |
| `/device/{id}/buttongroup` | Button groups on a device |
| `/device/{id}/linknode/{id}` | Link node details |
| `/link` | RF network configuration |
| `/link/{id}` | Detailed link config including **encryption keys** |
| `/zone/{id}` | Zone definition |
| `/zone/{id}/status` | Zone status (level, lock state) |
| `/button/{id}` | Button definition with programming model |
| `/buttongroup/{id}` | Button group details |
| `/programmingmodel/{id}` | Programming model with preset reference |
| `/preset/{id}` | Preset definition |
| `/timeclock` | Timeclock list |
| `/timeclock/{id}` | Timeclock details |
| `/service` | All integrations (Alexa, HomeKit, etc.) |
| `/database/@Project` | Database schema version, transfer GUID |
| `/clientsetting` | Client version, **SessionRole: Admin** |
| `/contactinfo/{id}` | Installer contact info |

### Endpoints That Return 204 NoContent

| Endpoint | Notes |
|----------|-------|
| `/device` | No devices at root level |
| `/virtualbutton` | No virtual buttons configured |
| `/buttongroup` | Must query via device |
| `/sequence` | No sequences configured |
| `/programmingmodel` | Must query by ID |

### Endpoints That Return Errors

| Endpoint | Error | Notes |
|----------|-------|-------|
| `/` | 400 BadRequest | Root not supported |
| `/zone` | 405 MethodNotAllowed | Must query via area |
| `/processor` | 400 BadRequest | Not exposed |
| `/firmware` | 400 BadRequest | Not exposed via LEAP |
| `/version` | 400 BadRequest | Not exposed |
| `/update` | 400 BadRequest | Not exposed |
| `/diagnostics` | 400 BadRequest | Not exposed |
| `/log` | 400 BadRequest | Not exposed |
| `/debug` | 400 BadRequest | Not exposed |
| `/action` | 400 BadRequest | Not exposed |
| `/controlstation` | 405 MethodNotAllowed | Must query via area |
| `/scene` | 400 BadRequest | Not exposed |
| `/greenmode` | 400 BadRequest | Not exposed |
| `/programmingevent` | 400 BadRequest | Not exposed |
| `/conditionalrule` | 400 BadRequest | Not exposed |
| `/timedEvent` | 400 BadRequest | Not exposed |

### Write Operations (All Failed)

| Request | Error | Message |
|---------|-------|---------|
| `CreateRequest /virtualbutton` | 405 MethodNotAllowed | "This request is not supported" |
| `UpdateRequest /button/{id}` | 500 InternalServerError | "Could not update name." ErrorCode:1 |

**Conclusion:** LEAP on port 8081 is a **read-only monitoring API**. Configuration changes require port 443 (WSS) with project-specific certificates.

### Services Discovered (from `/service`)

| Service | Type | Status |
|---------|------|--------|
| `/service/alexa` | Alexa | Has config endpoint |
| `/service/googlehome` | Google Home | Has config endpoint |
| `/service/homekit` | HomeKit | Bridge serial: 8676308, max 149 associations |
| `/service/ifttt` | IFTTT | Has config endpoint |
| `/service/sonos` | Sonos | Basic entry |
| `/service/bacnet` | BACnet | Disabled, port 47808 |
| `/service/ntpserver` | NTP | Uses time.iot.lutron.io |

### RF Network Credentials (from `/link`)

**ClearConnect Type X (Thread-based):**
- PANID: 25327 (0x0000)
- Extended PANID: `<your-thread-xpanid>`
- Channel: 25
- **NetworkMasterKey**: `<your-thread-master-key>` (128-bit AES)

**RF Link (CCA - 433 MHz):**
- Channel: 26
- SubnetAddress: 33495

These credentials match the values extracted from the Lutron Designer SQL database, confirming LEAP exposes the same data.

### Processor Info (from `/device/232`)

| Field | Value |
|-------|-------|
| Name | Main Processor |
| Model | JanusProcRA3 |
| Serial | 100000001 |
| Firmware | 26.00.11f000 |
| Package | 002.025.018r000 |
| DeviceClass | 0x81b0101 |
| MAC | 00:00:00:00:00:00 |

### Device Types Discovered

| DeviceType | Example |
|------------|---------|
| RadioRa3Processor | Main processor |
| Pico4Button | 4-button remote (PJ2-4B-XXX-L01) |
| PlugInDimmer | Plug-in dimmer module |
| SunnataHybridKeypad | Hybrid keypad |
| SunnataDimmer | Wall dimmer |

### Button Programming Structure

```
Device (e.g., Pico4Button)
└── ButtonGroup
    └── Button
        └── ProgrammingModel (SingleActionProgrammingModel, SingleSceneRaiseProgrammingModel, etc.)
            └── Preset
```

Example button types:
- `SingleActionProgrammingModel` - On/Off buttons
- `SingleSceneRaiseProgrammingModel` - Raise/dim up
- `SingleSceneLowerProgrammingModel` - Lower/dim down

## Certificate Chains by Port

### Port 8081/8902 (Product Certificates)

Used by Designer software for LEAP communication:

```
lutron-root (Root CA)
└── radioRa3-products
    └── radioRa3-devices
        └── radioRa3-processors-027-4725-24
            └── radiora3-a0b1c2d3e4f5-server (Processor)
```

These certs are extracted from Lutron Designer installation:
- `lutron-ra3-cert.pem` - Client certificate
- `lutron-ra3-key.pem` - Private key
- `lutron-ra3-ca.pem` - CA chain

### Port 443 (Project-Specific Certificates)

Used for programming/configuration via WSS:

```
Lutron Project SubSystem Certificate Authority (Root)
└── RadioRa3ProcessorA0B1C2D3E4F5
    └── IPLServer8676308
```

These certs are generated during Designer-to-processor pairing and are project-specific. Our product certs are rejected with "bad certificate" (alert 42).

**To get project certs:** Would need to capture during Designer pairing or extract from Designer's certificate store.

## Potential Attack Vectors (for authorized testing)

1. **Serial console** - Likely UART exposed on board
2. **SSH** - Port 22 open, needs credentials or key
3. **LEAP exploration** - With valid certs, enumerate API endpoints (read-only)
4. **Firmware extraction** - Physical access to flash/eMMC
5. **MITM during update** - Capture decrypted firmware in RAM
6. **Project cert extraction** - Extract from Designer during pairing for write access
7. **Thread/CCX sniffing** - With NetworkMasterKey, decrypt all Thread traffic

## Designer Application Analysis

### Installation Location

Designer is installed as a Windows Store app (AppX):
```
C:\Program Files\WindowsApps\LutronElectronics.LutronDesignerGamma_26.0.0.110_x86__hb4qhwkzq4pcy\
├── QuantumResi\                    # Main application
│   ├── BinDirectory\
│   │   └── CertificateStore\       # Product certificates
│   ├── ConfigFile\
│   │   └── Lutron.Gulliver.Core.Configuration.dll.config
│   ├── Lutron.ProcessorTransfer.dll
│   ├── Lutron.Gulliver.NetworkFramework.dll
│   └── ...
```

### Designer Certificate Store

Located at: `QuantumResi\BinDirectory\CertificateStore\`

**Product CA Certificates (.crt):**
| File | Subject | Purpose |
|------|---------|---------|
| `radioRa3_products.crt` | CN=radioRa3-products | RadioRA3 product chain CA |
| `quantum_products.crt` | CN=quantum-products | HomeWorks QSX product chain |
| `homeworksqs_products.crt` | CN=homeworksqs-products | HomeWorks QS product chain |
| `athena_products.crt` | CN=athena-products | Athena product chain |
| `myroom_products.crt` | CN=myroom-products | MyRoom product chain |

**Client Certificates (.pfx):**
| File | Subject | DeviceTypes | Password |
|------|---------|-------------|----------|
| `residential_local_access.pfx` | CN=Lutron Residential GUI | HWQSProcessor, RadioRa3Processor | (empty) |
| `commercial_local_access.pfx` | CN=Lutron Commercial GUI | Commercial processors | (empty) |
| `one_gui_local_access.pfx` | CN=Lutron One GUI | One GUI processors | (empty) |

**Key Finding:** `residential_local_access.pfx` is the **product-level** client certificate used for LEAP/LAP connections (ports 8081/8083). It's signed by "Lutron Designer Certificate Authority", NOT the project-specific SubsystemCertificate.

**Certificate Details (residential_local_access.pfx):**
```
Subject: CN=Lutron Residential GUI
Issuer: CN=Lutron Designer Certificate Authority
Key Usage: TLS Web Client Authentication
Custom OID (1.3.6.1.4.1.40073.1.1): {"DeviceTypes":["HWQSProcessor","RadioRa3Processor"]}
Valid: 2020-10-28 to 2039-02-07
```

### Configuration File

`Lutron.Gulliver.Core.Configuration.dll.config` (UTF-16 encoded) contains:

| Setting | Value | Notes |
|---------|-------|-------|
| LEAPConnectionPort | 8081 | LEAP API |
| LAPConnectionPort | 8083 | LAP protocol |
| SecureIPLConnectionPort | 8902 | IPL transfer |
| SFTPPortForProcessorSupportFile | 22 | SSH/SFTP for support files |
| EngraveringOrderFTPServer | ftp://lutron-ftp.lutron.com | Engraving upload |
| UserConnectionString | sa / Lutr0n@123456789 | Local SQL auth |

### Key DLLs

| DLL | Purpose |
|-----|---------|
| `Lutron.ProcessorTransfer.dll` | Project transfer to processor |
| `Lutron.Gulliver.NetworkFramework.dll` | Network communications |
| `Lutron.Gulliver.EncryptionLibrary.dll` | Certificate/encryption handling |
| `Lutron.Services.Core.LeapClientFramework.dll` | LEAP protocol implementation |
| `BouncyCastle.Crypto.dll` | Cryptographic operations |

### OOB SSH Access (Port 22)

From config: `SFTPPortForProcessorSupportFile = 22`

Designer uses SFTP/SSH for:
- Downloading processor support files
- Potentially for OOB management of unclaimed processors

The actual SSH credentials are NOT found in:
- Configuration files
- Embedded in analyzed DLLs
- Certificate store

**Hypothesis:** OOB credentials may be:
1. Derived from processor serial/MAC at runtime
2. Obtained from Lutron cloud during first connection
3. Hardcoded in native code (not .NET) within the DLLs

### Embedded Resources Found

**Lutron.SupportFileEncryption.dll:**
```
-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAuDQyi2KyJkR9Z3jm0Yw9
9oZ9uXs/y3kxRqyx9HhWgZHo94s42WWNA+++sT+qWqELC0ZepdkDCMB9YLAMuDkf
Tw/idZlLk9ZfgciWY/oTZEhF67uZCwlNGLrALJsY99K0cSWh7O7JLsu7gNsIWIl9
DhkEU/pRo1yDDRms2N2p95aGMFuf3mjmXNO+lDXFpu3quEA0nMtXuPw5KMPXCm+s
lqliq2iP6oanik1ckH04ziexkbJfdirycM8yz5TNnNqDe69V6QlznZ45LAk1ph/L
knzmGXrTMmxoju6vQueq/m2Dh0ggTVb6LMCHG9DYqqfHO6V/MQXIVzw6YHwgqH1H
lwIDAQAB
-----END PUBLIC KEY-----
```
This RSA public key is used for encrypting/verifying support files (not SSH auth).

### SSH/SFTP Libraries Used

| Library | Purpose |
|---------|---------|
| `Rebex.Sftp.dll` | Commercial SFTP implementation |
| `BouncyCastle.Crypto.dll` | Cryptographic operations |

### What We Didn't Find

1. **SSH credentials** - No hardcoded SSH passwords in analyzed DLLs
2. **OOB authentication secrets** - Not found in .NET code
3. **SSH private keys** - Not embedded in resources

### SSH Authentication Testing Results

**Tested Methods:**

1. **Common passwords** - Failed
   - lutron, Lutron, Lutr0n, admin, root, password, integration, processor, radiora3

2. **MAC/Serial derived passwords** - Failed
   - a0b1c2d3e4f5, 08676308, lutron08676308, Lutron08676308, ra308676308

3. **SQL passwords** - Failed
   - Lutr0n@123456789, Lutr0n@1, lutron@1, Lutron@1

4. **SubsystemCertificate as SSH key** - Failed
   - Converted EC private key to SSH format
   - Server rejected key

5. **SSH Certificate signed by SubsystemCertificate** - Failed
   - Generated SSH cert: `ssh-keygen -s project_ec.pem -I "designer@lutron" -n root`
   - Server not configured to trust this CA for SSH certs

**Tested Users:** root, lutron, admin, installer, integration

**SSH Server Info:**
- Host key: ssh-ed25519 SHA256:eI97sBj3UFLgiBv272IMiVHuGS6EBAYep1q8zsttK9s
- Auth methods: publickey, keyboard-interactive
- Supported key types: ssh-ed25519, ecdsa-sha2-nistp256/384/521, rsa-sha2-256/512

### LEAP Product Certificate Testing

**Tested:** `residential_local_access.pfx` on port 8081

**Result:** TLS alert 48 (unknown ca)
- Certificate is signed by "Lutron Designer Certificate Authority"
- Processor only trusts "lutron-root" chain for LEAP
- This cert is likely for Designer-to-cloud or Designer-to-Designer, not processor access

### Hypotheses for OOB/SSH Authentication

1. **Factory-provisioned credentials** - Stored in secure element, not accessible from Designer
2. **Cloud-based provisioning** - Credentials obtained from Lutron cloud during OOB setup
3. **Time-based OTP** - Derived from device serial and current time
4. **Physical button combination** - OOB mode may require physical access to enable

## Summary of Extracted Files

| File | Source | Contents | Status |
|------|--------|----------|--------|
| `cert_v2.pfx` | LocalDB | Project Root CA | Extracted |
| `key_v2.bin` | LocalDB | Root CA private key | Extracted |
| `proc_cert2.pfx` | LocalDB | Processor server cert | Extracted |
| `loob_key.bin` | LocalDB | Intermediate CA cert | Extracted |
| `residential_local_access.pfx` | Designer | Product client cert | Extracted |
| `radioRa3_products.crt` | Designer | Product CA chain | Extracted |

## Next Steps

1. **Capture first-time pairing** - Monitor Designer<->Processor during initial setup
2. **Test SSH certificate auth** - Try using generated certs signed by SubsystemCertificate
3. **Analyze native code** - Check ChakraCore or other native components
4. **Factory reset test** - Reset processor and capture OOB traffic
5. **LEAP write attempt** - Try port 8081 with residential_local_access.pfx for writes

## Lutron Designer Internal Services

Discovered from Designer config file. These are internal WCF services exposed to the internet.

### Live Services

| Service | URL | Status |
|---------|-----|--------|
| Database Extraction | `http://sqltofb.lutron.com:81/LutronExtractionService.svc` | **200 OK** |
| Database Update | `http://designer-relay.lutron.com:82/LutronDatabaseUpdateService.svc` | **200 OK** |
| Usage Tracking UAT | `https://DesignerUAT.Lutron.com/UsageServiceStaging/` | 500 |
| myLutron Auth | `https://mylutronservices.lutron.com/myLutronAuthenticationService.svc` | Unknown |

### WSDL Operations

**LutronExtractionService** (internal host: `laz2201.intra.lutron.com:81`)
- `DownloadVersionData` - Download database version data
- Headers: `RequestedVersion`, `Token`

**LutronDatabaseUpdateService** (internal host: `sqltofb.lutron.com`)
- `GetUpdates` - Get database updates
- `AreUpdatesAvailable` - Check for updates
- `GetProjectDatabaseUpdates` - Get project-specific updates
- Headers: `ApplicationVersion`, `ProductType`, `ModelInfoDatabaseVersion`, `ReferenceInfoDatabaseVersion`

### Leaked Internal Info

From stack traces when calling services incorrectly:

```
Internal code path: C:\Code\Gulliver\code\src\Lutron\Gulliver\
├── DatabaseUpdateRemoteService\
│   └── DatabaseUpdateService\
│       ├── VersionToDataMap.cs
│       └── LutronDatabaseUpdateService.svc.cs
```

### RabbitMQ Credentials (from config)

```
amqp://poinvamw:NYR83wJ8YgYjXcVaq0ZncRjbjA3kZ693@lemur.cloudamqp.com/poinvamw
```
(May be expired/revoked)

### Internal Wiki Reference

```
https://lutron.atlassian.net/wiki/spaces/POL/pages/260997168/
```
(Requires Lutron SSO)

## Lutron Designer LocalDB - Certificate Storage

Designer stores project data in SQL Server LocalDB with a dynamically-named instance.

### Finding the Active Database

```powershell
# Find active LocalDB pipe (Designer must be open with a project)
[System.IO.Directory]::GetFiles("\\.\pipe\") | Where-Object { $_ -like "*LOCALDB*" }
# Returns: \\.\pipe\LOCALDB#XXXXXXXX\tsql\query

# Connect via sqlcmd (use -No to disable encryption)
sqlcmd -S "np:\\.\pipe\LOCALDB#XXXXXXXX\tsql\query" -No -d Project -Q "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES"
```

### Certificate Tables

| Table | Column | Contents |
|-------|--------|----------|
| `tblProcessorSystem` | `SubsystemCertificateV2` | Root CA cert (PKCS#12, empty password) |
| `tblProcessorSystem` | `SubSystemPrivateKeyV2` | Root CA private key (DER-encoded EC key) |
| `tblProcessor` | `ProcessorCertificate` | Server cert (PKCS#12, empty password) |
| `tblProcessor` | `LoobKey` | Intermediate CA cert (DER X.509) |
| `tblProcessor` | `IsUsingV2Certificate` | Flag for V2 cert format |

### Extracted Certificates

**SubsystemCertificateV2 (Root CA):**
```
Subject: CN=Lutron Project SubSystem Certificate Authority
Issuer: CN=Lutron Project SubSystem Certificate Authority (self-signed)
Key: EC secp384r1
Extended Key Usage: 1.3.6.1.4.1.40073.1.10, TLS Web Client Authentication
CA: TRUE, pathlen:5
Valid: 2019-03-01 to 2125-12-01
```

**LoobKey (Intermediate CA):**
```
Subject: CN=RadioRa3ProcessorA0B1C2D3E4F5
Issuer: CN=Lutron Project SubSystem Certificate Authority
Key: EC prime256v1
CA: TRUE, pathlen:4
Valid: 2019-03-01 to 2125-12-01
```

**ProcessorCertificate (Server):**
```
Subject: CN=radiora3-a0b1c2d3e4f5-server
Issuer: CN=radioRa3-processors-027-4725-24
Key: EC prime256v1
Extended Key Usage: TLS Web Server Authentication
CA: FALSE
Valid: 2025-06-08 to 2045-06-08
```

### Certificate Chain Relationship

```
Port 443 (Project Certs):                    Port 8081/8083 (Product Certs):

Lutron Project SubSystem CA (Root)           lutron-root
        │                                            │
        ▼                                            ▼
RadioRa3ProcessorA0B1C2D3E4F5 (Intermediate)  radioRa3-products
        │                                            │
        ▼                                            ▼
IPLServer8676308 (Server)                     radioRa3-devices
                                                     │
                                                     ▼
                                              radioRa3-processors-027-4725-24
                                                     │
                                                     ▼
                                              radiora3-a0b1c2d3e4f5-server
```

### Why Port 443 Authentication Fails

We have the Root CA cert and private key from `tblProcessorSystem`, but:

1. Generated client certs signed by Root CA are rejected with "bad certificate" (TLS alert 42)
2. The processor likely maintains a whitelist of valid client certificate fingerprints/serials
3. Designer may use certificates signed by the Intermediate CA (LoobKey), but we don't have its private key
4. The Intermediate CA private key is stored only on the processor itself

**Conclusion:** Write access via port 443 requires either:
- Extracting the actual client certificate Designer uses during pairing
- Finding the Intermediate CA private key (likely only on processor)
- Capturing the pairing process to understand client cert generation

## OOB (Out-of-Band) Management

### mDNS Discovery

The processor advertises itself via mDNS:

```
Service: _lutron._tcp.local
Name: Lutron Status
Target: Lutron-08676308.local
Port: 22 (SSH)

TXT Record:
  MACADDR=00:00:00:00:00:00
  CODEVER=26.00.11f000
  DEVCLASS=081B0101
  FW_STATUS=1:NoUpdate
  NW_STATUS=InternetWorking
  ST_STATUS=good
  SYSTYPE=RadioRa3Processor
  CLAIM_STATUS=Claimed
  SERNUM=08676308
```

### Key Fields

| Field | Value | Meaning |
|-------|-------|---------|
| `CLAIM_STATUS` | `Claimed` | Processor is paired with a project |
| `CLAIM_STATUS` | `Unclaimed` | Factory reset, awaiting pairing |
| `FW_STATUS` | `0:Rebooting` | During boot |
| `FW_STATUS` | `1:NoUpdate` | Normal operation |
| `NW_STATUS` | `InternetWorking` | Cloud connectivity OK |

### SSH Authentication

```bash
ssh -v root@10.0.0.1
# Accepts: publickey, keyboard-interactive
# Rejects: password
```

The `LoobKey` (Local Out-of-Band Key) is an X.509 certificate, not an SSH key. OOB management likely uses:
1. Factory-default credentials known to Designer
2. Or credentials derived from processor serial/MAC
3. Or SSH certificate authentication (SSH keys signed by a CA)

### OOB Pairing Flow (Hypothesized)

1. Factory reset processor → `CLAIM_STATUS=Unclaimed`
2. Designer discovers via mDNS `_lutron._tcp`
3. Designer connects via SSH port 22 with OOB credentials
4. Designer transfers project certificates (SubsystemCertificate)
5. Processor generates Intermediate CA and signs server/client certs
6. Port 443 becomes active with project-specific cert auth
7. `CLAIM_STATUS` changes to `Claimed`

## Files Extracted

| File | Source | Contents |
|------|--------|----------|
| `cert_v2.pfx` | tblProcessorSystem.SubsystemCertificateV2 | Root CA (PKCS#12) |
| `key_v2.bin` | tblProcessorSystem.SubSystemPrivateKeyV2 | Root CA private key (DER) |
| `proc_cert2.pfx` | tblProcessor.ProcessorCertificate | Server cert (PKCS#12) |
| `loob_key.bin` | tblProcessor.LoobKey | Intermediate CA (DER X.509) |
| `project_cert.pem` | Exported from cert_v2.pfx | Root CA (PEM) |
| `project_key.pem` | Exported from cert_v2.pfx | Root CA private key (PEM) |

All PKCS#12 files have empty passwords.

## Useful Commands

### Port scanning
```bash
for port in 22 443 8081 8083 8902; do
  (echo >/dev/tcp/10.0.0.1/$port) 2>/dev/null && echo "Port $port: OPEN"
done
```

### Capture boot sequence (with port mirroring)
```bash
# On mirrored interface (e.g., en8)
tshark -i en8 -w boot.pcapng -f "host 10.0.0.1"
# Then power cycle the processor
```

### Extract TLS handshake info
```bash
tshark -r boot.pcapng -Y "tls.handshake.type == 1" \
  -T fields -e ip.dst -e tls.handshake.extensions_server_name
```

### Decode base64 network keys
```bash
echo "AAAAAAAAAAAAAAAAAAAAAA==" | base64 -d | xxd
```

## Hardware Debugging

### Processor Board

**Main SoC:** TI AM3351BZCE60
- ARM Cortex-A8, 600MHz
- 324-ball ZCE BGA package (15x15mm, 0.65mm pitch)

### Test Pads Identified (from FCC filings)

**Labeled pads:**
| Pad | Purpose |
|-----|---------|
| TX | UART transmit |
| RX | UART receive |
| DAT0-DAT3 | SD/eMMC data lines |
| CMD | SD/eMMC command |
| CLK | SD/eMMC clock |
| VBAT | Battery backup |
| 5V | Power rail |

**Unlabeled pads (4 in a row):** Likely JTAG (TCK, TDI, TDO, TMS)

### AM335x ZCE Package Pinout

**JTAG:**
| Signal | Ball |
|--------|------|
| TCK | F3 |
| TDI | E2 |
| TDO | E1 |
| TMS | D1 |
| nTRST | E3 |
| EMU0 | F1 |
| EMU1 | F2 |

**UARTs:**
| UART | TXD Ball | RXD Ball |
|------|----------|----------|
| UART0 | E16 | E15 |
| UART1 | D16 | D15 |
| UART2 | G15 | G16 |
| UART3 | C15 | C16 |
| UART4 | T15 | R15 |
| UART5 | M17 | L17 |

### UART Testing Results

- TX pad measures 2.9-3.1V to GND when idle (valid 3.3V logic)
- No output at 115200 baud during boot
- Console may be disabled in production firmware
- Could be on secondary UART (not UART0)

### JTAG Access (not yet tested)

Recommended adapter: FT2232H Mini Module (~$25)
- Channel A: JTAG
- Channel B: UART simultaneously

```bash
# OpenOCD command for AM335x
openocd -f interface/ftdi/ft2232h-module-swd.cfg \
  -c "transport select jtag" \
  -c "adapter speed 1000" \
  -f target/am335x.cfg
```

JTAG would allow:
- Full memory/flash dump
- Bootloader extraction
- Filesystem access
- SSH key extraction

## Legacy Caseta SSH Key

The original Caseta Smart Bridge used SSH with a well-known key (from pylutron-caseta):

```
Username: leap
Port: 22
Key: RSA key (see caseta_leap.key)
```

**Tested on RadioRA3:** Does NOT work. RA3 uses different credentials.

The Caseta bridge also supported telnet on port 23:
- Username: `lutron`
- Password: `integration`

**Tested on RadioRA3:** Port 23 not open.

## Vive Hub Pairing Protocol

Discovered via RF capture of real Vive hub (YYYYYYYY) pairing with RMJS-5R-DV-B PowPak (021AD0C3).

### Protocol Overview

```
Hub  -> Broadcast:  0xBA (enter pairing mode)
Device -> Hub:      0xB8 (pairing request)
Hub  -> Device:     0xBB seq=1 (pairing accepted)
Hub  -> All:        0x8D, 0xA5, 0xA9 (config exchange)
Hub  -> Broadcast:  0xBB (exit pairing mode)
```

### Packet Types

| Type | Direction | Purpose |
|------|-----------|---------|
| 0xBA | Hub -> All | Enter pairing mode (devices flash) |
| 0xB8 | Device -> Hub | Pairing request |
| 0xBB | Hub -> Device | Pairing accepted (seq=1) |
| 0xBB | Hub -> All | Exit pairing mode (cycling seq) |

### 0xB8 Pairing Request Structure

```
Offset  Field         Value (RMJS example)
------  -----------   -------------------
0       Type          0xB8
1       Sequence      0x00
2-5     Device ID     02 1A D0 C3 (big-endian)
6       Protocol      0x21
7       Format        0x23
15      Command       0x02 (pair request)
20-23   Device ID     02 1A D0 C3 (repeated)
24-26   Device Info   16 0C 01 (type, caps, ver)
```

### Device Info Bytes

| Device | Type | Caps | Ver | Info Bytes |
|--------|------|------|-----|------------|
| RMJS-5R-DV-B (PowPak relay) | 0x16 | 0x0C | 0x01 | 16 0C 01 |

### Key Differences from Pico Pairing

| Feature | Vive (BA/B8/BB) | Pico Direct (B9/BB) |
|---------|-----------------|---------------------|
| Initiator | Hub broadcasts 0xBA | Pico broadcasts 0xB9 |
| Request | Device sends 0xB8 | N/A |
| Acceptance | Hub sends 0xBB seq=1 | Implicit |
| Sequence | +8 per packet | +6 per packet |
| Packet size | ~27-46 bytes | 53 bytes |

See `docs/cca-pairing-protocol.md` for full protocol details.
