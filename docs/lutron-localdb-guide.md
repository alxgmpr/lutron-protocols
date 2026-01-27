# Finding Lutron Designer LocalDB

## Overview

Lutron Designer uses SQL Server LocalDB to store project data. The database instance and pipe name change dynamically, so you need to discover them at runtime.

## Step 1: Find Active LocalDB Pipes

When Designer is running with a project open, look for active LocalDB pipes:

```powershell
[System.IO.Directory]::GetFiles("\\.\pipe\") | Where-Object { $_ -like "*LOCALDB*" }
```

Example output:
```
\\.\pipe\LOCALDB#7C064599\tsql\query
```

The `LOCALDB#XXXXXXXX` portion is the instance ID.

## Step 2: Connect via sqlcmd

Use the pipe name directly with `-No` flag (disable encryption):

```powershell
sqlcmd -S "np:\\.\pipe\LOCALDB#XXXXXXXX\tsql\query" -No -Q "SELECT name FROM sys.databases"
```

## Step 3: Find the Project Database

The active project database is named `Project`:

```powershell
sqlcmd -S "np:\\.\pipe\LOCALDB#XXXXXXXX\tsql\query" -No -d Project -Q "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES"
```

## Database File Locations

MDF files are stored in:
```
C:\ProgramData\Lutron\LutronElectronics.LutronDesignerGamma_hb4qhwkzq4pcy\<Username>\Lutron Designer <Version>\
```

Files:
- `Project.mdf` - Current project data
- `SqlApplicationData.mdf` - Application settings
- `SqlModelInfo.mdf` - Model/device info
- `SqlReferenceInfo.mdf` - Reference data

## Important Tables

### Certificate/Key Storage

| Table | Columns |
|-------|---------|
| `tblProcessorSystem` | `SubsystemCertificate`, `SubsystemCertificateV2`, `SubSystemPrivateKey`, `SubSystemPrivateKeyV2` |
| `tblProcessor` | `ProcessorCertificate`, `IsUsingV2Certificate`, `LoobKey` |
| `tblLutronConnectBridge` | `EncKey`, `PublicKey` |
| `tblPegasusLink` | `NetworkMasterKey`, `LDKNetworkMasterKey` |

### Network Configuration

| Table | Contains |
|-------|----------|
| `tblPegasusLink` | Thread/CCX network keys (PANID, NetworkMasterKey) |
| `tblProcessor` | Processor MAC, serial, firmware info |

## Quick One-Liner

Find and connect to active Lutron LocalDB:

```powershell
$pipe = ([System.IO.Directory]::GetFiles("\\.\pipe\") | Where-Object { $_ -like "*LOCALDB*" })[0]; sqlcmd -S "np:$pipe" -No -d Project -Q "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES ORDER BY TABLE_NAME"
```

## Extract Certificates

```sql
-- Get project certificates and private keys
SELECT
    SubsystemCertificate,
    SubsystemCertificateV2,
    SubSystemPrivateKey,
    SubSystemPrivateKeyV2
FROM tblProcessorSystem

-- Get processor certificate
SELECT ProcessorCertificate, IsUsingV2Certificate FROM tblProcessor
```

The certificates are stored as binary (PKCS#12/PFX format). To export:

```powershell
sqlcmd -S "np:\\.\pipe\LOCALDB#XXXXXXXX\tsql\query" -No -d Project -Q "SELECT SubsystemCertificateV2 FROM tblProcessorSystem" -o cert.bin -h -1 -W
```

## Notes

- LocalDB instance ID changes each time Designer starts
- Must have Designer open with a project for the database to be accessible
- Use `-No` flag with sqlcmd to disable encryption (LocalDB doesn't support it)
- The `Project` database contains the currently open project
- Certificates in `V2` columns are the newer format used by RA3
