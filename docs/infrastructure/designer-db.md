# Designer LocalDB Enumeration (Top-Down)

## Scope

Enumerated the active Lutron Designer LocalDB instance on:

- Host: `<vm-ip>`
- Login: `Alex`
- SQL endpoint: `np:\\.\pipe\LOCALDB#D8AB4BE4\tsql\query`
- Database: `Project`

## Inventory

From current `Project` instance:

- Base tables (`INFORMATION_SCHEMA.TABLES`): 325
- Views (`INFORMATION_SCHEMA.VIEWS`): 29
- Column entries (`INFORMATION_SCHEMA.COLUMNS`): 4049
- `sys.objects` summary:
  - `USER_TABLE`: 323
  - `VIEW`: 27
  - `SQL_STORED_PROCEDURE`: 2013
  - plus constraints/defaults/internal/system objects

Preset-related object counts:

- `tblPreset`: 113
- `tblPresetAssignment`: 653
- `AllPresetsAndSceneDefinition`: 768
- `AllPresetAssignmentsWithAssignmentCommandParameter`: 650

## Top Tables by Rows

Top row counts in `Project`:

- `tblAssignmentCommandParameter`: 2156
- `tblObjectToProcessorMap`: 1825
- `tblPresetAssignment`: 653
- `tblPreset`: 113
- `tblProgrammingModel`: 95
- `tblKeypadButton`: 85
- `tblScene`: 75
- `tblLinkNode`: 44
- `tblZone`: 33

## Preset/Scene ID Findings (from capture ID set)

Using the 50 capture IDs that were not present in `tblPreset.PresetID`:

- IDs tested: `36..40`, `223..227`, `479..483`, `700..704`, `823..827`, `1036..1040`, `1531..1535`, `1651..1655`, `2284..2288`, `2296..2300`

These IDs map consistently to:

- `tblScene.SceneID` (all 50)
- `tblPresetAssignment.ParentID` (all 50)
- `tblAssignmentCommandParameter.ParentId` (all 50)
- `tblIntegrationID.DomainControlBaseObjectID` (all 50)
- `tblObjectToProcessorMap.DomainObjectID` (all 50)

Example range (`479..483`) in DB:

- `tblScene`:
  - `479 Off Scene`, `480 Scene 001`, `481 Scene 002`, `482 Scene 003`, `483 Scene 004`
- `tblPresetAssignment`:
  - multiple rows where `ParentID` is one of those scene IDs
- `tblAssignmentCommandParameter`:
  - rows keyed by `ParentId` in that same range

This is direct DB evidence that the non-`tblPreset` capture IDs are scene/assignment parent IDs.

Validation scan on known capture IDs (`543`, `589`, `3523`, `2147483644`) returns direct `tblPreset.PresetID` hits (plus related parent/object references), confirming the scan path is functioning.

Additional extracted mapping (`capture_scene_assignment_map.psv`) shows the same pattern across all tested ranges:

- IDs are grouped in 5-scene blocks:
  - `Off Scene` (number `0`)
  - `Scene 001` (number `1`)
  - `Scene 002` (number `2`)
  - `Scene 003` (number `3`)
  - `Scene 004` (number `4`)
- Each scene ID fans out to multiple `tblPresetAssignment` rows.
- `tblAssignmentCommandParameter` rows consistently include:
  - `ParameterType=1, ParameterValue=8`
  - `ParameterType=2, ParameterValue=0`

## Artifacts

Raw enumeration outputs were saved to:

- `/tmp/lutron-sniff/live/db-enum/databases.txt`
- `/tmp/lutron-sniff/live/db-enum/tables.txt`
- `/tmp/lutron-sniff/live/db-enum/views.txt`
- `/tmp/lutron-sniff/live/db-enum/columns.txt`
- `/tmp/lutron-sniff/live/db-enum/table_row_counts.txt`
- `/tmp/lutron-sniff/live/db-enum/object_type_counts.txt`
- `/tmp/lutron-sniff/live/db-enum/preset_tables.txt`
- `/tmp/lutron-sniff/live/db-enum/preset_columns.txt`
- `/tmp/lutron-sniff/live/db-enum/preset_counts.txt`
- `/tmp/lutron-sniff/live/db-enum/capture_only_id_hits.psv`
- `/tmp/lutron-sniff/live/db-enum/capture_scene_assignment_map.psv`
- `/tmp/lutron-sniff/live/db-enum/known_id_hits.psv`

