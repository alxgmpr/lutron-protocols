# GLAB-56: Exhaustive LEAP Dump — Registry-Driven Recursive Walker

## Summary

Extend `leap-dump.ts` with a `--full` flag that recursively walks all known LEAP endpoints using a declarative endpoint registry. Adding a new endpoint = adding one entry to an array. Default behavior (bridge config pipeline) is unchanged.

## Architecture

### Endpoint Registry

A typed array in `lib/leap-client.ts` defines every known LEAP endpoint:

```typescript
interface EndpointDef {
  path: string;           // LEAP path, e.g. "/area", "/occupancygroup"
  key: string;            // output JSON key, e.g. "areas", "occupancyGroups"
  core?: boolean;         // true = fetched in default mode, false = --full only
  itemsField: string | null; // response body field with array, null for singletons
  children?: ChildDef[];  // sub-endpoints to fetch per item (e.g. /associatedzone)
  perItem?: PerItemDef[]; // direct sub-resources per item (e.g. /status, /firmwareimage)
}

interface ChildDef {
  path: string;           // appended to parent item href
  key: string;            // nested key in output
  itemsField: string;     // response field containing child array
}

interface PerItemDef {
  path: string;           // appended to item href
  key: string;            // key in item output
}
```

### Registry Contents

Derived from `docs/claude-context/leap-probing.md` availability matrix:

| Endpoint | Key | Core | Children / PerItem |
|----------|-----|------|--------------------|
| `/server` | `server` | yes | — |
| `/system` | `system` | no | — |
| `/link` | `links` | yes | — |
| `/link/{id}/associatedlinknode/expanded` | (perItem on links) | no | — |
| `/area` | `areas` | yes | `/associatedzone`, `/associatedcontrolstation`, `/associatedareascene`, `/associatedoccupancygroup` |
| `/zone` | `zones` | yes | perItem: `/status`, `/fadesettings` |
| `/device` | `devices` | yes | perItem: `/status`, `/buttongroup/expanded`, `/firmwareimage`, `/addressedstate` |
| `/button` | `buttons` | yes | — |
| `/buttongroup` | `buttonGroups` | no | — |
| `/preset` | `presets` | no | perItem: `/presetassignment` |
| `/presetassignment` | `presetAssignments` | no | — |
| `/programmingmodel` | `programmingModels` | no | — |
| `/virtualbutton` | `virtualButtons` | no | — |
| `/occupancygroup` | `occupancyGroups` | no | `/associatedzone`, `/associatedsensor` |
| `/timeclock` | `timeClocks` | no | — |
| `/timeclockevent` | `timeClockEvents` | no | — |
| `/service` | `services` | no | — |
| `/firmware` | `firmware` | no | — |
| `/firmware/status` | `firmwareStatus` | no | — |
| `/firmwareupdatesession` | `firmwareUpdateSessions` | no | — |
| `/operation/status` | `operationStatus` | no | — |
| `/networkinterface/1` | `networkInterface` | no | — |
| `/project/contactinfo` | `projectContactInfo` | no | — |
| `/project/masterdevicelist/devices` | `masterDeviceList` | no | — |
| `/server/status/ping` | `ping` | no | — |
| `/server/leap/pairinglist` | `pairingList` | no | — |
| `/system/away` | `awayMode` | no | — |
| `/system/loadshedding/status` | `loadShedding` | no | — |
| `/system/naturallightoptimization` | `naturalLight` | no | — |
| `/facade` | `facades` | no | — |
| `/countdowntimer` | `countdownTimers` | no | — |
| `/favorite` | `favorites` | no | — |
| `/daynightmode` | `dayNightMode` | no | — |

### Walker Engine

```typescript
async function walkEndpoints(
  leap: LeapConnection,
  registry: EndpointDef[],
  opts: { full: boolean; log: LogFn }
): Promise<Record<string, any>>
```

