---
name: designer-unlock
description: Unlock all devices across all platforms in Designer toolbox
metadata:
  author: alex
  version: "1.0"
user_invocable: true
---

# Designer Unlock — Universal Toolbox Unlock

Makes all devices available across all product platforms in the Designer toolbox. Adds HW platform bits to all families/overrides, adds cross-platform models to the HW ProductMasterList, and adds HW LinkTypes to all link nodes.

**CRITICAL**: Both SQLMODELINFO.MDF and SQLREFERENCEINFO.MDF reset on every Designer restart. Run this AFTER Designer starts. Works with or without a project open — queries use fully-qualified `[dbname].dbo.table` syntax so any DB context works.

## Step 1: Discover Database Names

Call `mcp__designer-db__list_databases` to get current DB names. Find the two databases whose names end with `SQLMODELINFO.MDF` and `SQLREFERENCEINFO.MDF`. Use these as `{MODEL_DB}` and `{REF_DB}` in the queries below.

## Step 2: Run All 5 Gates

Run all 5 queries in parallel using `mcp__designer-db__query`. All are additive and idempotent.

### Gate 1: LinkTypes (SQLMODELINFO)

Add HW LinkTypes 32/34/36 to every link node that lacks them.

```sql
INSERT INTO [{MODEL_DB}].dbo.TBLLINKNODEINFOLINKTYPEMAP (LINKNODEINFOID, LINKTYPEID, SORTORDER)
SELECT DISTINCT lnm.LINKNODEINFOID, lt.LINKTYPEID, 1
FROM [{MODEL_DB}].dbo.TBLLINKNODEINFOMODELINFOMAP lnm
CROSS JOIN (SELECT 32 as LINKTYPEID UNION SELECT 34 UNION SELECT 36) lt
WHERE NOT EXISTS (
  SELECT 1 FROM [{MODEL_DB}].dbo.TBLLINKNODEINFOLINKTYPEMAP x
  WHERE x.LINKNODEINFOID = lnm.LINKNODEINFOID AND x.LINKTYPEID = lt.LINKTYPEID
);
```

### Gate 2a: ProductMasterList — safe bulk add (SQLREFERENCEINFO)

Add models to the HW ProductMasterList (cat 18) that exist in at least one OTHER
ProductMasterList but not in HW. Only adds models whose `TOOLBOXNAMESTRINGID` is
already used by an existing cat 18 model — this guarantees the string exists in
visual 9 (the HW resource context). Without this filter, models like
`MW-FPSIR-WH-CPN3100` (string 18453, visual 10 only) crash
`DevicePickerViewModel.MatchFilter` with `InvalidStringIdException`.

```sql
INSERT INTO [{REF_DB}].dbo.TBLPRODINFOMDLINFOLISTMDLINFOID
  (PRODUCTINFOMODELINFOLISTCATID, MODELINFOID, SORTORDER, ISOBSOLETE, OVERRIDEFILTERINFOID)
SELECT 18, src.MODELINFOID,
  ROW_NUMBER() OVER (ORDER BY src.MODELINFOID) +
  (SELECT ISNULL(MAX(SORTORDER), 0) FROM [{REF_DB}].dbo.TBLPRODINFOMDLINFOLISTMDLINFOID WHERE PRODUCTINFOMODELINFOLISTCATID = 18),
  0, NULL
FROM (
  SELECT DISTINCT p.MODELINFOID
  FROM [{REF_DB}].dbo.TBLPRODINFOMDLINFOLISTMDLINFOID p
  JOIN [{MODEL_DB}].dbo.TBLMODELINFO m ON m.MODELINFOID = p.MODELINFOID
  WHERE p.PRODUCTINFOMODELINFOLISTCATID <> 18
  AND m.TOOLBOXNAMESTRINGID IN (
    SELECT DISTINCT m2.TOOLBOXNAMESTRINGID
    FROM [{MODEL_DB}].dbo.TBLMODELINFO m2
    WHERE m2.MODELINFOID IN (
      SELECT MODELINFOID FROM [{REF_DB}].dbo.TBLPRODINFOMDLINFOLISTMDLINFOID WHERE PRODUCTINFOMODELINFOLISTCATID = 18
    )
  )
) src
WHERE src.MODELINFOID NOT IN (
  SELECT p2.MODELINFOID FROM [{REF_DB}].dbo.TBLPRODINFOMDLINFOLISTMDLINFOID p2
  WHERE p2.PRODUCTINFOMODELINFOLISTCATID = 18
);
```

