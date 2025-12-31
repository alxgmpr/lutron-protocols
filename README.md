# Lutron Project File Tool

A comprehensive CLI tool for extracting and modifying Lutron lighting control system project files.

## Overview

This tool allows you to:
- Extract SQL Server databases from Lutron project files (.ra3, .hw)
- Modify the database using SQL Server
- Pack the modified database back into Lutron project files

### Supported File Types

- **.ra3** - RadioRA3 project files (ZIP archive containing .lut)
- **.hw** - Homeworks QS project files (ZIP archive containing .lut)
- **.lut** - Lutron backup files (MTF format containing SQL Server database)
- **.mdf/.ldf** - SQL Server database files

### File Structure

```
.ra3 or .hw (ZIP Archive)
  └── <uuid>.lut (MTF Backup)
      └── Project.mdf + Project_log.ldf (SQL Server Database)
```

## Installation

No installation required! Just download `lutron-tool.py` and run it with Python 3.

### Requirements
- Python 3.6 or later
- No external dependencies (uses only standard library)

## Usage

### Basic Commands

```bash
# Show help
python3 lutron-tool.py --help

# Show file information
python3 lutron-tool.py info <file>

# Extract files
python3 lutron-tool.py extract <input> [output_dir]

# Pack files
python3 lutron-tool.py pack <input> <output>
```

## Complete Workflow Examples

### Example 1: Extract and View Database from .hw File

```bash
# Step 1: Extract .lut from .hw file
python3 lutron-tool.py extract "My-Project.hw" project_files

# Step 2: Extract database from .lut file
python3 lutron-tool.py extract "project_files/<uuid>.lut" database

# Step 3: Copy Project.mdf to Windows and attach in SQL Server
# (See SQL Server Instructions below)
```

### Example 2: Modify Database and Repack

```bash
# After modifying the database in SQL Server...

# Step 1: Pack database back to .lut
python3 lutron-tool.py pack database/Project.mdf modified.lut \
  --template "project_files/<uuid>.lut"

# Step 2: Pack .lut back to original format (.hw or .ra3)
# Auto-detects project type from metadata!
python3 lutron-tool.py pack "project_files/<uuid>.lut" "My-Project-Modified"
# Automatically creates .hw or .ra3 based on original file type

# Or specify extension explicitly:
python3 lutron-tool.py pack modified.lut "My-Project-Modified.hw"

# Step 3: Import the modified file back into Lutron Designer
```

### Example 3: One-Line Extract

```bash
# Extract directly from .ra3 to database files
python3 lutron-tool.py extract "project.ra3"
python3 lutron-tool.py extract "project_extracted/<uuid>.lut"
```

## SQL Server Instructions

### Attaching the Database

Once you have extracted `Project.mdf`, copy it to your Windows SQL Server machine:

**Method 1: Using SQL Server Management Studio (SSMS)**
1. Open SSMS and connect to your SQL Server instance
2. Right-click **Databases** → **Attach...**
3. Click **Add** and select `Project.mdf`
4. Click **OK**

**Method 2: Using SQL Commands**

```sql
-- Delete any old log file first (in Command Prompt)
del "C:\path\to\Project_log.ldf"

-- Attach with force rebuild log
CREATE DATABASE [Project] ON
  (FILENAME = 'C:\path\to\Project.mdf')
  FOR ATTACH_FORCE_REBUILD_LOG;
GO
```

### Exploring the Database

```sql
-- List all tables
SELECT TABLE_NAME
FROM Project.INFORMATION_SCHEMA.TABLES
WHERE TABLE_TYPE = 'BASE TABLE'
ORDER BY TABLE_NAME;

-- Example: View all devices
SELECT * FROM Devices;

-- Example: Update a device name
UPDATE Devices
SET Name = 'New Device Name'
WHERE DeviceID = 123;
```

### Database Schema (Common Tables)

The Lutron database typically contains:
- **Devices** - All lighting devices, switches, dimmers
- **Areas** - Rooms and zones
- **Scenes** - Lighting scenes and presets
- **TimeClockEvent** - Scheduled events
- **TouchscreenAreaUserInterface** - Keypad configurations
- **ProgrammingModel** - Control logic

### Detaching the Database

After making changes, detach the database to get the .mdf file back:

**SSMS Method:**
1. Right-click the database → **Tasks** → **Detach**
2. Uncheck "Drop connections"
3. Click OK

**SQL Method:**
```sql
USE master;
GO

ALTER DATABASE [Project] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
GO

EXEC sp_detach_db 'Project', 'true';
GO
```

The `Project.mdf` file will now be free to copy back to your Mac/Linux machine.

## Key Features

### 🎯 Auto-Detection of Project Type

The tool automatically remembers whether your project was .ra3 (RadioRA3) or .hw (Homeworks QS):

```bash
# Extract from .ra3 file
python3 lutron-tool.py extract "MyProject.ra3"

# Later, pack back - automatically creates .ra3!
python3 lutron-tool.py pack "MyProject_extracted/<uuid>.lut" "output"
# Creates: output.ra3

# Same works for .hw files
python3 lutron-tool.py extract "MyProject.hw"
python3 lutron-tool.py pack "MyProject_extracted/<uuid>.lut" "output"
# Creates: output.hw
```

The tool stores metadata in `.lutron-metadata.json` to remember the original format.

