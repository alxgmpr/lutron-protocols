# Lutron Project Database Editing Guide

This document summarizes findings from reverse-engineering Lutron Designer project files and methods for editing the embedded SQL Server database.

## File Structure

```
.ra3 or .hw (ZIP Archive)
  └── <uuid>.lut (MTF Backup - Microsoft Tape Format)
      └── Project.mdf + Project_log.ldf (SQL Server Database)
```

### Key Technical Details

| Property | Value |
|----------|-------|
| Database Format | SQL Server LocalDB |
| Database Version | **957** (SQL Server 2022 RTM) |
| Expected .mdf Size | 36,700,160 bytes (35,840 KB) |
| SQL Server Signature | `0x01 0x0f` at offset `0x4000` in .lut file |
| String Encoding | UTF-16LE |

## The Version Problem

Lutron Designer 25.10 uses SQL Server database version **957** (SQL Server 2022 RTM).

**Critical Issue:** Most SQL Server installations will **upgrade** the database when attached:
- SQL Server 2022 with CUs → upgrades to version 998+
- SQL Server 2019 → version 904 (too old, can't open)
- SQL Server 2014 → version 782 (too old, can't open)

Lutron Designer **will not open** databases that have been upgraded beyond version 957.

### Solution: Use SQL Server 2022 RTM in Docker

```bash
docker run -e "ACCEPT_EULA=Y" -e "MSSQL_SA_PASSWORD=LutronPass123" \
  -p 1433:1433 --name sql2022rtm \
  -v "$(pwd)":/data \
  -d mcr.microsoft.com/mssql/server:2022-RTM-ubuntu-20.04
```

Verify version:
```sql
SELECT DATABASEPROPERTYEX('master', 'version') AS DbVersion;
-- Should return 957
```

## Method 1: SQL Server Editing (Complex)

### Extract Database

```bash
# Extract .hw to .lut
python3 lutron-tool.py extract "project.hw" extracted/

# Extract .lut to .mdf
python3 lutron-tool.py extract "extracted/<uuid>.lut" extracted/db/
```

### Attach to SQL Server 2022 RTM Docker

```sql
CREATE DATABASE [Project] ON
  (FILENAME = '/data/extracted/db/Project.mdf')
  FOR ATTACH_FORCE_REBUILD_LOG;
GO
```

### Make Changes

```sql
USE Project;
UPDATE tblZone SET Name = 'NewName' WHERE Name = 'OldName';
```

### Detach

```sql
USE master;
ALTER DATABASE [Project] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
EXEC sp_detach_db 'Project', 'true';
GO
```

### Important: Post-Processing

After detaching, SQL Server may shrink the .mdf file. You **must** pad it back:

```python
import os

mdf_path = 'extracted/db/Project.mdf'
expected_size = 36700160  # 35,840 KB

current_size = os.path.getsize(mdf_path)
if current_size < expected_size:
    with open(mdf_path, 'ab') as f:
        f.write(b'\x00' * (expected_size - current_size))
```

### Repack

```bash
# Remove any .ldf file created by SQL Server
rm extracted/db/Project_log.ldf

# Pack .mdf to .lut (use original as template)
python3 lutron-tool.py pack extracted/db/Project.mdf modified.lut \
  --template "extracted/<uuid>.lut"

# Pack .lut to .hw
python3 lutron-tool.py pack modified.lut "modified.hw"
```

### Known Issues with SQL Server Method

Even with version 957, SQL Server modifies internal pages:
- Page checksums
- Allocation maps (GAM, SGAM, PFS)
- Transaction timestamps
- Row reorganization for variable-length changes

These changes may cause Lutron Designer to reject the file.

## Method 2: Live Editing (Recommended)

Edit the database while Lutron Designer has the project open.

### Steps

1. Open your project in Lutron Designer normally

2. Find the LocalDB pipe name (PowerShell):
   ```powershell
   Get-ChildItem "\\.\pipe\" | Where-Object {$_.Name -like "*LOCALDB*"}
   ```
   Output example: `LOCALDB#F15B8521\tsql\query`

3. Connect in SSMS:
   - **Server:** `np:\\.\pipe\LOCALDB#F15B8521\tsql\query`

4. Find the database:
   ```sql
   SELECT name FROM sys.databases WHERE name LIKE '%Lutron%';
   ```

5. Make changes:
   ```sql
   USE [Lutron_XXXXX_...];
   UPDATE tblZone SET Name = 'Light1' WHERE Name = 'Light';
   ```

6. Close Lutron Designer normally - it will save/pack the changes

## Method 3: Binary Editing (Same-Length Changes Only)

For simple same-length string replacements, direct binary editing works without SQL Server.

```python
import shutil

shutil.copy('original/Project.mdf', 'modified/Project.mdf')

with open('modified/Project.mdf', 'rb') as f:
    data = bytearray(f.read())

# Find and replace (same length only!)
old = "Light".encode('utf-16le')  # 10 bytes
new = "Lite1".encode('utf-16le')  # 10 bytes (same length)

pos = data.find(old)
if pos != -1:
    data[pos:pos+len(old)] = new

with open('modified/Project.mdf', 'wb') as f:
    f.write(data)
```

**Limitation:** Cannot change string length (e.g., "Light" to "Light1") because SQL Server uses variable-length row storage and the row structure would be corrupted.

## Database Schema (Common Tables)

| Table | Description |
|-------|-------------|
| tblZone | Lighting zones (dimmers, switches) |
| tblArea | Rooms and areas |
| tblDevice | Physical devices |
| tblScene | Lighting scenes |
| tblTimeClockEvent | Scheduled events |
| tblKeypad | Keypad configurations |

### Zone Table Structure

```sql
SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'tblZone';
```

Key columns:
- `ZoneID` - Primary key
- `Name` - nvarchar(50) - Zone name
- `ParentID` - Parent area ID
- `Guid` - Unique identifier

## Troubleshooting

### "Database version X not supported"

Your SQL Server is too old or too new. Use SQL Server 2022 RTM (version 957).

### File won't open after modification

1. Check database version is still 957:
   ```python
   import struct
   with open('Project.mdf', 'rb') as f:
       f.seek(0x12064)
       version = struct.unpack('<H', f.read(2))[0]
       print(f"Version: {version}")  # Should be 957
   ```

2. Check file size is 36,700,160 bytes

3. Ensure no .ldf file is included in the .lut pack

### Lutron Designer crashes on open

Check Windows Event Viewer → Application logs for `.NET Runtime` errors. Common issues:
- Leftover database attachments from previous crashes
- Clean up: `SqlLocalDB stop MSSQLLocalDB && SqlLocalDB delete MSSQLLocalDB`
- Delete .ldf files in `C:\ProgramData\Lutron\...\`

## Tools

### lutron-tool.py Commands

```bash
# Show file info
python3 lutron-tool.py info <file>

# Extract (auto-detects type)
python3 lutron-tool.py extract <input> [output_dir]

# Pack with template (recommended)
python3 lutron-tool.py pack <input.mdf> <output.lut> --template <original.lut>

# Pack to project file
python3 lutron-tool.py pack <input.lut> <output.hw>
```

### Docker SQL Server 2022 RTM

```bash
# Start
docker run -e "ACCEPT_EULA=Y" -e "MSSQL_SA_PASSWORD=LutronPass123" \
  -p 1433:1433 --name sql2022rtm \
  -v "$(pwd)":/data \
  -d mcr.microsoft.com/mssql/server:2022-RTM-ubuntu-20.04

# Connect via sqlcmd
docker exec sql2022rtm /opt/mssql-tools/bin/sqlcmd \
  -S localhost -U sa -P 'LutronPass123' -Q "SELECT @@VERSION"

# Stop/Remove
docker stop sql2022rtm && docker rm sql2022rtm
```

## Summary

| Method | Pros | Cons |
|--------|------|------|
| Live Editing | Works reliably, no version issues | Requires project open in LD |
| SQL Server (Docker) | Can edit offline | Complex, may still fail |
| Binary Edit | No SQL Server needed | Same-length changes only |
