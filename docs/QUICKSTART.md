# Quick Start Guide

## 5-Minute Tutorial

### Extract Database from Lutron Project

```bash
# 1. Extract .lut from project file
python3 lutron-tool.py extract "My-Project.hw"
# Output: My-Project_extracted/<uuid>.lut

# 2. Extract database from .lut
python3 lutron-tool.py extract "My-Project_extracted/<uuid>.lut"
# Output: <uuid>_extracted/Project.mdf

# 3. Copy Project.mdf to Windows and attach in SQL Server
```

### Modify and Repack

```bash
# 4. After editing in SQL Server, detach and copy Project.mdf back

# 5. Pack database to .lut (IMPORTANT: use --template!)
python3 lutron-tool.py pack Project.mdf modified.lut \
  --template "My-Project_extracted/<uuid>.lut"

# 6. Pack .lut to project file
python3 lutron-tool.py pack modified.lut "My-Project-Modified.hw"

# 7. Import modified .hw into Lutron Designer!
```

### SQL Server Quick Commands

```sql
-- Attach database
CREATE DATABASE [Project] ON
  (FILENAME = 'C:\path\to\Project.mdf')
  FOR ATTACH_FORCE_REBUILD_LOG;
GO

-- View all tables
SELECT TABLE_NAME FROM Project.INFORMATION_SCHEMA.TABLES;

-- Detach when done
USE master;
ALTER DATABASE [Project] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
EXEC sp_detach_db 'Project', 'true';
```

## Common Use Cases

### Change Device Names in Bulk

```sql
-- View current names
SELECT DeviceID, Name FROM Devices;

-- Update names
UPDATE Devices SET Name = 'Kitchen ' + Name WHERE AreaID = 5;
```

### Clone a Project

```bash
# Extract original
python3 lutron-tool.py extract "Original.ra3"

# Pack to new file
python3 lutron-tool.py pack Project.mdf Clone.lut --template original.lut
python3 lutron-tool.py pack Clone.lut "Clone.ra3"
```

### Inspect Project Without Designer

```bash
# Just view the database
python3 lutron-tool.py info "project.hw"
python3 lutron-tool.py extract "project.hw"
python3 lutron-tool.py extract "<uuid>.lut"

# Open Project.mdf in any SQL tool
```

## Pro Tips

✅ **Always use --template** when packing to .lut  
✅ **Keep backups** of original project files  
✅ **Test in Designer** before deploying to real systems  
✅ **Use transactions** when modifying the database  

See README.md for full documentation!