Behavior:
1. Filter registry: include all entries if `--full`, otherwise only `core: true`
2. Iterate sequentially (no parallel requests — avoid overwhelming processor)
3. For each endpoint, call `leap.readBody(path)` — null responses silently skipped
4. For collection endpoints (non-null `itemsField`), extract items array
5. For each item with an `href`:
   - Fetch `children` (associated sub-collections, merge into item)
   - Fetch `perItem` (direct sub-resources, merge into item)
6. Log progress to stderr: `Fetching /area... 12 items` / `  /area/1/associatedzone... 3 zones`
7. Return `Record<string, any>` with raw LEAP response bodies keyed by registry `key`

Error handling: individual endpoint failures are logged and skipped (don't abort the whole walk). The walker is tolerant of 204/404/405 responses.

### Singleton Endpoints

Endpoints like `/system`, `/networkinterface/1` return a single object, not a collection. These have `itemsField: null`. The walker stores the raw response body directly under the key.

## CLI Changes

### New Flag

- `--full` — run exhaustive walk of all registry entries

### Behavior Matrix

| Flags | Behavior |
|-------|----------|
| (none) | Existing human-readable dump via `fetchLeapData` |
| `--json` | Existing JSON output via `fetchLeapData` |
| `--config` | Existing ccx config generation |
| `--save` | Existing `data/leap-{host}.json` (current format) |
| `--full` | Human-readable summary: per-endpoint item counts, total time |
| `--full --save` | Write `data/leap-{host}-full.json` |
| `--full --json` | Full JSON to stdout |

### Output Format (`--full --save`)

File: `data/leap-{host}-full.json`

```json
{
  "timestamp": "2026-04-01T...",
  "host": "10.0.0.1",
  "leapVersion": "03.247",
  "productType": "RadioRA3",
  "data": {
    "server": [ { "Type": "LEAP", "ProtocolVersion": "03.247", ... } ],
    "system": { "TimeZone": "...", ... },
    "links": [ { "href": "/link/1", "LinkType": "RF", ... } ],
    "areas": [
      {
        "href": "/area/544", "Name": "Office", "IsLeaf": true,
        "zones": [ { "href": "/zone/518", "Name": "Light", ... } ],
        "controlStations": [ ... ],
        "scenes": [ ... ],
        "occupancyGroups": [ ... ]
      }
    ],
    "devices": [
      {
        "href": "/device/2", "Name": "Dimmer", "SerialNumber": 12345,
        "status": { "Level": 100, ... },
        "buttonGroups": [ ... ],
        "firmware": { ... }
      }
    ],
    "presets": [
      {
        "href": "/preset/496", "Name": "Scene 1",
        "assignments": [ { "Zone": { "href": "/zone/518" }, "Level": 100 } ]
      }
    ],
    "occupancyGroups": [ ... ],
    "timeClocks": [ ... ],
    "services": [ ... ],
    "firmware": [ ... ],
    "networkInterface": { ... }
  }
}
```

## Code Organization

All changes in two existing files:

**`lib/leap-client.ts`** (additions):
- `EndpointDef`, `ChildDef`, `PerItemDef` type definitions
- `LEAP_REGISTRY` constant array
- `walkEndpoints()` function

**`tools/leap/leap-dump.ts`** (modifications):
- Parse `--full` flag
- When `--full`: call `walkEndpoints()` instead of `fetchLeapData()`
- When `--full --save`: write to `data/leap-{host}-full.json`
- When `--full` (no --save, no --json): print summary to stderr
- All existing code paths unchanged

No new files. No changes to `ccx/config.ts`, bridge, or any other consumer.

## Extensibility

Adding a new LEAP endpoint requires exactly one change: append an entry to `LEAP_REGISTRY`. The walker handles everything else. This is the primary design goal — make discovery results immediately actionable.

## Constraints

- Sequential requests only (no parallel) to avoid overwhelming the processor
- RA3 vs Caseta differences handled gracefully: `readBody()` returns null on 204/404/405, walker skips
- No timeout changes — existing 10s per-request timeout in `LeapConnection.send()` is sufficient
- Full dump may take 1-3 minutes depending on device count — this is acceptable
