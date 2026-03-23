---
name: wiz-bulb
description: Wiz smart bulb at 10.0.0.50 — UDP protocol details, bridged to Lutron zone 5147
type: project
---

Wiz bulb at **10.0.0.50** bridged to Lutron CCX zone 5147 (Hallway Table Lamp).

- MAC: `a0b1c2d3e4f7`, homeId: `12345678`, module: `ESP24_SHRGB_01`, firmware: `1.36.1`
- UDP port 38899, JSON protocol
- `setPilot` for instant level control, `getPilot` for state query
- `setEffect` with `preview`/`pulse` works over UDP (temporary state, turns off first before transitioning)
- `setUserConfig` (fadeIn/fadeOut) only works via MQTT, not UDP
- Min dimming: 10% (values below accepted but visually clamp to 10%)
- Config: `data/virtual-device.json`, bridge: `tools/ccx-bridge.ts`, test: `tools/wiz-test.ts`

## Dimming Scale
- Bridge scales Lutron 1-100% → Wiz 10-100% linearly: `wiz = 10 + (lutron/100) * 90`
- 0% = off (`state: false`), no dead zone

## CCX DIM_HOLD/DIM_STEP Protocol
- `DIM_HOLD` = hold start, `DIM_STEP` = hold release
- action=2 = lower, action=3 = raise
- App-triggered holds carry zone ID in body key 1 (same as LEVEL_CONTROL)
- Pico-triggered holds carry device/preset ID only (no zone) — resolved via `presetToZone` config
- `stepValue` in DIM_STEP correlates with hold duration (~1000/sec from pico, 0 from app)

## Ramp Rate
- **Lutron ramp = 20%/sec (5s for 0→100%)** — confirmed via LEAP timing tests
- LEAP measurements showed ~21.1%/sec but the extra ~1%/sec is LEAP command latency (~50-70ms per round-trip), not actual rate
- Raise and lower use the same rate
- Rate is constant regardless of starting level
- Lower floor = 1% (not off — off is a separate command)
- Bridge ramp: 2%/100ms interval, stops at 1% floor or 100% ceiling

## Pico Button Support
- `presetToZone` config maps LEAP preset IDs → zone IDs
- BUTTON_PRESS On/Off → dispatch 100%/0%
- DIM_HOLD Raise/Lower with no zone → resolved via preset lookup
- Hallway Table pico: presets 4163(On)/4166(Raise)/4169(Lower)/4172(Off) → zone 5147

## MQTT Setup (for fadeIn/fadeOut config)
- DNS redirect `eu.mqtt.wiz.world` → local mosquitto with self-signed TLS on port 8883
- Bulb connects as `a0b1c2d3e4f7_12345678`
- Publish to `OP/pro/12345678/devices/a0b1c2d3e4f7`
- `userConfigTs` must be incremented each call
- Confirmed working on fw 1.28-1.30, untested on 1.36.1

**Why:** First third-party device bridged from Lutron CCX via sniffed Thread traffic.
**How to apply:** Use this IP and zone mapping when running the CCX bridge or testing Wiz control.
