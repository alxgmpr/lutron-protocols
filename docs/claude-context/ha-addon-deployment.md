---
name: Home Assistant add-on deployment
description: CCX-WiZ bridge deployed as HA local add-on at 10.0.0.4 with nRF dongle, full config via HA UI
type: project
---

The CCX→WiZ bridge runs as a Home Assistant local add-on on the HA machine at 10.0.0.4 (Pi5, aarch64).

**Access:** SMB at `smb://10.0.0.4` exposes `/addons`, `/config`, `/share`. SSH via HA SSH addon.

**Add-on location:** `/addons/local/ccx-bridge/` (self-contained: full source + package.json + Dockerfile)

**Config:** Entirely in HA add-on settings UI — pairings (zone_id + wiz_ips[] + warm_dimming), Thread channel/key, warm dim curve, dim scaling, WiZ port, sniffer device. Stored in `/data/options.json` by HA supervisor.

**LEAP data:** Copied to `/config/ccx-bridge/` on HA (leap-10.0.0.1.json, preset-zones.json, ccx-device-map.json). Updated via deploy script.

**Deploy workflow:**
1. Mount SMB: `open smb://10.0.0.4` → mount "config" and "addons"
2. Run `./bridge/deploy-ha.sh /Volumes/config /Volumes/addons`
3. HA UI → Settings → Add-ons → Check for updates → Rebuild
4. Configure Thread channel (25) + master key in add-on config
5. Start, check logs

**Known issues:**
- Pi5 USB autosuspend kills the nRF dongle — `run.sh` disables it at startup
- nRF dongle crashes under burst load (30+ packets/sec) — 30s watchdog auto-reconnects
- HA container naming: NOT `addon_local_ccx_bridge` — use `docker ps -a --filter "name=ccx"` to find it

**Why:** HA OS doesn't expose Docker directly — must use local add-on format in `/addons/local/`.

**How to apply:** Always use deploy script for updates. Config changes go through HA UI, not file editing.
