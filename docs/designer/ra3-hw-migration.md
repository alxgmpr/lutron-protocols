# RA3 to HomeWorks QSX Migration

*Running a HomeWorks QSX project on RadioRA 3 hardware to unlock HW-exclusive programming features.*

RadioRA 3 and HomeWorks QSX use identical hardware (same processors, same CCA/CCX
radios) and identical database schemas. A RA3 processor can run a HomeWorks project,
unlocking HW-exclusive features like DoubleTap, HoldPreset, richer LED logic, and
full scene/shade programming.

## Which do I use?

Two distinct approaches are documented here:

- **Full migration** — inject the RA3 processor's identity (serial/MAC/certs, link
  credentials) into a `.hw` project so a RA3 processor can run a true HomeWorks
  project. Use this when you want the processor to actually become a HomeWorks
  system with full HW programming features. See [Full migration](#full-migration).
- **ID-only switch workflow** — flip only `ModelInfoID` references
  (RRST/RRD/RR ↔ HRST/HQRD/HQR) inside an RA3 project shell, leaving all
  project/system metadata untouched. Use this for reversible, low-risk testing of
  HomeWorks-style programming behavior paths without changing the project type.
  See [ID-only switch workflow](#id-only-switch-workflow).

---

# Full migration

Inject the RA3 processor's identity into a live `.hw` project database, save, and
transfer.

## Architecture

### Databases on Designer VM

Designer uses SQL Server LocalDB with three attached databases:

| Database | Contents |
|----------|----------|
| **SQLMODELINFO** | Device catalog: models, DeviceClass mappings, LinkType mappings, FamilyCategoryInfo |
| **SQLREFERENCEINFO** | ProductMasterList, preferences |
| **Project_*** | Live project data: devices, zones, scenes, processor config |

### Infrastructure

- `../../tools/designer/sql-http-api.ps1` — HTTP SQL API on the VM (port 9999), auto-discovers LocalDB
- `../../tools/designer/mcp-designer-db.ts` — MCP server wrapping the HTTP API with SSH fallback
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
patcher — see `~/redacted-security-repo/docs-security/designer-universal-unlock.md`.

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
| `~/redacted-security-repo/exploits/designer-jailbreak/dll-patcher/` | DLL patcher — universal cross-platform unlock |
| `../../tools/designer/sql-http-api.ps1` | HTTP SQL API for Designer VM |
| `../../tools/designer/mcp-designer-db.ts` | MCP server for Designer DB queries |
| `../../tools/designer/project-convert.ts` | Project file converter (RA3↔HW) |

---

# ID-only switch workflow

Switch `ModelInfoID` references only, without changing project/system metadata, to
unlock HomeWorks-style programming behavior paths while staying in an RA3 project
shell.

## Objective

Switch `ModelInfoID` references only, without changing project/system metadata, to
unlock HomeWorks-style programming behavior paths while staying in an RA3 project
shell.

## Validation note

- Cycle dim on `Office > Doorway > Position 1 > Button 2` (`PM 1221`) was validated
  before the latest scaffold script pass. See [Cycle dimming](cycle-dim.md).

## Decision

- Primary workflow: IDs-only conversion.
- Do not change:
  - `tblProject.ProductType`
  - `tblVersion.ProductType`
  - `tblVersionHistory.ProductType`

Use `../../tools/designer/sql/project-modelid-convert-ra3-hw.sql` for this path.

## Mapping rules

Implemented in `../../tools/designer/sql/project-modelid-convert-ra3-hw.sql`:

- `RRST-` <-> `HRST-`
- `RRD-` <-> `HQRD-`
- `RR-` <-> `HQR-`
- fallback for naming gaps after lookup:
  - `RRD-` -> `HQR-` (e.g. `RRD-3LD -> HQR-3LD`)
  - `HQR-` -> `RRD-`
- manual exception:
  - `RR-PROC3-KIT <-> HQP7-RF-2`

## IDs-only runbook

### 1) Open RA3 project in Designer
- Keep the target RA3 project open.

### 2) Dry-run conversion
Run `../../tools/designer/sql/project-modelid-convert-ra3-hw.sql` with:
- `@Direction = 'RA3_TO_HW'`
- `@DryRun = 1`
- `@FailOnUnmapped = 1`

Proceed only if no unmapped rows remain.

### 3) Apply conversion
- Set `@DryRun = 0`.
- Execute the same script.

Expected result:
- only `ModelInfoID` columns change across referenced tables.
- no system/product-type marker changes.

### 4) Save, close, reopen
- Save project.
- Close and reopen project so Designer UI reloads from DB.

### 5) Transfer and test
- Transfer to processor.
- Validate target behavior.

### 6) Revert IDs if needed
- Re-run same script with `@Direction = 'HW_TO_RA3'`.
- dry-run first, then apply.

## What not to run in this workflow
- Do not use `../../tools/designer/sql/project-mode-convert-ra3-hw.sql` if the goal is IDs-only testing.
- Do not use `../../tools/designer/sql/project-mode-flip-metadata-only.sql` for this path.

## Incident Log (2026-02-19)

Failure observed:
- Designer error: `ControlStationChildDeviceMissing`
- UI message identified `Kitchen\Backsplash`, then auto-deleted that control station child.

Root cause found in DB audit:
- Downconvert was incomplete: two devices remained on HW model `HQR-3LD` after HW->RA3 pass.
- Residual rows:
  - `ControlStationDeviceID=3272` (`Office > Standing Desk > Position 1`)
  - `ControlStationDeviceID=3289` (`Office > Desk > Position 1`)
- Cleanup pass (model-ID-only `HW_TO_RA3`) updated these 2 rows and removed all remaining `HRST/HQR/HQP7-RF-2` model refs.

Related prior issue:
- L01 Pico mismatches were caused by stale bindings (`AssociatedTemplateId`, `ButtonGroupInfoID`, SSRLPM `LedLogic`), not model family limits.

## Verified ModelInfoID Mapping (26.0.1.100)

| RA3 Model | RA3 ID | HomeWorks Model | HW ID | Notes |
|---|---:|---|---:|---|
| RR-PROC3-KIT | 5093 | HQP7-RF-2 | 5046 | manual override |
| RRST-HN3RL-XX | 5197 | HRST-HN3RL-XX | 5194 | prefix rule |
| RRST-HN4B-XX | 5198 | HRST-HN4B-XX | 5195 | prefix rule |
| RRST-PRO-N-XX | 5115 | HRST-PRO-N-XX | 5056 | prefix rule |
| RRST-W4B-XX | 5121 | HRST-W4B-XX | 5062 | prefix rule |
| RRST-W3RL-XX | 5122 | HRST-W3RL-XX | 5063 | prefix rule |
| RRST-ANF-XX | 5249 | HRST-ANF-XX | 5248 | prefix rule |
| RRST-8ANS-XX | 5117 | HRST-8ANS-XX | 5058 | prefix rule |
| RR-3PD-1 | 1166 | HQR-3PD-1 | 1300 | prefix rule |
| RRD-3LD | 461 | HQR-3LD | 730 | fallback (`HQR -> RRD`) |

## Required Post-Apply Invariants

Run these after every conversion before opening/transferring in Designer:

1. `ProductType` consistency (RA3 mode expected = `3`) across:
- `tblProject`
- `tblVersion`
- `tblVersionHistory`

2. No HW model names remain in any `ModelInfoID` table:
```sql
-- returns zero rows when clean for RA3 mode
-- scans all dbo tables that contain ModelInfoID
```

3. No orphan control stations:
```sql
SELECT cs.ControlStationID, a.Name AS AreaName, cs.Name AS ControlStationName
FROM dbo.tblControlStation cs
LEFT JOIN dbo.tblArea a ON a.AreaID = cs.ParentId
LEFT JOIN dbo.tblControlStationDevice csd ON csd.ParentControlStationID = cs.ControlStationID
GROUP BY cs.ControlStationID, a.Name, cs.Name
HAVING COUNT(csd.ControlStationDeviceID) = 0;
```

4. Programming integrity clean:
```sql
EXEC dbo.sel_ProgrammingModelIssues;
EXEC dbo.sel_CheckCorruptBtnProgramming @ProgrammingParentID = NULL;
```

## Separate-HW-Project Merge Feasibility

Building a separate HW project and copying only network data from RA3 is high-risk and not directly reversible.

Why:
- Runtime identity depends on more than thread creds (`NetworkMasterKey`):
  - processor cert/key chain (`tblProcessorSystem`, `tblProcessor`)
  - RF/link topology and node addressing tables
  - object IDs and cross-table parent/child graph consistency
- Copying only RF credentials into a different object graph will not guarantee a valid transfer/runtime state.

Safer strategy:
- Keep one canonical project DB and do in-place ID switching (RA3<->HW) with strict pre/post invariants.
- If using a separate HW sandbox, merge only programming rows back with deterministic ID translation, not network/identity rows.
</content>