## Designer File Format: .lut = SQL Server Backup (.bak)

**Discovered**: 2026-02-19 via ILSpy decompilation of Designer DLLs

### The Breakthrough

**The .lut file inside the ZIP is NOT an MDF — it's a SQL Server BACKUP (.bak) file.**

Designer uses `BACKUP DATABASE` / `RESTORE DATABASE` (via SMO) for all file I/O,
not `ATTACH` / `DETACH`. The "MTF header" we were parsing is just the native SQL
Server backup format header (which happens to use Microsoft Tape Format internally).

### Evidence

Decompiled from `Lutron.Gulliver.Infrastructure.DatabaseFramework.SQLServer.SQLServerProjectFileManager`:

#### Save (ExportProject)
```csharp
public override bool ExportProject(string projectFileName)
{
    Singleton<ProjectStatusFlags>.Instance.SetRecoveryNotNeeded();
    CreateBackupOfProjectDatabase(projectFileName);
    return true;
}

public override void CreateBackupOfProjectDatabase(string backupPath)
{
    BackUpDatabase(ProjectDatabaseName);   // SMO SqlBackup()
    CompressProjectBackupIntoFile(backupPath);  // Just copies .bak → .lut path
}

private void CompressProjectBackupIntoFile(string compressedFilePath)
{
    FileManager.Copy(BackUpFilePath, compressedFilePath, overwrite: true);
    // That's it! .lut = .bak, no transformation
}
```

#### Open (ImportProject)
```csharp
protected override bool ImportProjectInternal(string projectFileName)
{
    if (/* is lutx/zip */) ImportLutFileFromLutxFile(projectFileName);
    else DecompressBackupAndRestoreProjectFile(projectFileName);
}

private void DecompressBackupAndRestoreProjectFile(string projectFileName)
{
    DecompressProjectFileIntoBackup(projectFileName, hasHeader: false);  // Copy .lut → .bak
    RestoreProjectDatabase();  // SMO SqlRestore() from .bak
}

private void DecompressProjectFileIntoBackup(string projectFilePath, bool hasHeader)
{
    FileManager.Copy(projectFilePath, BackUpFilePath, overwrite: true);
    // That's it! .lut → .bak, no transformation
}
```

#### Verify
```csharp
public override bool Verify(string projectFileName)
{
    // Just checks ZIP integrity, NOT MDF or backup contents
    return zipProvider.IsZipValid(projectFileName);
}
```

#### Restore uses SqlVerify before restoring
```csharp
// In DatabaseOperationsManager.SQLServerAdministrator.RestoreDatabase():
if (restore.SqlVerify(srv, out errMsg))
{
    restore.SqlRestore(srv);
    return true;
}
```

### Why the Old MDF Approach Failed

The converter extracted the MDF from the .bak (by stripping the MTF header/footer),
modified it in Docker using ATTACH_FORCE_REBUILD_LOG, then stuffed it back into the
MTF wrapper. Problems:

1. **ATTACH_FORCE_REBUILD_LOG modifies system pages** — creates Docker-specific artifacts
   that Designer's LocalDB doesn't expect
2. **Page-level patching broke non-clustered indexes** — patching data pages independently
   from index pages left them inconsistent
3. **The resulting file wasn't a valid .bak** — it was a Frankenstein MTF wrapper around
   a Docker-modified MDF, not a proper SQL Server backup

### The Fix

Use RESTORE/BACKUP instead of ATTACH/DETACH:

1. Copy .lut to Docker as .bak
2. `RESTORE DATABASE [Project] FROM DISK = '/data/Project.bak'`
3. Run conversion SQL
4. `BACKUP DATABASE [Project] TO DISK = '/data/Converted.bak'`
5. Use Converted.bak directly as the .lut in the output ZIP

### File Format Stack (Corrected)

