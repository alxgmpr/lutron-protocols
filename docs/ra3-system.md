# RA3 System Reference

RadioRA 3 processor internals, LEAP API, certificates, and database editing.

## 1. System Architecture

| Property | Value |
|----------|-------|
| Processor codename | **Janus** (JanusProcRA3) |
| SoC | TI AM3351 (ARM Cortex-A8, 600MHz) |
| OS | Linux 5.10 |
| Database schema | v168, **268 tables** per project transfer |
| Firmware | APT-style repo (kernel, rootfs, spl, uboot .deb packages) |
| MAC | 00:00:00:00:00:00 (example) |

Internal codenames: Janus (RA3 processor), Pegasus (link/network), Hyperion (daylighting/facade), Kaleido (Ketra color display), McCasey (dimming curve algorithm).

## 2. Network Ports

| Port | Protocol | Purpose | Cert Required |
|------|----------|---------|---------------|
| 8081 | LEAP/JSON | Primary API (read-only) | Product certs (from Designer) |
| 8083 | TCP/TLS | LAP protocol | Unknown |
| 8902 | IPL/Binary | Designer transfer | Product certs (binary protocol) |
| **443** | **WSS** | **Programming/write access** | **Project-specific certs** |
| 22 | SSH | Support files, diagnostics | Unknown (publickey, keyboard-interactive) |
| 5353 | mDNS | Processor discovery | N/A |
| 2056-3055 | UDP multicast | Inter-processor events (239.0.38.x) | N/A |
| 8883 | MQTT/TLS | AWS IoT cloud | Device certs |

**Access summary**: Port 8081 is read-only with product certs. Write access requires port 443 with project-specific certificates generated during Designer pairing.

## 3. Certificate Hierarchy

Two independent chains serve different ports:

```
Port 8081/8083 (Product Certs):          Port 443 (Project Certs):

lutron-root                              Lutron Project SubSystem CA
    └─ radioRa3-products                     └─ RadioRa3Processor<MAC>
        └─ radioRa3-devices                      └─ IPLServer<serial>
            └─ radioRa3-processors-XXX
                └─ radiora3-<mac>-server
```

Product certs are extracted from Lutron Designer's `CertificateStore/` directory. Project certs are generated during Designer-to-processor pairing and stored in the project database.

**Key files** (in project root):
- `lutron-ra3-cert.pem` — Client certificate (product chain)
- `lutron-ra3-key.pem` — Client private key
- `lutron-ra3-ca.pem` — CA chain

## 4. LEAP API

Read-only JSON API on port 8081 via mutual TLS.

### Connection

```bash
# Using pylutron-caseta
leap --cacert lutron-ra3-ca.pem --cert lutron-ra3-cert.pem --key lutron-ra3-key.pem \
  "10.0.0.1/area"

# Using leap-dump (walks full hierarchy)
bun run tools/leap-dump.ts
```

### Key Endpoints

| Endpoint | Returns |
|----------|---------|
| `/area` | All areas/rooms |
| `/area/{id}/associatedzone` | Zones (dimmers/switches) in an area |
| `/area/{id}/associatedcontrolstation` | Control stations (keypads, picos) |
| `/device/{id}` | Device details (serial, model, firmware) |
| `/device/{id}/buttongroup` | Button groups on a device |
| `/button/{id}` | Button definition with programming model |
| `/programmingmodel/{id}` | Programming model with preset references |
| `/preset/{id}` | Preset definition |
| `/zone/{id}/status` | Current zone level and lock state |
| `/link/{id}` | RF network config (Thread keys, CCA subnet) |

Write attempts return 500 or 405. Write access requires port 443 (WSS) with project-specific certificates.

### Control Station Hierarchy

```
Area → ControlStation → AssociatedGangedDevices[] → Device → ButtonGroup → Button → ProgrammingModel → Preset(s)
```

### Programming Model Types

| Type | Presets |
|------|---------|
| `AdvancedToggleProgrammingModel` | PrimaryPreset (off/recall) + SecondaryPreset (on/activate) |
| `SingleActionProgrammingModel` | Single Preset |
| `SingleSceneRaiseProgrammingModel` | Single Preset |
| `SingleSceneLowerProgrammingModel` | Single Preset |

## 5. RF Network Credentials

Available via LEAP `/link/{id}`:

**CCA (433 MHz):**
- Channel (e.g., 26)
- SubnetAddress (e.g., 33495 = 0x82D7)

**CCX (Thread):**
- Channel (e.g., 25)
- PAN ID (e.g., 25327 = 0x0000)
- Extended PAN ID
- **NetworkMasterKey** (128-bit AES, decrypts all Thread traffic)

These match values extracted from the Designer SQL database.

## 6. Designer & LocalDB

Lutron Designer stores project data in SQL Server LocalDB with a dynamic instance name.

### Finding the Active Database

