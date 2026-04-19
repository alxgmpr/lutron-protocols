# LEAP Server RE — `multi-server-phoenix.gobin`

Reverse-engineered inventory of the RA3 processor's LEAP HTTP server. Source:
`data/firmware/phoenix/v26.01.13f000/usr/sbin/multi-server-phoenix.gobin`
(30 MB stripped Go ELF, ARM, Go 1.23.8).

## Why this matters

Our hand-built `LEAP_REGISTRY` (in [`lib/leap-client.ts`](../../lib/leap-client.ts))
was assembled by probing endpoints we guessed or saw in LEAP captures. It covers
~43 paths. The real server surface is **~410 paths** across GET, SUBSCRIBE,
UPDATE, CREATE, and DELETE.

The binary retains enough Go metadata (in `gopclntab`) to recover:
- **410 route identifiers** with their HTTP verbs, via `leap/resource.*` function names
- **636 `leapobj.*` response struct definitions** with full field types
- **161 routes auto-linked to their response schema**

## Extraction pipeline

```bash
# 1. Symbol recovery from stripped Go binary
git clone --depth 1 https://github.com/mandiant/GoReSym.git /tmp/GoReSym
cd /tmp/GoReSym && go build -o /tmp/GoReSym .
/tmp/GoReSym -t -d -p data/firmware/phoenix/v26.01.13f000/usr/sbin/multi-server-phoenix.gobin > /tmp/goresym.json

# 2. Derive routes + schemas
python3 tools/leap-registry-from-binary.py /tmp/goresym.json
# Writes data/firmware-re/leap-routes.json and data/firmware-re/leap-types.json
```

## Naming conventions in the binary

Route handlers live in package `leap/resource` and follow a strict verb-prefix
convention:

| Function prefix | HTTP verb |
|---|---|
| `BodyAndMessageTypeFor<X>` | GET |
| `Subscribe<X>` | SUBSCRIBE (long-polled updates) |
| `Update<X>` | UPDATE (PUT) |
| `Create<X>` / `Add<X>` | CREATE (POST) |
| `Delete<X>` | DELETE |

The `<X>` suffix encodes the URL path, with `ID`/`XID` markers denoting path
parameters. Example:

```
BodyAndMessageTypeForAreaIDStatus   →  GET /area/{id}/status
SubscribeAreaID                     →  SUBSCRIBE /area/{id}
UpdateAreaIDTuningSettings          →  UPDATE /area/{id}/tuningsettings
```

Response body structs live in package `leapobj` and share the name (with `ID`
markers stripped):

```
leap/resource.BodyAndMessageTypeForAreaIDStatus  →  leapobj.AreaStatus
```

## Output artifacts

### `data/firmware-re/leap-routes.json`

Array of `{ident, path, verbs, handlers, responseType}` — one entry per unique
route identifier. Example:

```json
{
  "ident": "AreaIDStatus",
  "path": "/area/{id}/status",
  "verbs": ["GET", "SUBSCRIBE"],
  "handlers": {
    "GET": "leap/resource.BodyAndMessageTypeForAreaIDStatus",
    "SUBSCRIBE": "leap/resource.SubscribeAreaIDStatus"
  },
  "responseType": "AreaStatus"
}
```

### `data/firmware-re/leap-types.json`

Map of `leapobj.<Name>` → reconstructed Go struct source. Gives us the exact
response shape including pointer-vs-value (optional fields), nested types, and
slices. Example:

```go
type leapobj.AreaStatus struct {
    HyperReference leapobj.HyperReference
    Level      *float64
    OccupancyStatus leapobj.OccupancyStatus
    InstantaneousPower *uint32
    InstantaneousMaxPower *uint32
    CurrentScene **leapobj.HyperReference
}
```

## What's in the binary that we don't walk today

| Top-level segment | New paths | Notable |
|---|---|---|
| `/service/*` | 41 | Alexa, HomeKit, Google Home, IFTTT, Ketra, Nest, SmartThings, NTP, Sonos adapters |
| `/preset/*` | 26 | preset assignment CRUD, `/preset/{id}/presetassignment` |
| `/area/*` | 25 | `/area/{id}/status` (SUBSCRIBE), occupancy/daylight/tuning/relation subtrees |
| `/zone/*` | 16 | `/zone/{id}/tuningsettings` (UPDATE), `/zone/{id}/phasesettings` (UPDATE), `/zone/{id}/expandedstatus` |
| `/device/*` | 15 | `/device/{id}/availability`, `/device/{id}/batterystatus` |
| `/zonetypegroup/*` | 9 | loadshedding + emergencysettings per group |
| `/link/*` | 9 | status subtree, `/linknodeassociation` |
| `/loadcontroller/*` | 5 | subscribable status |
| `/occupancysensor/*` | 5 | profile sessions, sensor settings |
| `/timeclock/*` + `/timeclockevent/*` | 11 | full CRUD on schedules |

### Particularly interesting discoveries

- **`/databasetransfersession` (DELETE,GET)** — programmatic database backup/restore session.
- **`/lutronintegrationprotocol` (GET,UPDATE)** — LIP (telnet port 23) may be toggleable via LEAP.
- **`/clientsetting` (GET,UPDATE)** — per-client config the processor stores.
- **`/paireddeviceextractionsession`** — device extraction workflow.
- **`/rssidiscoverysession`** — RSSI-based discovery (Caseta-style?).
- **`/legacyserverstatusping`** — legacy `/server/status/ping` predecessor.
- **Subscribable area/zone/link statuses** — we could stream state changes instead of polling.

## Known extraction limitations

- **Query-mode variants collapse.** Function names like `AreaWithExplicitPaging` /
  `ZoneStatusExpandedQueryStringWithImplicitPaging` describe paging/query params
  rather than URL segments. These currently appear in the output as literal paths
  but aren't real routes — verify against a live processor before adding to the
  registry.
- **Dictionary segmentation gaps.** A few identifiers without `ID` markers
  concatenate cleanly in the binary (e.g. `arealoadshedding` — real path is
  `/area/loadshedding`) because the tokenizer couldn't split them. Add missing
  segments to `build_dictionary()` in `tools/leap-registry-from-binary.py`.
- **249/410 routes unmapped to `leapobj`.** These typically return collections of
  HyperReferences or use compound types (e.g. `AreaIDAssociatedZone` returns
  a list, not a type called `AreaAssociatedZone`). Adding heuristics for
  `...Associated...`, `...Summary`, etc. could recover more.

## Next steps

1. Cross-validate the 240 high-value new paths against a live RA3.
2. Expand `LEAP_REGISTRY` to include genuinely-useful additions (subscribable
   statuses first — they unlock streaming dumps).
3. Generate TypeScript response interfaces from `leap-types.json` so
   `walkEndpoints` can return typed data instead of `any`.
4. The `polarisarch/proto/dom/*` packages are the gRPC-backed domain model —
   worth a separate pass for CREATE/UPDATE body schemas.