### Gate 2b: ProductMasterList — force-add RA3 CCA devices (SQLREFERENCEINFO)

Gate 2a misses RA3 models whose `TOOLBOXNAMESTRINGID` values aren't used by any
existing cat 18 model (e.g., RRD-3LD string 33917, RRD-6D string 11820). These
are safe to add because they ARE in other ProductMasterList categories (7, 8, 19)
and their strings exist in those contexts. Designer resolves them without crash.

This explicit list covers the core RA3 CCA dimmers, switches, and fan controls
that are most commonly needed in cross-platform HW projects.

```sql
INSERT INTO [{REF_DB}].dbo.TBLPRODINFOMDLINFOLISTMDLINFOID
  (PRODUCTINFOMODELINFOLISTCATID, MODELINFOID, SORTORDER, ISOBSOLETE, OVERRIDEFILTERINFOID)
SELECT 18, src.MODELINFOID,
  ROW_NUMBER() OVER (ORDER BY src.MODELINFOID) +
  (SELECT ISNULL(MAX(SORTORDER), 0) FROM [{REF_DB}].dbo.TBLPRODINFOMDLINFOLISTMDLINFOID WHERE PRODUCTINFOMODELINFOLISTCATID = 18),
  0, NULL
FROM (VALUES
  (460),   -- RRD-6D
  (461),   -- RRD-3LD
  (464),   -- RRD-6ND
  (465),   -- RRD-6NA
  (466),   -- RRD-10D
  (467),   -- RRD-10ND
  (468),   -- RRD-8ANS
  (469),   -- RRD-2ANF
  (740),   -- RRD-8S-DV
  (1166),  -- RR-3PD-1
  (1229),  -- RRD-F6AN-DV
  (1255),  -- RRD-6NE
  (3467),  -- RRD-6CL
  (4864)   -- RRD-PRO
) AS src(MODELINFOID)
WHERE src.MODELINFOID NOT IN (
  SELECT MODELINFOID FROM [{REF_DB}].dbo.TBLPRODINFOMDLINFOLISTMDLINFOID
  WHERE PRODUCTINFOMODELINFOLISTCATID = 18
);
```

### Gate 3a: Family-Level ToolboxPlatformTypes (SQLMODELINFO)

OR in HW bits (4128 = HomeworksQS + myRoomLegacy) on ALL families.

```sql
UPDATE [{MODEL_DB}].dbo.TBLFAMILYCATEGORYINFO
SET TOOLBOXPLATFORMTYPES = TOOLBOXPLATFORMTYPES | 4128
WHERE TOOLBOXPLATFORMTYPES & 4128 <> 4128;
```

### Gate 3b: Model-Level ToolboxPlatformTypes Override (SQLMODELINFO)

OR in HW bits on ALL model-level overrides. This table is checked FIRST by
`ProductInfoHelper.GetLocationBasedToolboxPlatformTypesForModel()`, before
falling back to family. Without this, models with overrides are invisible
even when the family value is correct.

```sql
UPDATE [{MODEL_DB}].dbo.TBLMODELINFOTOOLBOXPLATFORMTYPEMAP
SET TOOLBOXPLATFORMTYPEID = TOOLBOXPLATFORMTYPEID | 4128
WHERE TOOLBOXPLATFORMTYPEID & 4128 <> 4128;
```

## After Applying

1. Click **"Leave remote services disabled"**
2. All cross-platform devices should now appear in the HW toolbox
3. Report row counts for each gate

## Notes

- All queries are **additive** (`|`, `INSERT ... NOT IN`) — never delete or overwrite
- All queries are **idempotent** — safe to run multiple times
- `4128 = 0x1020 = HomeworksQS (0x20) + myRoomLegacy (0x1000)`
- Gate 2a filters by known-good `TOOLBOXNAMESTRINGID` values to avoid `InvalidStringIdException` crash in visual 9
- Gate 2b force-adds RA3 CCA models that Gate 2a misses (their string IDs aren't in cat 18 but are safe — they exist in other category contexts)
- Gate 4 (DeviceClass comparison at pairing) has no DB fix — pair using the RA3 model, then swap via serial injection if needed

### Model Prefix Reference

| RA3 | HW Equivalent | Type |
|-----|---------------|------|
| RRD | HQR/HQRD | Dimmers/switches (CCA) |
| RRT | HQRT | seeTouch keypads (CCA) |
| RRST | HRST | Sunnata (Thread) |
| RRDE | — | Extension dimmers (CCA) |
| RRL | — | Newer models |
