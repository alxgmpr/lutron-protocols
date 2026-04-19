---
name: gather-presets
description: "Gather preset/scene zone assignments from Designer DB and generate data/preset-zones.json for the CCX-WiZ bridge. Use when scenes change or bridge needs updated preset data."
metadata:
  author: alexgompper
  version: "1.0.0"
user_invocable: true
---

# Gather Preset Assignments

Queries the Designer LocalDB for all preset→zone→level assignments and generates `data/preset-zones.json` — the lookup table used by the CCX-WiZ bridge to handle scene BUTTON_PRESS events.

## Prerequisites

- **Designer must be running** with a project open (LocalDB must be active)
- The `designer-db` MCP server must be connected

## Steps

### 1. Query the Designer DB

Run this SQL via the `mcp__designer-db__query` tool:

```sql
SELECT pa.ParentID AS PresetID, p.Name AS PresetName,
       pa.AssignableObjectID AS ZoneID, z.Name AS ZoneName,
       MAX(CASE WHEN acp.ParameterType = 3 THEN acp.ParameterValue END) AS LevelPct,
       MAX(CASE WHEN acp.ParameterType = 1 THEN acp.ParameterValue END) AS FadeQs,
       MAX(CASE WHEN acp.ParameterType = 2 THEN acp.ParameterValue END) AS DelayQs
FROM tblPresetAssignment pa
JOIN tblPreset p ON p.PresetID = pa.ParentID
JOIN tblZone z ON z.ZoneID = pa.AssignableObjectID
JOIN tblAssignmentCommandParameter acp ON acp.ParentId = pa.PresetAssignmentID
GROUP BY pa.ParentID, p.Name, pa.AssignableObjectID, z.Name
ORDER BY pa.ParentID, pa.AssignableObjectID
```

**Parameter types:** 1 = fade (quarter-seconds), 2 = delay (quarter-seconds), 3 = level (percent 0-100)

**NULL levels** (e.g., fan speed commands) should be skipped — they aren't dimming commands.

### 2. Load LEAP preset names

Read preset names from `data/leap-*.json` files to get human-readable names like `"Dimmed [Hallway Top of Stairs]"` instead of internal Designer names like `"Relax"` or `"Off Level"`. Fall back to the Designer name if no LEAP match.

### 3. Generate preset-zones.json

Build this structure and write to `data/preset-zones.json`:

```json
{
  "<presetId>": {
    "name": "<human-readable name>",
    "zones": {
      "<zoneId>": {
        "level": <0-100>,
        "fade": <quarter-seconds, omit if 0>
      }
    }
  }
}
```

### 4. Report results

Print:
- Total preset count
- Total zone assignment count
- Sample of a known scene preset (e.g., 3116 "Dimmed") to verify correctness

## Key Facts

- **Output file**: `data/preset-zones.json`
- **Consumer**: `bridge/main.ts` loads this at startup for scene BUTTON_PRESS handling
- **Includes virtual zones**: Unlike transfer capture decoding, the DB query gets ALL zones including virtual/digital devices not activated on the Thread mesh
- **Re-run when**: Scenes are modified in Designer, new zones added, or preset levels changed
- **DB tables**: `tblPresetAssignment` (ParentID=PresetID, AssignableObjectID=ZoneID), `tblAssignmentCommandParameter` (ParentId=PresetAssignmentID), `tblPreset`, `tblZone`
