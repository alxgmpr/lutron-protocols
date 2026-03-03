# Project Convert: Designer Save Failure Investigation

**Date**: 2026-02-19
**Status**: ROOT CAUSE FOUND — index corruption from page-level patching + orphaned high-ID rows

## Background

`tools/project-convert.ts` is an offline converter for Lutron Designer project files (.ra3 <-> .hw). It eliminates the dependency on the Windows VM + Designer pipeline by:

1. Extracting the embedded SQL Server MDF from the project file (ZIP > MTF .lut > MDF)
2. Running model-ID + ProductType conversion inside Docker SQL Server 2022
3. Repacking the modified MDF back into a project file

### The Two-Pass Architecture

Docker SQL Server's attach/detach cycle fundamentally corrupts the MDF for Designer — it modifies system pages (boot, file header, catalog data) with Docker-specific artifacts. To work around this:

- **Pass 1** (baseline): Attach + detach with NO conversion — captures Docker's inherent modifications
- **Pass 2** (conversion): Attach + convert + detach — captures Docker's modifications + our changes

Pages that differ between pass 1 and pass 2 = ONLY our conversion changes. We transplant those diffs into the original pristine MDF, bypassing all Docker artifacts.

### Page Patching Strategy

For each page that differs between baseline and converted:

| Original Page Type | Action |
|---|---|
| type=0 (unused) → type=1/2 (data/index) | Copy FULL page from converted (new allocation from INSERTs) |
| type=1 (data), type=2 (index) | Patch row data only (bytes 96+), preserve page header |
| type=8 (GAM), 9 (SGAM), 10 (IAM), 11 (PFS) | Patch row data only (allocation tracking for new pages) |
| type=13 (boot), 15 (file header), 16 (diff map) | SKIP entirely |

After patching, we recalculate the SQL Server page checksum using the reverse-engineered algorithm (XOR all 32-bit words, left-rotate-1 accumulator between 512-byte sectors).

### SQL Server Page Checksum

Reverse-engineered and verified against 3718 real pages from a Designer-produced MDF:

```
For each 8192-byte page:
  1. Zero the checksum field (bytes 60-63)
  2. XOR all 32-bit LE words across 16 sectors (512 bytes each)
  3. Between each sector, rotate the accumulator left by 1 bit
  4. Final accumulator value = page checksum
```

## Current State

### What Works

- **File opens in Designer** — The converted .hw file loads in Designer with correct room/device data
- **Model mapping correct** — All 10 model types (RR→HQR, RRST→HRST, etc.) mapped correctly
- **ProductType consistent** — `tblProject`, `tblVersion`, `tblVersionHistory` all show ProductType=4 (HW)
- **DBCC CHECKDB passes clean** — No integrity errors detected by SQL Server
- **Database is writable** — UPDATE statements succeed from external sqlcmd
- **Local dimmer programming chains created** — 11 HQR-3LD/3PD devices get full ButtonGroup→KeypadButton→ProgrammingModel→Preset→PresetAssignment→CommandParameter chains
- **Pico devices correct** — Correct programming models and button groups

### What Fails

- **Save fails**: "Project could not be saved. The database service may need to be restarted."
- Error persists across VM reboots
- Error persists even after clearing stale RECOVERY_PENDING databases
- The save button in Designer triggers the error immediately — no visible delay suggesting a timeout

### What Was Tested

| Test | Result |
|---|---|
| DBCC CHECKDB on live database | PASS — no errors |
| Check `sys.suspect_pages` | Empty — no suspect pages |
| Check `sys.dm_tran_active_transactions` | No blocking transactions |
| UPDATE from external sqlcmd | Success — database is writable |
| VM reboot (clear stale state) | Save still fails |
| Check `sys.databases` state | ONLINE, correct compatibility (160) |

## Root Cause (FOUND 2026-02-19)

Two interacting bugs caused the save failure:

### Bug 1: Non-Clustered Index Corruption from Page-Level Patching

`DBCC CHECKTABLE('tblProgrammingModel')` revealed **10+ consistency errors** across non-clustered indexes 2, 5, and 6 (`NonClusteredIndex_PresetID`, `NonClusteredIndex_PressPresetID`, `NonClusteredIndex_ReleasePresetID`). Specifically:

- **Data rows without matching index entries**: Normal ProgrammingModels (IDs 47, 443, 1424, 2980, 2983, 3186, etc.) exist in data pages but their non-clustered index entries point to old/stale values
- **Index entries for non-existent data rows**: Ghost entries for ProgrammingModelIDs 2147483646-2147483656 that don't exist

