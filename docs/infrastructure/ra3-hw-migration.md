# RA3 to HomeWorks QSX Migration

RadioRA 3 and HomeWorks QSX use identical hardware (same processors, same CCA/CCX
radios) and identical database schemas. A RA3 processor can run a HomeWorks project,
unlocking HW-exclusive features like DoubleTap, HoldPreset, richer LED logic, and
full scene/shade programming.

## Architecture

### Databases on Designer VM

Designer uses SQL Server LocalDB with three attached databases:

| Database | Contents |
|----------|----------|
| **SQLMODELINFO** | Device catalog: models, DeviceClass mappings, LinkType mappings, FamilyCategoryInfo |
| **SQLREFERENCEINFO** | ProductMasterList, preferences |
| **Project_*** | Live project data: devices, zones, scenes, processor config |

### Infrastructure

- `tools/sql-http-api.ps1` — HTTP SQL API on the VM (port 9999), auto-discovers LocalDB
- `tools/mcp-designer-db.ts` — MCP server wrapping the HTTP API with SSH fallback
- HTTP endpoints: `POST /query` (project DB), `POST /query-modelinfo` (SQLMODELINFO), `GET /databases`

## Part 1: Processor Identity Injection

Open a `.hw` project in Designer. Inject the RA3 processor's identity into the live
project database, save, and transfer.

### 1a. Processor Serial/MAC/IP/Certs

```sql
UPDATE dbo.tblProcessor SET
  SerialNumber = ra3.SerialNumber,
  MacAddress = ra3.MacAddress,
  IPAddress = ra3.IPAddress,
  ProcessorCertificate = ra3.ProcessorCertificate,
  LoobKey = ra3.LoobKey
FROM dbo.tblProcessor hw
CROSS JOIN InspectOrig.dbo.tblProcessor ra3;

UPDATE dbo.tblProcessorSystem SET
  SubsystemCertificateV2 = ra3.SubsystemCertificateV2,
  SubSystemPrivateKeyV2 = ra3.SubSystemPrivateKeyV2,
  UniqueLocalIPv6NetworkAddress = ra3.UniqueLocalIPv6NetworkAddress
FROM dbo.tblProcessorSystem hw
CROSS JOIN InspectOrig.dbo.tblProcessorSystem ra3;

UPDATE dbo.tblProcessor SET SerialNumberState = 2;  -- marks as "activated"
```

### 1b. CCA + CCX Link Credentials

```sql
UPDATE dbo.tblLink SET SubnetAddress = 33495  -- 0x82D7
WHERE LinkInfoID = 11;  -- CCA link

UPDATE dbo.tblPegasusLink SET
  Channel = ra3.Channel, PanID = ra3.PanID,
  ExtendedPanId = ra3.ExtendedPanId,
  NetworkMasterKey = ra3.NetworkMasterKey
FROM dbo.tblPegasusLink hw
CROSS JOIN InspectOrig.dbo.tblPegasusLink ra3;
```

### 1c. Save Trick (required after all live DB changes)

1. Make a trivial change in Designer UI (rename a room, toggle a setting)
2. File > Save
3. Close > Reopen
4. Transfer to processor

The trivial UI change forces Designer to mark the project dirty. Fields that Designer
doesn't cache in memory (serial numbers, activation states, link credentials) survive
the save cycle and persist to the `.hw` file.

## Part 2: CCA Device Pairing (RA3 devices in HW projects)

Toolbox visibility, ProductMasterList membership, LinkType compat, and the
family/model TOOLBOXPLATFORMTYPES bits are all handled universally by the DLL
patcher — see [designer-universal-unlock.md](designer-universal-unlock.md).

The only remaining gate is DeviceClass comparison at pairing time, which is
code-level and has no DB fix.

### DeviceClass Comparison Gate

**Method**: `CheckIfCorrectDeviceTypeHeard()` in `ActivateDevicesDetailsBase`

