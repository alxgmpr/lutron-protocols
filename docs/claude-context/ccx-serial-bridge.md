---
name: CCX serial bridge architecture
description: Direct serial nRF sniffer driver, HA add-on deployment, watchdog, Docker containerization
type: project
---

The CCX→WiZ bridge captures Lutron Thread traffic via nRF sniffer dongle (direct serial) and forwards commands to WiZ bulbs.

**Architecture:**
- `lib/serial-sniffer.ts` — serial driver (115200 baud, text protocol: `sleep` → `shell echo off` → `channel N` → `receive`)
- `lib/frame-pipeline.ts` — raw 802.15.4 frame → parse → decrypt (AES-128-CCM*) → CBOR decode → CCXPacket
- `lib/bridge-core.ts` — transport-agnostic dedup, zone match, scene resolve, WiZ UDP dispatch
- `bridge/main.ts` — entry point, reads HA options.json OR YAML config file
- `bridge/ha-addon/` — Home Assistant local add-on (config.yaml, Dockerfile, run.sh)
- `bridge/Dockerfile` + `docker-compose.yml` — standalone Docker (node:22-slim)

**HA Add-on (deployed to 10.0.0.4):**
- Full config in HA UI — pairings, Thread creds, warm dim, scaling all in `config.yaml` options/schema
- `main.ts` reads `/data/options.json` directly via `loadBridgeConfigFromOptions()`
- YAML config file (`config/ccx-bridge.yaml`) is fallback for standalone Docker/local dev only
- Deploy: `./bridge/deploy-ha.sh /Volumes/config /Volumes/addons` (copies source + LEAP data via SMB)
- LEAP data goes to `/config/ccx-bridge/` (CCX_DATA_DIR), NOT the add-on dir
- `run.sh` disables USB autosuspend before exec (prevents Pi from power-cycling dongle)

**Sniffer watchdog:**
- 30-second timeout — if no frames arrive, force-close port and reconnect
- Fixes silent dongle death on Pi5 (nRF resets under burst load of 30+ packets/sec)
- Thread mesh is always chatty; 30s silence = dongle died

**Key details:**
- nRF sniffer outputs ANSI escape codes (`\x1b[J`) before `received:` lines — must strip before regex match
- EUI-64s learned from unencrypted extended-source frames; encrypted multicast CCX traffic has extended source addresses and CAN be decrypted
- Short-address unicast frames (processor↔device) can't be decrypted — bridge doesn't need them (CCX commands are multicast)

**Why:** Laptop sleep kills tshark, RPi/HA deployment needs minimal deps. Serial mode is faster and self-contained.

**How to apply:** Use HA add-on for production deployment. Standalone Docker/YAML for dev. tshark mode is legacy.
