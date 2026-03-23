# LEAP Infrastructure Notes

## Multi-Processor Setup
- **RA3** at 10.0.0.1 (LEAP v3.247) — certs: `lutron-ra3-*`
- **Caseta** at 10.0.0.2 (LEAP v1.123) — certs: `lutron-caseta-*`

## LEAP API is Read-Write (CORRECTED 2026-02-15)
- `CreateRequest` to `/zone/{id}/commandprocessor` with `GoToLevel` returns `201 Created`
- Works on both RA3 and Caseta
- Previous note "read-only API" was wrong (was likely testing wrong endpoint)

## RA3 vs Caseta LEAP Structural Differences
| Feature | RA3 (v3.247) | Caseta (v1.123) |
|---------|-------------|-----------------|
| `/zone` direct | 405 MethodNotAllowed | 200 OK |
| `/device` direct | 204 NoContent | 200 OK |
| `/area/{id}/associatedzone` | Works (primary walk) | 204 NoContent |
| Zone→Device | Via area walk | Direct `Device.href` on zone |
| Link types | RF (CCA) + ClearConnectTypeX (CCX) | RF (CCA) only |

## Auto-Detection Logic
1. Try `/zone` — if 200 with zones → Caseta path (direct endpoints)
2. If `/zone` fails (405/204) → RA3 path (area walk)

## LEAP Serial = CCA Hardware ID (Decimal)
- Universal cross-reference between LEAP and CCA
- RA3 link data includes CCA SubnetAddress (0x82E7) and full CCX credentials (Base64)

## Code Architecture (2026-02-15)
- `tools/leap-client.ts` — shared LeapConnection + fetchLeapData() with auto-detect
- `tools/leap-dump.ts` — CLI for dumps, uses leap-client, supports `--certs`/`--save`
- `ccx/config.ts` — override mechanism via `setLeapData()`, `getSerialName()` export
- `cli/nucleo.ts` — `--update-leap` flag fetches live LEAP data at startup
- Saved data goes to `data/leap-<host>.json`