Compares the processor-reported DeviceClass against the selected device's
DeviceClassType (looked up from SQLMODELINFO via
`TBLCONTROLSTATIONDEVICEINFOMODELINFOMAP`). RA3 and HW equivalents have different
DeviceClass IDs — e.g.:

| Model | DeviceClass | Description |
|-------|-------------|-------------|
| RR-3PD-1 | 68419841 | RadioRA 2 Plug-In Cord Dimmer |
| HQR-3PD-1 | 69468417 | HWQS PID Triac |

The `CompatibleDeviceClassTypesAttribute` only maps WLCU ↔ OccupancySensor, so
swapping model classes without code patching requires the workflow below.

### Workflow: Activate as RA3, Use as HW

ModelInfoID is immutable once a device is created in Designer (Designer caches it in
memory and overwrites DB changes on save), so the workflow is:

1. **Add the RA3 model** (e.g. RR-3PD-1) from the toolbox — it's visible in HW
   projects thanks to the universal-unlock IL patches
2. **Activate via CCA pairing** — DeviceClass matches because you're using the RA3 model
3. **Transfer to processor** — works, device responds to commands
4. **For full HW programming features**: add a NEW HW model (e.g. HQR-3PD-1) to the
   same location, then inject the serial number and address via SQL:

```sql
-- Find the new HW device and the old RA3 device
SELECT d.ControlStationDeviceID, d.ModelInfoID, d.SerialNumber,
       ln.LinkNodeID, ln.AddressOnLink
FROM tblControlStationDevice d
JOIN tblLinkNode ln ON ln.ParentDeviceID = d.ControlStationDeviceID
WHERE d.ModelInfoID IN (1166, 1300);  -- RR-3PD, HQR-3PD

-- Copy serial + activation to the HW device
UPDATE tblControlStationDevice
SET SerialNumber = '<serial from RA3 device>', SerialNumberState = 2
WHERE ControlStationDeviceID = <new HW device ID>;

-- CRITICAL: Ensure AddressOnLink matches the RA3 device's address
-- (Designer usually assigns the same address when replacing in the same slot)

-- Delete the old RA3 device from Designer UI, save, transfer
```

The serial number and activation state persist through save because Designer doesn't
cache these fields in memory.

### What Designer Caches vs What Persists

| Field | Cached in memory? | Persists via SQL injection? |
|-------|:-:|:-:|
| SerialNumber | No | Yes |
| SerialNumberState | No | Yes |
| ModelInfoID (device) | **Yes** | **No** — overwritten on save |
| ModelInfoID (link node) | **Yes** | **No** — overwritten on save |
| AddressOnLink | No | Yes |

### Validation Chain (decompiled from Designer 26.x)

```
LEAP DeviceHeard → DeviceHeardClass.HexadecimalEncoding (hex string)
  → DeviceClassUtility.GetMaskedDeviceClassType() — mask & 0xFFFF0000 | 0x0101
  → IsDeviceClassSupported() — masked class in ProductMasterList models?
    → false: "device type not supported" (string 13957)
  → CheckIfCorrectDeviceTypeHeard() — exact equality with selected device
    → false: CompatibleDeviceClassTypesAttribute (only WLCU↔OccSensor)
    → still false: "wrong device type" (string 12199)
```

### Model Equivalence Table

| RA3 Model | ModelInfoID | HW Equivalent | ModelInfoID | DeviceClass (RA3) | DeviceClass (HW) |
|-----------|:-:|-------------|:-:|:-:|:-:|
| RR-3PD-1 | 1166 | HQR-3PD-1 | 1300 | 68419841 | 69468417 |
| RRD-3LD | 461 | HQR-3LD | 730 | 67895553 | 69337345 |

## Files

| File | Purpose |
|------|---------|
| `tools/dll-patcher/` | DLL patcher — universal cross-platform unlock |
| `tools/sql-http-api.ps1` | HTTP SQL API for Designer VM |
| `tools/mcp-designer-db.ts` | MCP server for Designer DB queries |
| `tools/project-convert.ts` | Project file converter (RA3↔HW) |