### 🔧 Template-Based Packing

When packing databases back to .lut format, always use a template for best results:

```bash
python3 lutron-tool.py pack Project.mdf output.lut --template original.lut
```

This preserves the exact MTF backup structure from the original file.

## Command Reference

### `extract` - Extract files

Extract .ra3/.hw to .lut, or .lut to .mdf/.ldf files.

```bash
# Extract .hw to .lut
python3 lutron-tool.py extract "project.hw" [output_dir]

# Extract .lut to .mdf/.ldf
python3 lutron-tool.py extract "backup.lut" [output_dir]

# Auto-naming: if no output_dir specified, uses <filename>_extracted
python3 lutron-tool.py extract "project.ra3"
# Creates: project_extracted/
```

### `pack` - Pack files

Pack database files back into Lutron project formats.

```bash
# Pack .mdf to .lut (REQUIRES --template for best results)
python3 lutron-tool.py pack database/Project.mdf output.lut \
  --template "original_backup.lut"

# Pack .lut to .hw or .ra3
python3 lutron-tool.py pack backup.lut output.hw
python3 lutron-tool.py pack backup.lut output.ra3
```

**Important:** When packing to .lut, always use `--template` with an original .lut file. This preserves the MTF backup structure.

### `info` - Show file information

Display information about Lutron files.

```bash
python3 lutron-tool.py info "project.ra3"
python3 lutron-tool.py info "backup.lut"
python3 lutron-tool.py info "Project.mdf"
```

## Advanced Usage

### Using a Different Database Size

If your database is larger/smaller than the default (35,840 KB), you may need to adjust the padding. The tool currently assumes standard Lutron database sizes.

### Template-Based Packing

The `--template` option preserves all MTF metadata from the original file:

```bash
python3 lutron-tool.py pack modified.mdf new.lut --template original.lut
```

Without `--template`, the tool generates MTF headers from scratch (may not work in all cases).

## Troubleshooting

### "Could not attach database" in SQL Server

**Problem:** SQL Server shows errors about file version or corruption.

**Solution:**
1. Make sure you're using SQL Server 2012 or newer
2. Try `ATTACH_FORCE_REBUILD_LOG` instead of regular attach
3. Verify the .mdf file size is correct (should be 35,840 KB for typical projects)

### "File activation failure" Error

**Problem:** SQL Server can't find the log file.

**Solution:**
```bash
# Delete any old log file
del "C:\path\to\Project_log.ldf"

# Use ATTACH_FORCE_REBUILD_LOG
CREATE DATABASE [Project] ON
  (FILENAME = 'C:\path\to\Project.mdf')
  FOR ATTACH_FORCE_REBUILD_LOG;
GO
```

### "Database is too small" Error

**Problem:** The extracted .mdf is smaller than expected.

**Solution:** The tool automatically pads sparse backups. If you still see errors, the original backup may be corrupted.

### Files Not Identical After Round-Trip

**Problem:** Repacked files differ from originals.

**Solution:** This is normal - only the database data is preserved. MTF metadata like timestamps will differ. The database content should be identical.

## How It Works

### Extraction Process

1. **Unzip** - If input is .ra3/.hw, extract the .lut file using ZIP
2. **Parse MTF** - Read the Microsoft Tape Format backup structure
3. **Find Database** - Locate SQL Server signature at offset 0x4000
4. **Extract Data** - Copy database pages to .mdf file
5. **Pad** - Add zeros to reach expected file size (handles sparse backups)

### Packing Process

1. **Read Template** - Copy MTF headers from original .lut (recommended)
2. **Insert Database** - Write .mdf data at offset 0x4000
3. **Align** - Ensure proper block alignment for .ldf if present
4. **ZIP** - If packing to .ra3/.hw, create ZIP archive

## Technical Details

### MTF (Microsoft Tape Format)

The .lut files use MTF backup format with the following structure:

```
0x000000: TAPE header (512 bytes)
0x001000: SFMB block (soft file mark)
0x002000: SSET block (start of set)
0x002400: VOLB block (volume info)
0x002800: MSCI block (media catalog)
0x003000: SFIN block (file info for .mdf)
0x003400: SFIN block (file info for .ldf)
0x003800: MSDA header (data block)
0x004000: SQL Server database data begins
```

### SQL Server Database

Lutron uses SQL Server LocalDB with a schema containing:
- ~100+ tables for devices, areas, scenes, schedules
- UTF-16 encoded strings
- 8KB page size (standard SQL Server)
- Sparse backup format (unallocated pages not backed up)

## Safety & Backups

⚠️ **IMPORTANT:** Always keep backups of your original project files!

```bash
# Make a backup before modifying
cp "original-project.hw" "original-project-BACKUP.hw"
```

Changes to the database can affect your Lutron system configuration. Test thoroughly before deploying to production systems.

## Limitations

- Only supports SQL Server databases (not other backup types)
- Assumes standard Lutron database size (35,840 KB)
- Template-based packing recommended (generating MTF from scratch is limited)
- Transaction log (.ldf) extraction may not work for all files

## License

This tool is provided as-is for educational and personal use.

## Credits

Created for working with Lutron RadioRA3 and Homeworks QS project files.

---

**Questions or Issues?**

This tool was created to enable direct database editing of Lutron project files for advanced users.