**Cause**: The two-pass page-level diff patches data pages (type=1) independently from index pages (type=2). When our conversion SQL modifies rows, SQL Server updates BOTH the clustered index (data pages) AND non-clustered index pages. But in the two-pass diff, some non-clustered index pages may differ between passes for reasons OTHER than our conversion (non-deterministic Docker behavior, or the index pages simply weren't captured in the diff because they looked the same in both passes). This leaves the patched MDF with data pages that don't match their index pages.

**Fix applied**: Rebuild ALL non-clustered indexes in BOTH Docker passes before detaching. This ensures:
1. Both passes have identical index page layouts (baseline effect)
2. The converted pass has indexes consistent with its data pages
3. The diff captures index page changes alongside data page changes

### Bug 2: ID Allocation Overflow from Orphaned High-ID Rows

The source .ra3 file contained orphaned rows from previous manual SQL runs:
- 4 ProgrammingModels (SAPM) with IDs ~2,147,483,621-2,147,483,645
- 6 Presets with IDs ~2,147,483,620-2,147,483,646
- 12 PresetAssignments with IDs ~2,147,483,615-2,147,483,644

These orphans (parents don't exist) had IDs near INT_MAX (2,147,483,647) while `tblNextObjectID` was 3719. Our `buildLocalDimmerProgrammingSql()` used `MAX(PresetID)` etc. as the base for new IDs, which picked up ~2.1 billion, causing new IDs to overflow and/or allocate absurd values.

**Fix applied**:
1. ID allocation now uses `tblNextObjectID` instead of `MAX(column)`, and updates the counter after inserting
2. A cleanup step at the start of conversion deletes orphaned rows with IDs > 1,000,000 (when NextObjectID < 1,000,000)

### How the Bugs Interact

The high-ID orphan rows (Bug 2) caused our INSERT operations to create rows with IDs near INT_MAX. These rows were placed on data pages that our page patching (Bug 1) transplanted into the original MDF. But the corresponding non-clustered index entries were either not patched or patched inconsistently, causing the index corruption that prevented Designer from saving.

## Hypotheses (Historical — see Root Cause above)

### H1: Boot Page (type=13) Contains Save-Critical Metadata (HIGH PRIORITY)

**Observation**: Page 9 (boot page) has ~39 data byte diffs between baseline and converted passes that we currently SKIP. The boot page contains database metadata including the database GUID, creation timestamp, and checkpoint LSN.

**Theory**: Designer may validate boot page fields (e.g. `dbi_crdate` creation timestamp, `dbi_dbid` database ID, or checkpoint LSN) that must match what it expects from the original file. Our approach preserves the original boot page, but our patched data pages have row content from Docker pass 2, creating a potential inconsistency.

**Test**:
1. Hex-dump the boot page (page 9) from original, baseline, and converted MDF
2. Identify which fields differ and whether any are save-critical
3. Try selectively patching specific boot page fields into the original

### H2: Page LSN Inconsistency (HIGH PRIORITY)

**Observation**: Each SQL Server page has a Log Sequence Number (LSN) at bytes 34-43 in the page header. When we patch row data but preserve original headers, the patched pages have original LSNs but modified content. SQL Server uses LSNs for crash recovery.

**Theory**: When Designer/LocalDB detaches the database after save, it may detect that some pages have row data that doesn't match their LSN (the data was written by our tool, not by a SQL Server log record). This could cause a recovery check to fail silently, making the save appear to succeed internally but producing an error for Designer.

**Test**:
1. Compare LSNs between original and converted pages for each patched page
2. Try copying page headers from converted MDF (not just row data)
3. Try setting `PAGE_VERIFY NONE` in Docker before detach to see if it changes behavior

### H3: PFS/GAM/SGAM Allocation Bitmap Inconsistency (MEDIUM)

**Observation**: We patch allocation tracking pages (PFS, GAM, SGAM) to account for newly allocated pages from INSERTs. However, we only patch row data (bytes 96+) — the page header (including LSN) comes from the original MDF where those pages weren't allocated.

**Theory**: The PFS bitmap for page 2741 says "allocated" (from our patch), but the PFS page header LSN is from before page 2741 was allocated. LocalDB may detect this as a corruption during checkpoint/save.

**Test**: For allocation pages, try copying the FULL page from converted (not just row data), like we do for newly allocated data pages.

### H4: Transaction Log State Mismatch (MEDIUM)

**Observation**: The original MDF was produced by Designer's LocalDB which uses SIMPLE recovery model. Docker's `ATTACH_FORCE_REBUILD_LOG` creates a new log. When we bypass Docker's system page changes, the result MDF has the original log state but modified data.

**Theory**: The MDF's internal "last checkpoint LSN" (in the boot page, which we preserve from original) doesn't account for our data changes. When LocalDB opens the file, it may attempt recovery that fails because the log doesn't contain records for our modifications.

**Test**: This is related to H1/H2. If we can force a clean checkpoint in Docker that writes to the correct boot page fields, the log state would be consistent.

### H5: Designer Application-Level Validation (MEDIUM)

**Observation**: Designer is a .NET application that uses LocalDB. It may perform its own integrity checks beyond what SQL Server validates.

**Theory**: Designer may have a versioning or checksum system at the application level — perhaps a hash stored in `tblProject.NeedsSave`, `tblVersion`, or another metadata table that it validates before allowing save.

**Test**:
1. Capture Designer's SQL during a save attempt using SQL Server Extended Events or Profiler
2. Look for specific queries that check metadata/version fields
3. Compare those fields between a working project and our converted project

### H6: File Header Page (type=15) Contains Size/State Info (LOW)

**Observation**: Page 0 (file header) is a system page we skip. It contains the MDF file size, database state flags, and other file-level metadata.

**Theory**: If our patching changes the database size (new page allocations) but we preserve the original file header page (which has the old size), there could be an inconsistency.

**Test**: Compare file header page between original and converted. Check if the size field at offset 254 needs updating.

### H7: RECOVERY_PENDING Database Interfering (LOW — partially tested)

**Observation**: A stale database `Project_9472_19_02_2026 01_44_16_366` was stuck in RECOVERY_PENDING state. It survived VM reboot.

**Theory**: The RECOVERY_PENDING database may interfere with LocalDB's ability to perform checkpoint operations on other databases.

**Test**: Force-drop the RECOVERY_PENDING database:
```sql
ALTER DATABASE [Project_9472...] SET OFFLINE WITH ROLLBACK IMMEDIATE;
DROP DATABASE [Project_9472...];
```
Then retry save. (VM reboot was tested but didn't clear the RECOVERY_PENDING DB.)

## Proposed Next Steps (Priority Order)

1. **Capture Designer's save SQL** — Set up Extended Events or Profiler trace on LocalDB to see exactly what Designer does during save. This is the most direct path to understanding the failure.

2. **Boot page analysis (H1)** — Hex-dump and compare boot pages across original/baseline/converted. Identify which fields change and whether any are recovery-critical.

3. **Try full-page copy for allocation pages (H3)** — Instead of patching only row data on PFS/GAM/SGAM pages, copy full pages from converted. This is a simple code change.

4. **Try patching page headers too (H2)** — Instead of preserving original headers, copy headers from converted MDF for patched pages. This breaks the "preserve original metadata" guarantee but may be required for consistency.

5. **Drop RECOVERY_PENDING database (H7)** — Quick test to eliminate as a variable.

6. **Control experiment** — Open the original `experiment.ra3` in Designer, save it, verify save works. Then immediately open our `experiment.hw` — this confirms the issue is with our file, not Designer state.

## Technical Details

### File Format Stack

```
.ra3/.hw (ZIP, MS-DOS attributes)
  └── <uuid>.lut (Microsoft Tape Format)
      ├── MTF header (16 KB, preserved as template)
      ├── MDF data (SQL Server 2022, ~3744 pages = ~30 MB)
      │   ├── Page 0: File header (type=15)
      │   ├── Page 1: PFS (type=11)
      │   ├── Pages 2-5: GAM/SGAM/etc
      │   ├── Page 6: DCM (type=16, diff map)
      │   ├── Page 9: Boot page (type=13)
      │   ├── Pages 10+: Data/index pages
      │   └── Page 2741: New allocation from INSERTs
      └── MTF footer (SFMB + ESET + TSMP blocks, 4K-aligned)
```

### Conversion Stats (Last Run)

- 43 total pages patched
- 21 existing data/index pages with row data changes
- 1 newly allocated page (2741, full copy)
- 1 PFS page patched (allocation tracking)
- Pages skipped: page 0 (file header), page 6 (diff map), page 9 (boot)
- 11 local dimmer programming chains added
- All page checksums verified correct after patching

### Model Mapping

| RA3 Model | RA3 ID | HW Model | HW ID |
|---|---:|---|---:|
| RR-PROC3-KIT | 5093 | HQP7-RF-2 | 5046 |
| RRST-HN3RL-XX | 5197 | HRST-HN3RL-XX | 5194 |
| RRST-HN4B-XX | 5198 | HRST-HN4B-XX | 5195 |
| RRST-PRO-N-XX | 5115 | HRST-PRO-N-XX | 5056 |
| RRST-W4B-XX | 5121 | HRST-W4B-XX | 5062 |
| RRST-W3RL-XX | 5122 | HRST-W3RL-XX | 5063 |
| RRST-ANF-XX | 5249 | HRST-ANF-XX | 5248 |
| RRST-8ANS-XX | 5117 | HRST-8ANS-XX | 5058 |
| RR-3PD-1 | 1166 | HQR-3PD-1 | 1300 |
| RRD-3LD | 461 | HQR-3LD | 730 |