```
.ra3/.hw (ZIP, MS-DOS attributes, version=20)
  └── <uuid>.lut = SQL Server backup file (.bak)
      ├── MTF header (TAPE signature at offset 0, "Microsoft SQL Server" at 0x60)
      ├── SQL data (pages from BACKUP DATABASE)
      └── MTF footer (SFMB, ESET, TSMP blocks, 4K-aligned)
```

The "MTF header" and "footer" are NOT a custom wrapper — they ARE the standard
SQL Server backup format. SQL Server natively uses MTF for its .bak files.

### Save Error Root Cause

`HandleProjectOperationExceptions` catches `SqlException` during `BackUpDatabase()`:
```csharp
if (ex is SqlException || DBExceptionChecker.IsFailedOperationException(ex))
    MessageDialogService.ShowError(dbCouldNotBeSavedMessage);
    // "Project could not be saved. The database service may need to be restarted."
```

The ATTACH_FORCE_REBUILD_LOG'd database had internal inconsistencies that caused
`BACKUP DATABASE` to fail with a SqlException. DBCC CHECKDB passed but the backup
engine has additional checks.

### Key DLL Map

| DLL | Purpose | Key Classes |
|-----|---------|-------------|
| `DatabaseOperationsManager.dll` | SMO wrappers | `SQLServerAdministrator` (Backup/Restore/Detach) |
| `Lutron.Gulliver.Infrastructure.dll` | File I/O | `SQLServerProjectFileManager` (save/open flow) |
| `Lutron.Gulliver.QuantumResi.dll` | UI/orchestration | `ProjectSaveServiceBase` (error handling) |
| `Lutron.Gulliver.Infrastructure.DatabaseFramework.dll` | DB schema | Conversion scripts, ProductType SQL |

### Decompilation Setup

```bash
# ILSpy CLI on macOS with .NET 10 + roll-forward
export DOTNET_ROOT=/opt/homebrew/Cellar/dotnet/10.0.103/libexec
export DOTNET_ROLL_FORWARD=LatestMajor
DESIGNER_DIR="~/Downloads/Lutron Designer 26.0.1.100/QuantumResi"
ilspycmd -t <FullTypeName> "$DESIGNER_DIR/<dll>" -r "$DESIGNER_DIR"
```

## HW Project Injection into RA3 Processor (ACHIEVED 2026-03-03)

Successfully transferred a HomeWorks (HW) project to an RA3 processor by injecting
RA3 device addressing data into a fresh HW project file opened in Designer.

### Why This Works
- RA3 and HW use identical hardware (Janus AM3351 processor, same CCA/CCX radios)
- The database schema is identical (268 tables)
- CCA/CCX protocols are product-agnostic
- Designer doesn't hard-validate processor product type during transfer

### The Failed Approach: Project File Conversion
Converting backup-pristine.ra3 → converted.hw by modifying the .bak file caused
Designer to freeze at 19% loading "Guest Room." FK constraints (all 202 disabled)
were fixed but didn't solve it.

### The Working Approach: Fresh HW + Identity Injection

#### Prerequisites
- A working .hw project file that opens in Designer (e.g., Test.hw)
- The RA3 project's database accessible (restored as InspectOrig on LocalDB)
- Both databases on the same LocalDB instance for cross-DB queries

#### Fields to Update (6 updates total)

**Processor Identity (tblProcessor):**
```sql
UPDATE dbo.tblProcessor SET
  SerialNumber = ra3.SerialNumber,
  MacAddress = ra3.MacAddress,
  IPAddress = ra3.IPAddress,
  ProcessorCertificate = ra3.ProcessorCertificate,
  LoobKey = ra3.LoobKey
FROM dbo.tblProcessor hw
CROSS JOIN <ra3_db>.dbo.tblProcessor ra3;
```

**Processor System Certs (tblProcessorSystem):**
```sql
UPDATE dbo.tblProcessorSystem SET
  SubsystemCertificateV2 = ra3.SubsystemCertificateV2,
  SubSystemPrivateKeyV2 = ra3.SubSystemPrivateKeyV2,
  UniqueLocalIPv6NetworkAddress = ra3.UniqueLocalIPv6NetworkAddress
FROM dbo.tblProcessorSystem hw
CROSS JOIN <ra3_db>.dbo.tblProcessorSystem ra3;
```