```powershell
# Find pipe (Designer must be open with a project)
[System.IO.Directory]::GetFiles("\\.\pipe\") | Where-Object { $_ -like "*LOCALDB*" }

# Connect
sqlcmd -S "np:\\.\pipe\LOCALDB#XXXXXXXX\tsql\query" -No -d Project -Q "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES"
```

### 4 Databases

| Database | Contents |
|----------|----------|
| **Project** | Active project data (268 tables) |
| **SqlModelInfo.mdf** | Device model definitions, dimming curves |
| **SqlReferenceInfo.mdf** | Reference/lookup data |
| **SqlApplicationData.mdf** | Per-version app settings |

### Certificate Tables

| Table | Column | Contents |
|-------|--------|----------|
| `tblProcessorSystem` | `SubsystemCertificateV2` | Root CA cert (PKCS#12, empty password) |
| `tblProcessorSystem` | `SubSystemPrivateKeyV2` | Root CA private key (DER EC) |
| `tblProcessor` | `ProcessorCertificate` | Server cert (PKCS#12, empty password) |
| `tblProcessor` | `LoobKey` | Intermediate CA cert (DER X.509) |
| `tblPegasusLink` | `NetworkMasterKey` | Thread network key |

### Key Project Tables

| Table | Purpose |
|-------|---------|
| `tblProject` | Project metadata, ProductType (3=RA3, 4=HW) |
| `tblZone` | Lighting zones |
| `tblArea` | Rooms and areas |
| `tblDevice` | Physical devices |
| `tblScene` | Lighting scenes |
| `tblProgrammingModel` | Button programming (AllowDoubleTap, HoldPresetId) |
| `tblPreset` / `tblPresetAssignment` | Preset actions and zone linkages |
| `tblIntegrationID` | Integration IDs |

## 7. Database Editing

### File Structure

```
.ra3 or .hw (ZIP archive)
  └── <uuid>.lut (MTF backup — Microsoft Tape Format)
      └── Project.mdf + Project_log.ldf (SQL Server database)
```

Database version: **957** (SQL Server 2022 RTM). Most SQL Server installations will upgrade past 957, making the file unreadable by Designer.

### Method 1: Live Editing (Recommended)

Edit while Designer has the project open:
1. Open project in Designer
2. Find pipe: `Get-ChildItem "\\.\pipe\" | Where-Object {$_.Name -like "*LOCALDB*"}`
3. Connect via SSMS or sqlcmd with `-No` flag
4. Make changes, close Designer normally to save

### Method 2: Docker (SQL Server 2022 RTM)

```bash
docker run -e "ACCEPT_EULA=Y" -e "MSSQL_SA_PASSWORD=LutronPass123" \
  -p 1433:1433 --name sql2022rtm \
  -v "$(pwd)":/data \
  -d mcr.microsoft.com/mssql/server:2022-RTM-ubuntu-20.04
```

```sql
-- Attach (use FORCE_REBUILD_LOG since .ldf won't match)
CREATE DATABASE [Project] ON (FILENAME = '/data/Project.mdf') FOR ATTACH_FORCE_REBUILD_LOG;

-- Edit, then detach
EXEC sp_detach_db 'Project', 'true';
```

Extraction/repacking uses `lutron-tool.py extract` and `lutron-tool.py pack`.

### Method 3: Binary Editing

For same-length UTF-16LE string replacements only. Cannot change string length (breaks row storage).

## 8. RA3 vs HomeWorks

Both use **identical table structures**. Differences are feature flags:

| Field | RA3 | HomeWorks |
|-------|-----|-----------|
| ProductType (tblProject) | 3 | 4 |
| AllowDoubleTap | 0 | 1 |
| HoldPresetId | NULL | Set |

Enable HW features in RA3:
```sql
UPDATE tblProgrammingModel SET AllowDoubleTap = 1, DoubleTapPresetID = <preset_id> WHERE ProgrammingModelID = <id>;
```

## 9. Cloud & Firmware

### Cloud Endpoints

| Endpoint | Purpose |
|----------|---------|
| `device-login.lutron.com` | Device authentication |
| `a32jcyk7azp7b5-ats.iot.us-east-1.amazonaws.com:8883` | MQTT broker |
| `firmwareupdates.lutron.com` | Firmware API |
| `provision.iot.lutron.io` | Device provisioning |

### Firmware Packages

**RA3 (Phoenix)**: APT-style — kernel, rootfs, spl, uboot as .deb packages.

**Vive**: ZIP bundle — `firmware.tar.enc` (AES-128-CBC, key RSA-encrypted), signed manifest.

### mDNS Discovery

Service `_lutron._tcp.local` with TXT record containing MAC, firmware version, device class, claim status, and serial number. `CLAIM_STATUS=Unclaimed` indicates factory-reset processor awaiting pairing.
