---
name: gather-presets
description: "Gather preset/scene zone assignments from a Designer project file (.hw/.ra3) and generate data/preset-zones.json for the CCX-WiZ bridge. Use when scenes change or bridge needs updated preset data."
metadata:
  author: alexgompper
  version: "2.0.0"
user_invocable: true
---

# Gather Preset Assignments

Reads preset→zone→level assignments directly from a Designer `.hw`/`.ra3` file
via Docker SQL Server (no VM, no live Designer install required) and generates
`data/preset-zones.json` — the lookup table used by the CCX-WiZ bridge to
handle scene BUTTON_PRESS events.

## Prerequisites

- Docker Desktop running (the `lutron-sql2022` container auto-starts on first use)
- A Designer project file (e.g., `~/Downloads/share/gs-v26.2.0.113.hw`)

## Run

```bash
npx tsx tools/gather-presets.ts --project <file.hw|.ra3>
```

This:
1. Opens the project via `tools/designer-project.ts open` (extracts the embedded
   `.bak`, restores into Docker SQL Server)
2. Runs the preset query
3. Merges in human-readable preset names from `data/leap-*.json`
4. Writes `data/preset-zones.json`
5. Reports preset/zone counts and a sample (preset 3116 "Dimmed")

If a project is already open via `tools/designer-project.ts open`, omit
`--project` to query it without reopening.

## SQL

The query lives inside [tools/gather-presets.ts](../../../tools/gather-presets.ts).
Key bits:

```sql
SELECT pa.ParentID AS PresetID, p.Name AS PresetName,
       pa.AssignableObjectID AS ZoneID, z.Name AS ZoneName,
       MAX(CASE WHEN acp.ParameterType = 3 THEN acp.ParameterValue END) AS LevelPct,
       MAX(CASE WHEN acp.ParameterType = 1 THEN acp.ParameterValue END) AS FadeQs,
       MAX(CASE WHEN acp.ParameterType = 2 THEN acp.ParameterValue END) AS DelayQs,
       MAX(CASE WHEN acp.ParameterType = 69 THEN acp.ParameterValue END) AS WarmDimCurveId
FROM tblPresetAssignment pa
JOIN tblPreset p ON p.PresetID = pa.ParentID
JOIN tblZone z ON z.ZoneID = pa.AssignableObjectID
JOIN tblAssignmentCommandParameter acp ON acp.ParentId = pa.PresetAssignmentID
GROUP BY pa.ParentID, p.Name, pa.AssignableObjectID, z.Name
ORDER BY pa.ParentID, pa.AssignableObjectID
```

**Parameter types:** 1 = fade (qs), 2 = delay (qs), 3 = level (0-100%),
69 = warm-dim curve ID. NULL levels (fan speed, CCO, etc.) are skipped.

**Warm-dim curve IDs:** 1=default, 2=halogen, 3=finire2700, 4=finire3000.

## Output Format

`data/preset-zones.json`:

```json
{
  "<presetId>": {
    "name": "<human-readable name>",
    "zones": {
      "<zoneId>": {
        "level": <0-100>,
        "fade": <quarter-seconds, omit if 0>,
        "warmDimCurve": "<curve name, omit if none>"
      }
    }
  }
}
```

## Key Facts

- **Output file**: `data/preset-zones.json` (gitignored)
- **Consumer**: `bridge/main.ts` loads this at startup for scene BUTTON_PRESS handling
- **Includes virtual zones**: DB query gets ALL zones including virtual/digital
  devices not activated on the Thread mesh
- **Re-run when**: Scenes are modified in Designer, new zones added, preset levels changed
- **DB tables**: `tblPresetAssignment` (ParentID=PresetID, AssignableObjectID=ZoneID),
  `tblAssignmentCommandParameter` (ParentId=PresetAssignmentID), `tblPreset`, `tblZone`
- **No VM required**: Docker SQL Server reads the raw project file. See the
  `designer-project` skill for the full project-query workflow.

## After regenerating

To deploy to the HA add-on, run `./bridge/deploy-ha.sh` (with HA SMB shares mounted
at `/Volumes/config` and `/Volumes/addons`). It copies `preset-zones.json`,
`leap-10.0.0.1.json`, and `ccx-device-map.json` to `/config/ccx-bridge/` on HA.
