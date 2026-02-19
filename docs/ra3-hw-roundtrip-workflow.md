# RA3 <-> HomeWorks ID-Switch Workflow

## Objective
Switch `ModelInfoID` references only, without changing project/system metadata, to unlock HomeWorks-style programming behavior paths while staying in an RA3 project shell.

## Validation note
- Cycle dim on `Office > Doorway > Position 1 > Button 2` (`PM 1221`) was validated before the latest scaffold script pass.

## Decision
- Primary workflow: IDs-only conversion.
- Do not change:
  - `tblProject.ProductType`
  - `tblVersion.ProductType`
  - `tblVersionHistory.ProductType`

Use `~/lutron-tools/tools/sql/project-modelid-convert-ra3-hw.sql` for this path.

## Mapping rules
Implemented in `~/lutron-tools/tools/sql/project-modelid-convert-ra3-hw.sql`:

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
Run `~/lutron-tools/tools/sql/project-modelid-convert-ra3-hw.sql` with:
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
- Do not use `~/lutron-tools/tools/sql/project-mode-convert-ra3-hw.sql` if the goal is IDs-only testing.
- Do not use `~/lutron-tools/tools/sql/project-mode-flip-metadata-only.sql` for this path.

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
