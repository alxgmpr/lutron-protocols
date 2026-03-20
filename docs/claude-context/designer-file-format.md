# Designer File Format: .lut = SQL Server Backup (.bak)

**Discovered**: 2026-02-19 via ILSpy decompilation of Designer DLLs

## The Breakthrough

**The .lut file inside the ZIP is NOT an MDF — it's a SQL Server BACKUP (.bak) file.**

Designer uses `BACKUP DATABASE` / `RESTORE DATABASE` (via SMO) for all file I/O,
not `ATTACH` / `DETACH`. The "MTF header" we were parsing is just the native SQL
Server backup format header (which happens to use Microsoft Tape Format internally).

## Evidence

Decompiled from `Lutron.Gulliver.Infrastructure.DatabaseFramework.SQLServer.SQLServerProjectFileManager`:

### Save (ExportProject)
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

### Open (ImportProject)
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

### Verify
```csharp
public override bool Verify(string projectFileName)
{
    // Just checks ZIP integrity, NOT MDF or backup contents
    return zipProvider.IsZipValid(projectFileName);
}
```

### Restore uses SqlVerify before restoring
```csharp
// In DatabaseOperationsManager.SQLServerAdministrator.RestoreDatabase():
if (restore.SqlVerify(srv, out errMsg))
{
    restore.SqlRestore(srv);
    return true;
}
```

## Why Our Old Approach Failed

Our converter extracted the MDF from the .bak (by stripping the MTF header/footer),
modified it in Docker using ATTACH_FORCE_REBUILD_LOG, then stuffed it back into the
MTF wrapper. This had multiple problems:

1. **ATTACH_FORCE_REBUILD_LOG modifies system pages** — creates Docker-specific artifacts
   that Designer's LocalDB doesn't expect
2. **Page-level patching broke non-clustered indexes** — patching data pages independently
   from index pages left them inconsistent
3. **The resulting file wasn't a valid .bak** — it was a Frankenstein MTF wrapper around
   a Docker-modified MDF, not a proper SQL Server backup

## The Fix

Use RESTORE/BACKUP instead of ATTACH/DETACH:

1. Copy .lut to Docker as .bak
2. `RESTORE DATABASE [Project] FROM DISK = '/data/Project.bak'`
3. Run conversion SQL
4. `BACKUP DATABASE [Project] TO DISK = '/data/Converted.bak'`
5. Use Converted.bak directly as the .lut in the output ZIP

This produces a file that went through the same BACKUP/RESTORE path that Designer
uses, with proper system pages, checksums, log state, and metadata.

## File Format Stack (Corrected)

```
.ra3/.hw (ZIP, MS-DOS attributes, version=20)
  └── <uuid>.lut = SQL Server backup file (.bak)
      ├── MTF header (TAPE signature at offset 0, "Microsoft SQL Server" at 0x60)
      ├── SQL data (pages from BACKUP DATABASE)
      └── MTF footer (SFMB, ESET, TSMP blocks, 4K-aligned)
```

Note: the "MTF header" and "footer" are NOT a custom wrapper — they ARE the standard
SQL Server backup format. SQL Server natively uses MTF for its .bak files.

## Save Error Root Cause

`HandleProjectOperationExceptions` catches `SqlException` during `BackUpDatabase()`:
```csharp
if (ex is SqlException || DBExceptionChecker.IsFailedOperationException(ex))
    MessageDialogService.ShowError(dbCouldNotBeSavedMessage);
    // "Project could not be saved. The database service may need to be restarted."
```

The ATTACH_FORCE_REBUILD_LOG'd database had internal inconsistencies that caused
`BACKUP DATABASE` to fail with a SqlException. DBCC CHECKDB passed but the backup
engine has additional checks.

## Key DLL Map

| DLL | Purpose | Key Classes |
|-----|---------|-------------|
| `DatabaseOperationsManager.dll` | SMO wrappers | `SQLServerAdministrator` (Backup/Restore/Detach) |
| `Lutron.Gulliver.Infrastructure.dll` | File I/O | `SQLServerProjectFileManager` (save/open flow) |
| `Lutron.Gulliver.QuantumResi.dll` | UI/orchestration | `ProjectSaveServiceBase` (error handling) |
| `Lutron.Gulliver.Infrastructure.DatabaseFramework.dll` | DB schema | Conversion scripts, ProductType SQL |

## Decompilation Setup

```bash
# ILSpy CLI on macOS with .NET 10 + roll-forward
export DOTNET_ROOT=/opt/homebrew/Cellar/dotnet/10.0.103/libexec
export DOTNET_ROLL_FORWARD=LatestMajor
DESIGNER_DIR="~/Downloads/Lutron Designer 26.0.1.100/QuantumResi"
ilspycmd -t <FullTypeName> "$DESIGNER_DIR/<dll>" -r "$DESIGNER_DIR"
```