**CCA Link — Subnet Address (tblLink):**
```sql
UPDATE dbo.tblLink SET SubnetAddress = 33495  -- 0x82D7
WHERE LinkInfoID = 11;  -- CCA link type
```

**CCX Link — Thread Credentials (tblPegasusLink):**
```sql
UPDATE dbo.tblPegasusLink SET
  Channel = ra3.Channel, PanID = ra3.PanID,
  ExtendedPanId = ra3.ExtendedPanId,
  NetworkMasterKey = ra3.NetworkMasterKey
FROM dbo.tblPegasusLink hw
CROSS JOIN <ra3_db>.dbo.tblPegasusLink ra3;
```

**Activation State (tblProcessor) — CRITICAL:**
```sql
UPDATE dbo.tblProcessor SET SerialNumberState = 2;
```
- `SerialNumberState = 0` → not activated, blocks transfer
- `SerialNumberState = 2` → activated, allows transfer

#### Key Data Points (from RA3 project)
| Field | Value |
|-------|-------|
| Processor MAC | `a0:b1:c2:d3:e4:f5` |
| Processor Serial | `100000001` |
| Processor IP | `10.0.0.1` |
| CCA SubnetAddress | `33495` (0x82D7), Channel 26 |
| CCX Channel | 25 |
| CCX PanID | 25327 (0xXXXX) |
| CCX ExtendedPanId | `0x<your-thread-xpanid>` |
| CCX NetworkMasterKey | `0x<your-thread-master-key>` |

### What This Achieves
- Designer treats the RA3 processor as an HW processor
- The processor joins the same CCA/CCX RF networks as the existing RA3 devices
- HW features (DoubleTap, HoldPreset, richer LedLogic, etc.) become available
- Existing devices are discoverable on the network

### CCX vs CCA Device Injection Results
- **CCX devices (Thread) WORK** — injecting SerialNumber + SerialNumberState=2 +
  PegasusLinkNode (IPv6/GUID) survives Designer save/transfer. HN3RL confirmed working.
- **CCA devices get WIPED** — Designer caches device data in memory. On save/transfer,
  it overwrites CCA device SerialNumber back to 0 and SerialNumberState back to 0.

### FAILED Approaches — DO NOT USE
- **Offline .bak Patching**: Extracted .bak → patched via SQL → repacked. **CRASHED the VM.** Never patch .bak files offline.
- **Close Without Saving**: Designer discards all in-memory state on close without save.

### The Only Viable Approach for CCA Devices: Live DB + Designer Save Trick
1. Open the .hw project in Designer (live LocalDB)
2. Run SQL updates on the live database (serial numbers, SerialNumberState=2, link nodes)
3. Make a trivial UI change so Designer considers the project "dirty"
4. File > Save
5. Close > Reopen > Transfer

**CONFIRMED working for CCA devices (2026-03-03).** AddressOnLink MUST match the RA3 device's actual CCA address.

### CCX Devices Don't Need DB Injection
- CCX (Thread) devices can be activated via the native Lutron app — no DB hacking needed
- Only CCA devices require manual serial + activation injection via live DB

### Migration Workflow
1. Build the HW project topology in Designer (areas, rooms, devices, zones)
2. For each device: match to RA3 device by model, update serial + activation via live DB
3. Save trick after each batch of updates
4. Transfer to processor — devices connect on their existing RF addresses

### Device ID Reference
| Test.hw ID | RA3 ID | Model      | Link | Address | Serial    |
|------------|--------|------------|------|---------|-----------|
| 483        | 926    | RRST-HN3RL | CCX  | 3       | 100000003 |
| 532        | 3272   | RRD-3LD    | CCA  | 14      | 100000004   |
| 561        | 3289   | RRD-3LD    | CCA  | 15      | 100000005   |

### Link Structure Reference
- CCA Link: LinkInfoID=11 (link 236 in RA3, link 439 in Test.hw)
- CCX Link: LinkInfoID=40 (link 234 in RA3, link 437 in Test.hw)
- Processor owns both links (IsLinkOwner=1 on link nodes 233/235 in RA3, 436/438 in Test.hw)
