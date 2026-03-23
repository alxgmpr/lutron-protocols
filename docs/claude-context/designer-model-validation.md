# Designer CCA Device Model Validation — RESOLVED 2026-03-04

Full docs: `docs/ra3-to-hw-migration.md`

## Four Validation Gates (all bypassed)

1. **LinkType** (SQLMODELINFO): patch adds LinkTypes 32/34/36 to RA3 link nodes
2. **ProductMasterList** (SQLREFERENCEINFO): patch adds RA3 ModelInfoIDs to HW category 18
3. **TOOLBOXPLATFORMTYPES** (SQLMODELINFO): OR in HW bits (4128) to RA3 FamilyCategoryInfo
4. **DeviceClass** (code-level): no DB fix — bypass via workflow (activate as RA3 model)

## Working Workflow
1. Apply gates 1-3 SQL patches, restart Designer
2. Add RA3 model (e.g. RR-3PD-1) to HW project toolbox
3. Activate via CCA pairing — DeviceClass matches
4. For full HW programming: add HQR equivalent, inject serial via SQL, delete RA3 device

## Key Findings
- **ModelInfoID is immutable** — Designer caches in memory, overwrites DB on save
- **SerialNumber/SerialNumberState persist** — Designer doesn't cache these
- **AddressOnLink persists** — critical that replacement device uses same address
- DeviceClass chain: TBLCONTROLSTATIONDEVICEINFOMODELINFOMAP → TBLCONTROLSTATIONDEVICEINFO → LSTQSDEVICECLASSTYPE
- TOOLBOXPLATFORMTYPES: RadioRA=64, HW=4128, both=4192
- Three DBs: SQLMODELINFO, SQLREFERENCEINFO, Project_*

## SQL Patches
- `tools/sql/patch-ra3-to-hw-linktypes.sql` — Gate 1
- `tools/sql/patch-ra3-to-hw-productlist.sql` — Gate 2
- Gate 3 inline: `UPDATE TBLFAMILYCATEGORYINFO SET TOOLBOXPLATFORMTYPES = TOOLBOXPLATFORMTYPES | 4128 WHERE ...`
