# Lutron Project Database Editing Guide

## File Structure

```
.ra3 or .hw (ZIP Archive)
  └── <uuid>.lut (MTF Backup - Microsoft Tape Format)
      └── Project.mdf + Project_log.ldf (SQL Server Database)
```

| Property | Value |
|----------|-------|
| Database Format | SQL Server LocalDB |
| Database Version | **957** (SQL Server 2022 RTM) |
| Expected .mdf Size | 36,700,160 bytes (35,840 KB) |
| SQL Server Signature | `0x01 0x0f` at offset `0x4000` in .lut file |
| String Encoding | UTF-16LE |

## The Version Problem

Lutron Designer 25.10 uses SQL Server database version **957** (SQL Server 2022 RTM).

Most SQL Server installations will **upgrade** the database when attached:
- SQL Server 2022 with CUs → upgrades to version 998+
- SQL Server 2019 → version 904 (too old, can't open)

Lutron Designer **will not open** databases upgraded beyond version 957.

### Solution: Use SQL Server 2022 RTM in Docker

```bash
docker run -e "ACCEPT_EULA=Y" -e "MSSQL_SA_PASSWORD=LutronPass123" \
  -p 1433:1433 --name sql2022rtm \
  -v "$(pwd)":/data \
  -d mcr.microsoft.com/mssql/server:2022-RTM-ubuntu-20.04
```

## Editing Methods

### Method 1: Live Editing (Recommended)

Edit the database while Lutron Designer has the project open.

1. Open project in Lutron Designer
2. Find LocalDB pipe (PowerShell):
   ```powershell
   Get-ChildItem "\\.\pipe\" | Where-Object {$_.Name -like "*LOCALDB*"}
   ```
3. Connect in SSMS: `np:\\.\pipe\LOCALDB#XXXXX\tsql\query`
4. Make changes, close Lutron Designer normally

### Method 2: SQL Server (Docker)

```bash
# Extract
python3 lutron-tool.py extract "project.hw" extracted/
python3 lutron-tool.py extract "extracted/<uuid>.lut" extracted/db/

# Attach
CREATE DATABASE [Project] ON (FILENAME = '/data/extracted/db/Project.mdf') FOR ATTACH_FORCE_REBUILD_LOG;

# Edit, then detach
EXEC sp_detach_db 'Project', 'true';

# Pad back to expected size and repack
python3 lutron-tool.py pack extracted/db/Project.mdf modified.lut --template "extracted/<uuid>.lut"
```

### Method 3: Binary Editing (Same-Length Only)

For same-length string replacements without SQL Server:

```python
old = "Light".encode('utf-16le')  # 10 bytes
new = "Lite1".encode('utf-16le')  # 10 bytes (same length)
```

Cannot change string length - breaks row storage.

## RA3 vs Homeworks Differences

Both use **identical table structures**. Differences are in enabled features:

| Field | RA3 | HW |
|-------|-----|-----|
| ProductType (tblProject) | 3 | 4 |
| AllowDoubleTap | 0 | 1 |
| HoldPresetId | NULL | Set |

### Enabling HW Features in RA3

```sql
UPDATE tblProgrammingModel
SET AllowDoubleTap = 1, DoubleTapPresetID = <preset_id>
WHERE ProgrammingModelID = <id>;
```

## Key Tables

| Table | Purpose |
|-------|---------|
| tblProject | Project metadata, ProductType |
| tblZone | Lighting zones |
| tblArea | Rooms and areas |
| tblDevice | Physical devices |
| tblScene | Lighting scenes |
| tblProgrammingModel | Button programming (AllowDoubleTap, HoldPresetId) |
| tblPreset | Preset actions |
| tblPresetAssignment | Links presets to zones/scenes |
| tblKeypadButton | Physical button definitions |
| tblVariable / tblVariableState | Conditional logic |
| tblOccupancyGroup | Occupancy sensing config |
| tblIntegrationID | Integration IDs |
| tblThirdPartyDevice | External device definitions |

## Model IDs

| Device | RA3 ModelInfoID | HW ModelInfoID |
|--------|-----------------|----------------|
| Enclosure | 5093 | 5046 |
| Processor | 5092 | 5045 |
| Keypad | 5122 | 5056 |
| Dimmer | 5115 | 5063 |

## Hidden Features

Features in schema but may not be exposed in GUI:

1. **Double-Tap on RA3** - Enable via `AllowDoubleTap`
2. **Cycle Dim on RA3** - Enable via `HoldPresetId`
3. **Third-Party RS232/IP** - tblThirdPartyDevice
4. **BACnet** - `IsBACnetEnabled` in tblProcessor
5. **Custom Variables** - Create custom state machines

## Troubleshooting

### Database version error
Use SQL Server 2022 RTM (version 957).

### File won't open after modification
1. Check version is still 957
2. Check file size is 36,700,160 bytes
3. Ensure no .ldf file in .lut pack

### Lutron Designer crashes
Check Event Viewer. Clean up with:
```bash
SqlLocalDB stop MSSQLLocalDB && SqlLocalDB delete MSSQLLocalDB
```
