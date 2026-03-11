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
| **SQLREFERENCEINFO** | ProductMasterList (controls toolbox + `IsDeviceClassSupported`), preferences |
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

Designer has four validation gates that prevent RA3 CCA devices from pairing in HW
projects. All four must be bypassed.

### Gate 1: LinkType (SQLMODELINFO)

**Table**: `TBLLINKNODEINFOLINKTYPEMAP`

RA3 devices only have LinkTypes 9 (RadioRA 2) and 11 (HW Quantum). HW projects require
LinkType 36 (HWQS GCU RF). Cross-compatible devices like Picos already have all five
link types — that's why they work cross-platform.

**Patch**: `tools/sql/patch-ra3-to-hw-linktypes.sql` — adds LinkTypes 32, 34, 36 to
all RA3-only link nodes. Run against SQLMODELINFO.

### Gate 2: ProductMasterList (SQLREFERENCEINFO)

**Table**: `TBLPRODINFOMDLINFOLISTMDLINFOID`

The HW ProductMasterList (ProductInfoID=4, ListID=5, CategoryID=18) controls which
ModelInfoIDs are valid for HW projects. This feeds:
1. The device toolbox (what devices can be added)
2. `IsDeviceClassSupported()` — builds supported DeviceClass set
3. Without it: "device type not supported" error

**Patch**: `tools/sql/patch-ra3-to-hw-productlist.sql` — adds ~50 RA3 models to the
HW ProductMasterList category 18. Run against SQLREFERENCEINFO (requires SQLMODELINFO
accessible for cross-DB join).

### Gate 3a: Family-Level TOOLBOXPLATFORMTYPES (SQLMODELINFO)

**Table**: `TBLFAMILYCATEGORYINFO`

Each model family has a `TOOLBOXPLATFORMTYPES` bitmask controlling which platforms can
use it. RA3 models have bits for RadioRA (64) but not HW (4128).

**Patch**: `| 4128` on all RR% families. ~34 rows on fresh MDF.

Without this: "your account is not able to open this project" when the project contains
an RA3 model whose family lacks HW platform bits.

### Gate 3b: Model-Level TOOLBOXPLATFORMTYPES Override (SQLMODELINFO)

**Table**: `TBLMODELINFOTOOLBOXPLATFORMTYPEMAP`

Per-model overrides that take precedence over family-level values. `ProductInfoHelper.
GetLocationBasedToolboxPlatformTypesForModel()` checks this table FIRST, then falls back
to the family value. 10 RR% models (RR-T*RL timeclocks, RRT-G* seeTouch keypads) have
override value 96 which lacks the myRoomLegacy (0x1000) bit, blocking them even when the
family-level value is correct.

**Patch**: `| 4128` on all RR% model overrides. ~10 rows on fresh MDF.

**This gate was the missing piece** — previous attempts only patched the family table
(Gate 3a) which had no effect on models with overrides in this table.

### Gate 4: DeviceClass Comparison (code-level, bypass by workflow)

**Method**: `CheckIfCorrectDeviceTypeHeard()` in `ActivateDevicesDetailsBase.cs`

Compares the processor-reported DeviceClass against the selected device's DeviceClassType
(looked up from SQLMODELINFO via `TBLCONTROLSTATIONDEVICEINFOMODELINFOMAP`). RA3 and HW
equivalents have different DeviceClass IDs — e.g.:

| Model | DeviceClass | Description |
|-------|-------------|-------------|
| RR-3PD-1 | 68419841 | RadioRA 2 Plug-In Cord Dimmer |
| HQR-3PD-1 | 69468417 | HWQS PID Triac |

**No database fix exists** for this gate. The `CompatibleDeviceClassTypesAttribute` only
maps WLCU ↔ OccupancySensor. A binary patch of the DLL would be needed to add
cross-platform DeviceClass compatibility.

**Workaround**: Use the two-step workflow below.

### Recommended Workflow: Activate as RA3, Use as HW

Since ModelInfoID is immutable once a device is created in Designer (Designer caches it
in memory and overwrites any DB changes on save), the correct workflow is:

1. **Apply Gates 1-3 patches** (LinkType, ProductMasterList, TOOLBOXPLATFORMTYPES)
2. **Restart Designer** (reference data is cached at app startup)
3. **Add the RA3 model** (e.g., RR-3PD-1) from the toolbox — it's now visible in HW projects
4. **Activate via CCA pairing** — DeviceClass matches because you're using the RA3 model
5. **Transfer to processor** — works, device responds to commands
6. **For full HW programming features**: add a NEW HW model (e.g., HQR-3PD-1) to the
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

## Persistence

- **Both SQLMODELINFO.MDF and SQLREFERENCEINFO.MDF are reset on every Designer restart**
  — MDF files are re-extracted from the MSIX package at startup
- All gates (1, 2, 3a, 3b) must be re-applied AFTER Designer starts, BEFORE opening project
- Run patches when the user is at the "remote services" prompt
- Project DB changes (serial injection) persist in the `.hw` file after save
- The `/designer-unlock` skill applies all gates in one operation

## Files

| File | Purpose |
|------|---------|
| `tools/sql/patch-ra3-to-hw-linktypes.sql` | Gate 1: Add HW LinkTypes to RA3 models |
| `tools/sql/patch-ra3-to-hw-productlist.sql` | Gate 2: Add RA3 models to HW ProductMasterList |
| `tools/sql-http-api.ps1` | HTTP SQL API for Designer VM |
| `tools/mcp-designer-db.ts` | MCP server for Designer DB queries |
| `tools/project-convert.ts` | Project file converter (RA3↔HW) |
