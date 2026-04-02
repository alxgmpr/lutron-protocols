# Infrastructure & Environment Notes

## Network Topology

| Device | IP | Notes |
|--------|-----|-------|
| Designer VM | `ssh alex@192.168.64.4` | UTM Shared Network (NAT), key auth |
| Mac (from VM) | `192.168.64.1` | Stable gateway, ldproxy target |
| RA3 Processor | 10.0.0.1 | LEAP v3.247, Ethernet on managed switch |
| Caseta Bridge | 10.0.0.2 | LEAP v1.123 |
| Nucleo STM32 | 10.0.0.3 | TCP:9433 stream |

VM uses UTM Shared Network mode (NAT through Mac) — stable IPs regardless of wifi network.
Charles on VM maps Lutron auth endpoints to `192.168.64.1:3000` (ldproxy).
Managed switch supports port mirroring for LAN capture.

## LEAP Infrastructure

- Two processors: RA3 (10.0.0.1, v03.247) and Caseta (10.0.0.2, v01.123)
- LEAP API is **read-write**, `tools/leap-client.ts` auto-detects RA3 vs Caseta
- **Cloud LEAP Proxy**: `api.iot.lutron.io/api/v2/leap/{bridge-id}` relays ANY LEAP command
- **Key URL**: `/link/{id}/associatedlinknode/expanded` — ALL devices + firmware in one call
- Caseta config: tuningsettings, phasesettings, countdowntimer, presetassignment (DELAY CONFIRMED)
- RA3 links: CCX=`/link/234`, CCA=`/link/236`
- Full details: `docs/infrastructure/cloud-proxy.md`, `docs/protocols/leap.md`
- **LEAP API explorer**: `tools/leap-explore.ts` — probes 200+ endpoints, `data/leap-explore-*.json`

## IPL Protocol (Designer)

- **TLS:8902** on RA3, binary framing with `LEI@/LEIC/LEIE` markers + zlib JSON
- Certs from Designer: `certs/designer/cert_v2.pfx` = SubSystem CA (empty password)
- Generated client cert accepted by processor — connection established!
- Protocol is Designer sync (state reports), not direct device control
- LEIE = zone/device status (obj_id + property + level16), LEI@ = zlib JSON commands
- Known commands: RequestSetLEDState, RequestDatabaseSync, DeviceSetOutputLevel
- See `memory/ipl-protocol.md` for details

## Designer Model Validation

- **RA3→HW device compat gate = `TBLLINKNODEINFOLINKTYPEMAP` in SQLMODELINFO DB**
- RA3 devices missing LinkType 36 (HWQS GCU RF) → rejected during CCA pairing
- Fix: `tools/sql/patch-ra3-to-hw-linktypes.sql` — adds LinkTypes 32/34/36 (idempotent)
- Must re-run after Designer updates (SQLMODELINFO.MDF gets replaced)
- See `memory/designer-model-validation.md` for details

## Designer Project File Format

- .lut file = SQL Server backup (.bak), NOT raw MDF!
- Designer uses `BACKUP DATABASE` / `RESTORE DATABASE` (SMO)
- ILSpy: `ilspycmd -t <type> <dll> -r <dir>` (needs DOTNET_ROLL_FORWARD=LatestMajor)
- See `memory/designer-file-format.md` for details

## HW Project → RA3 Processor Injection (ACHIEVED 2026-03-03)

- **Open fresh .hw in Designer, inject RA3 addressing data via SQL, transfer to RA3 processor**
- Update 6 fields: tblProcessor (serial/MAC/IP/certs), tblProcessorSystem (certs/IPv6),
  tblLink (CCA subnet), tblPegasusLink (Thread key/PAN/channel), SerialNumberState=2
- **SerialNumberState=2 is CRITICAL** — 0=not activated (blocks transfer), 2=activated
- **Live DB + save trick CONFIRMED WORKING** for both CCX and CCA devices
- Process: update live DB → trivial UI change → save → close → reopen → transfer
- See `memory/hw-project-injection.md` for details

## ESN-QS Firmware (Unencrypted!)

- **Source**: `Energi Savr.app/FirmWare file for Demo.s19` — Motorola 68K/ColdFire, Copyright 2009
- **Device**: QSNE-2DAL-D (Energi Savr Node QS), product "ESN-QS"
- **Architecture**: M68K (Binary Ninja loaded as x86 — must re-open as M68K!)
- **QS Link Task = CCA radio** — "QS Link" is the internal name for CCA protocol
- See `memory/esn-firmware-analysis.md` for details

## Firmware Update Infrastructure

- **API**: POST `firmwareupdates.lutron.com:443/sources` (form-encoded, NOT JSON)
- Creds: `lutron-bridge` / `Lutr0n@1`, params: macid, deviceclass, coderev, datestamp
- CDN: `phoenix/final/` (RA3), `lite-heron/final/` (Caseta) on `firmware-downloads.iot.lutron.io`
- Package: ZIP with `firmware.tar.enc` (AES-128-CBC) + RSA-wrapped key + manifest
- See `docs/infrastructure/firmware-updates.md` for details

## RA3 System Internals

- Janus = RA3 processor, schema v168, 268 DB tables
- See `memory/ra3-internals.md`

## Environment Tips

- **NEVER use `st-flash`** — always use `make flash` (openocd) for STM32 programming
- **`esphome run` ALWAYS needs `--no-logs`** — otherwise it streams logs forever and blocks
- **Dev UI is ALWAYS at http://localhost:5173** — never use curl for things the web UI can do
- ESPHome compile: `esphome compile esphome/cca-proxy.yaml`
- ESPHome flash OTA: `esphome upload --device cca-proxy.local esphome/cca-proxy.yaml`

## LEAP Infrastructure

### Multi-Processor Setup
- **RA3** at 10.0.0.1 (LEAP v3.247) — certs: `lutron-ra3-*`
- **Caseta** at 10.0.0.2 (LEAP v1.123) — certs: `lutron-caseta-*`

### LEAP API is Read-Write (CORRECTED 2026-02-15)
- `CreateRequest` to `/zone/{id}/commandprocessor` with `GoToLevel` returns `201 Created`
- Works on both RA3 and Caseta
- Previous note "read-only API" was wrong (was likely testing wrong endpoint)

### RA3 vs Caseta LEAP Structural Differences

| Feature | RA3 (v3.247) | Caseta (v1.123) |
|---------|-------------|-----------------|
| `/zone` direct | 405 MethodNotAllowed | 200 OK |
| `/device` direct | 204 NoContent | 200 OK |
| `/area/{id}/associatedzone` | Works (primary walk) | 204 NoContent |
| Zone→Device | Via area walk | Direct `Device.href` on zone |
| Link types | RF (CCA) + ClearConnectTypeX (CCX) | RF (CCA) only |

### Auto-Detection Logic
1. Try `/zone` — if 200 with zones → Caseta path (direct endpoints)
2. If `/zone` fails (405/204) → RA3 path (area walk)

### LEAP Serial = CCA Hardware ID (Decimal)
Universal cross-reference between LEAP and CCA. RA3 link data includes CCA SubnetAddress (0x82E7) and full CCX credentials (Base64).

### Code Architecture (2026-02-15)
- `tools/leap-client.ts` — shared LeapConnection + fetchLeapData() with auto-detect
- `tools/leap-dump.ts` — CLI for dumps, uses leap-client, supports `--certs`/`--save`
- `ccx/config.ts` — override mechanism via `setLeapData()`, `getSerialName()` export
- `cli/nucleo.ts` — `--update-leap` flag fetches live LEAP data at startup
- Saved data goes to `data/leap-<host>.json`
