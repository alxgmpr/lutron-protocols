---
name: designer-project
description: Open and query Lutron Designer project files (.hw/.ra3) — CCA address maps, zone assignments, device inventory, link topology. Use when analyzing project structure, planning device additions, or mapping CCA zone bytes.
metadata:
  author: alex
  version: "1.0"
user_invocable: true
---

# Designer Project Query

Opens Lutron Designer `.hw`/`.ra3` project files via Docker SQL Server and queries the project database. No VM or Designer app needed.

## Prerequisites

- Docker running (container `lutron-sql2022` auto-starts on first use)
- Project file path (e.g., `~/Downloads/share/gs.hw`)

## Opening a Project

```bash
npx tsx tools/designer/designer-project.ts open <project-file>
npx tsx tools/designer/designer-project.ts status   # check if already open
npx tsx tools/designer/designer-project.ts close    # close when done
```

Only one project can be open at a time. Check status first.

## Key Queries

### CCA Address Map (the primary use case)

This is the complete CCA device inventory with on-wire zone bytes. The CCA zone byte seen in state report packets (byte 5) = `AddressOnLink - 1`.

```sql
SELECT
  ln.AddressOnLink as LinkAddr,
  ln.AddressOnLink - 1 as CCA_Zone,
  s.PropertyAddress as PropAddr,
  d.SerialNumber as Serial,
  d.SerialNumberState as Paired,
  d.ModelInfoID as ModelID,
  cs.Name as Station,
  a.Name as Area,
  z.Name as Zone,
  z.ControlType as CtrlType
FROM tblLinkNode ln
JOIN tblControlStationDevice d ON d.ControlStationDeviceID = ln.ParentDeviceID
LEFT JOIN tblControlStation cs ON cs.ControlStationID = d.ParentControlStationID
LEFT JOIN tblArea a ON a.AreaID = cs.ParentID
LEFT JOIN AllZonesWithAssociatedDevice zd ON zd.device_id = d.ControlStationDeviceID
LEFT JOIN tblZone z ON z.ZoneID = zd.zone_id
LEFT JOIN tblShortFormPropertyAddressMap s ON s.ParentDeviceID = d.ControlStationDeviceID
WHERE ln.LinkType = 11
ORDER BY ln.AddressOnLink
```

### Processor / Link Master

```sql
SELECT ln.AddressOnLink, ln.IsLinkOwner, ln.IsLinkMaster, ln.LinkType
FROM tblLinkNode ln
WHERE ln.IsLinkOwner = 1 OR ln.IsLinkMaster = 1
```

### CCX Devices (Thread, link type 40)

```sql
SELECT
  ln.AddressOnLink as LinkAddr,
  d.SerialNumber as Serial,
  d.SerialNumberState as Paired,
  d.ModelInfoID as ModelID,
  cs.Name as Station,
  a.Name as Area
FROM tblLinkNode ln
JOIN tblControlStationDevice d ON d.ControlStationDeviceID = ln.ParentDeviceID
LEFT JOIN tblControlStation cs ON cs.ControlStationID = d.ParentControlStationID
LEFT JOIN tblArea a ON a.AreaID = cs.ParentID
WHERE ln.LinkType = 40
ORDER BY ln.AddressOnLink
```

### All Zones with Areas

```sql
SELECT
  z.ZoneID, z.Name as Zone, z.ZoneNumber, z.ControlType,
  a.Name as Area
FROM tblZone z
LEFT JOIN tblArea a ON a.AreaID = z.ParentID
ORDER BY a.Name, z.SortOrder
```

### Free CCA Addresses

Addresses 0-5 are reserved (repeaters/master). Processor is typically at 255. Find gaps:

```sql
SELECT ln.AddressOnLink FROM tblLinkNode ln
WHERE ln.LinkType = 11
ORDER BY ln.AddressOnLink
-- Compare against available range 6-254
-- Next free = MAX(AddressOnLink) + 1 from occupied set
```

### Preset/Scene Assignments

```sql
SELECT
  p.PresetID, p.Name as PresetName,
  pa.ZoneID, z.Name as ZoneName,
  pa.Level, pa.Fade, pa.Delay
FROM tblPreset p
JOIN tblPresetAssignment pa ON pa.PresetID = p.PresetID
JOIN tblZone z ON z.ZoneID = pa.ZoneID
ORDER BY p.PresetID, pa.ZoneID
```

## Address Architecture

Three different address spaces coexist:

| Concept | Table.Column | Range | On CCA Wire? |
|---------|-------------|-------|-------------|
| Link node index | `tblLinkNode.AddressOnLink` | 6-254 (CCA type 11) | No (TDMA slot) |
| CCA zone byte | `AddressOnLink - 1` | 5-253 | Yes (byte 5 in state reports) |
| Property address | `tblShortFormPropertyAddressMap.PropertyAddress` | 1+ (sequential) | No (LEAP integration ID) |

- **AddressOnLink** = device's position on the CCA RF link. Assigned during pairing. TDMA scheduling uses this.
- **CCA zone byte** = `AddressOnLink - 1`. This is what appears in CCA state report packets at byte 5 (with bit 7 sometimes set for alternate components on the same device).
- **PropertyAddress** = sequential LEAP integration property ID. Used by the LEAP API for zone addressing. NOT related to the on-wire CCA value.

## Tool Commands Reference

```bash
npx tsx tools/designer/designer-project.ts open <file>        # Open project
npx tsx tools/designer/designer-project.ts query "<sql>"       # Run SQL
npx tsx tools/designer/designer-project.ts tables [filter]     # List tables
npx tsx tools/designer/designer-project.ts describe <table>    # Show schema
npx tsx tools/designer/designer-project.ts dump <table> [N]    # Dump rows
npx tsx tools/designer/designer-project.ts close               # Close project
npx tsx tools/designer/designer-project.ts status              # Check state
npx tsx tools/designer/designer-project.ts save <output>       # Save modified (needs VM)
```

## Key Tables

| Table | Purpose |
|-------|---------|
| `tblLinkNode` | Device RF link positions (AddressOnLink, LinkType 11=CCA, 40=CCX) |
| `tblControlStationDevice` | Device records (serial, model, activation state) |
| `tblControlStation` | Device grouping / physical location |
| `tblArea` | Room/area hierarchy |
| `tblZone` | Zone definitions (controllable outputs) |
| `AllZonesWithAssociatedDevice` | View: zone_id -> device_id mapping |
| `tblShortFormPropertyAddressMap` | LEAP property addresses per device output |
| `tblPreset` / `tblPresetAssignment` | Scene/preset level assignments |
| `tblIntegrationID` | Integration IDs for external control |

## ModelInfoID Reference

Model info is stored in the Designer reference library (SQLMODELINFO.MDF), not in the project DB. The `ModelInfoID` in `tblControlStationDevice` is an opaque foreign key into that library. To resolve model numbers, either:
- Cross-reference against known IDs from previous sessions
- Open the VM and query the reference DB via `mcp__designer-db__query`
