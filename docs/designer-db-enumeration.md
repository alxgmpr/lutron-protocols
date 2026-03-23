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
