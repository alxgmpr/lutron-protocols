# Homeworks vs RadioRA3 Database Comparison

## Key Finding: Same Schema, Different Features Enabled

Both databases have **identical table structures**. The difference is in the **data** - specifically which features are enabled.

## Programming Model Differences

### Object Types (in tblProgrammingModel)
| Type | Name | Description |
|------|------|-------------|
| 60 | SAPM | Single Assignment Programming Model |
| 62 | DAPM | Dimmer Assignment Programming Model |
| 74 | ATPM | Advanced Tap Programming Model (double-tap, hold) |
| 77 | MRLPM | Master Raise/Lower Programming Model |

### HW Has These Features Enabled:

```
ProgrammingModelID: 401 (ATPM)
- AllowDoubleTap: 1
- DoubleTapPresetID: 446
- HeldButtonAction: 1

ProgrammingModelID: 405 (ATPM)
- HoldPresetId: 451 (Cycle Dim)

ProgrammingModelID: 409 (ATPM)
- HoldPresetId: 448 (Cycle Dim)
```

### RA3 Has Same Structure But Disabled:

```
ProgrammingModelID: 266, 270, 274 (ATPM)
- AllowDoubleTap: 0
- DoubleTapPresetID: NULL
- HoldPresetId: NULL
```

## Key Tables for Programming

### tblProgrammingModel
Core programming logic for each button:
- `AllowDoubleTap` (0/1) - Enable double-tap feature
- `DoubleTapPresetID` - Preset to activate on double-tap
- `HeldButtonAction` (0/1) - Enable hold/cycle feature
- `HoldPresetId` - Preset to activate on hold
- `OnPresetID` / `OffPresetID` - Toggle presets
- `PressPresetID` / `ReleasePresetID` - Momentary presets

### tblPreset
Defines what happens when activated:
- `PresetType` - Type of preset action
- `ParentID` / `ParentType` - Links back to programming model

### tblPresetAssignment
Links presets to controllable objects (zones, scenes):
- `AssignableObjectID` - Target zone/scene ID
- `AssignmentCommandType` - Action type (on, off, level, etc.)

### tblKeypadButton
Physical button definitions:
- `ProgrammingModelID` - Links to programming model
- `ButtonNumber` - Physical button position
- `ParentDeviceID` - Parent keypad device

## Enabling HW Features in RA3

To enable double-tap on an RA3 button:

```sql
-- 1. Update the programming model to enable double-tap
UPDATE tblProgrammingModel
SET AllowDoubleTap = 1,
    DoubleTapPresetID = <new_preset_id>
WHERE ProgrammingModelID = <button's programming model>;

-- 2. Create a preset for the double-tap action
INSERT INTO tblPreset (PresetID, Name, PresetType, ParentID, ParentType, ...)
VALUES (<new_preset_id>, 'Double Tap', 1, <programming_model_id>, 74, ...);

-- 3. Create preset assignment to link to zone/scene
INSERT INTO tblPresetAssignment (...)
VALUES (...);
```

## Table Row Count Differences

| Table | HW | RA3 | Difference |
|-------|-----|------|------------|
| tblProgrammingModel | 12 | 9 | +3 (more buttons with advanced programming) |
| tblKeypadButton | 7 | 5 | +2 |
| tblPreset | 20 | 12 | +8 (double-tap and hold presets) |
| tblPresetAssignment | 10 | 9 | +1 |
| tblButtonGroup | 2 | 1 | +1 |
| tblVariable | 2 | 1 | +1 |
| tblVariableState | 4 | 2 | +2 |

## Recommendations for Cross-System Programming

1. **Start with live editing** - Connect to Lutron Designer's LocalDB while project is open

2. **Copy programming model patterns** - Use HW entries as templates for RA3

3. **Maintain referential integrity** - All IDs must be unique and relationships valid

4. **Test incrementally** - Enable one feature at a time

5. **Backup first** - Always keep original .hw/.ra3 files

## Connection Info

To explore databases:

```powershell
# Find LocalDB pipe while Lutron Designer is open
Get-ChildItem "\\.\pipe\" | Where-Object {$_.Name -like "*LOCALDB*"}

# Connect in SSMS
Server: np:\\.\pipe\LOCALDB#XXXXX\tsql\query
```

Or use Docker SQL Server 2022 RTM for offline analysis.
