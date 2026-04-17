# Migrate Remaining Commands to Job Builders

**Date**: 2026-04-12
**Issue**: GLAB-64
**Scope**: 15 fire-and-forget CCA commands → `TdmaJobGroup` builders

## Context

The job-based TX engine (2026-04-02) replaced blocking `cca_cmd_execute()` for 4 commands: button, bridge_level, beacon, raw. The remaining 15 packet-based commands still fall through to the blocking path. This spec covers migrating all of them.

Pairing commands (PICO_PAIR, BRIDGE_PAIR, VIVE_PAIR, HYBRID_PAIR, SUBNET_PAIR, ANNOUNCE) are excluded — they require RX responses mid-sequence and are tracked in GLAB-67.

## Engine Changes

### 1. Rename `retransmits` → `tx_count`

The field currently named `retransmits` in `TdmaPhase` actually means total packet firings (engine starts at 0, fires while `current_retransmit < retransmits`). Rename to `tx_count` for clarity.

Fix existing button release from 12 → 11.

Update all references: struct field, existing builders, constants, tests.

### 2. Add `type_base` to `TdmaPacket`

```c
typedef struct {
    uint8_t data[53];
    uint8_t len;         // 22 or 51
    uint8_t type_rotate; // 0=fixed type byte, 1=rotate from type_base
    uint8_t type_base;   // base for rotation: 0x81 (short) or 0xA1 (long)
} TdmaPacket;
```

`fire_group_packet()` changes from:
```c
pkt[0] = 0x81 + (uint8_t)(g->current_retransmit % 3);
```
to:
```c
pkt[0] = phase->packet.type_base + (uint8_t)(g->current_retransmit % 3);
```

Existing builders set `type_base = 0x81`. New long-packet builders set `type_base = 0xA1`.

## TX Counts

| Command | tx_count | Notes |
|---------|----------|-------|
| Button press | 2 | Short burst to initiate |
| Button release | 11 | Fix from 12 |
| All level commands (bridge, broadcast, pico) | 11 | |
| Scene exec | 11 | |
| Beacon | 6 | |
| Unpair | 11 | |
| All config commands (LED, fade, trim, phase, dim, save_fav) | 11 | |
| Vive level | 11 | |
| Vive dim start | 2 | Short burst to initiate |
| Vive dim stop | 11 | |
| Identify | 11 | |
| Query | 11 | |
| State report | 11 | Normal TDMA sequencing |

Constants:
```c
#define CCA_TX_COUNT_BURST    2   // short burst (press, dim start)
#define CCA_TX_COUNT_BEACON   6
#define CCA_TX_COUNT_NORMAL  11   // standard (1 + 10 retransmissions)
```

## New Job Builders

### Short Packet Builders (22-byte, type_base 0x81)

**`cca_jobs_pico_level(device_id, level_pct)`**
- 1 phase, tx_count=11, type_rotate=1
- Extract packet build from `exec_pico_level()` into `cca_build_pico_level()` helper

**`cca_jobs_state_report(zone_id, level_pct)`**
- 1 phase, tx_count=11, type_rotate=1
- Normal TDMA sequencing (drop the old seq+=2 quirk)
- Extract from `exec_state_report()`

**`cca_jobs_broadcast_level(level_pct, fade_qs)`**
- 1 phase, tx_count=11, type_rotate=1
- Reuses existing `cca_build_set_level()` with `addr_mode=QS_ADDR_BROADCAST`

**`cca_jobs_scene_exec(zone_id, scene_id)`**
- 1 phase, tx_count=11, type_rotate=1
- Extract from `exec_scene_execute()`

**`cca_jobs_unpair(zone_id)`**
- 1 phase, tx_count=11, type_rotate=1
- Beacon format, extract from `exec_unpair()`

### Long Packet Builders (51-byte, type_base 0xA1)

All config commands share the same structure: 1 phase, tx_count=11, type_rotate=1, type_base=0xA1.

**`cca_jobs_led_config(zone_id, target_id, led_mode)`**
- Single zone (no alternation — that was an early assumption)
- Extract from `exec_led_config()`

**`cca_jobs_fade_config(zone_id, target_id, fade_on_qs, fade_off_qs)`**
- Extract from `exec_fade_config()`

**`cca_jobs_trim_config(zone_id, target_id, high_trim, low_trim)`**
- Extract from `exec_trim_config()`

**`cca_jobs_phase_config(zone_id, target_id, phase_byte)`**
- Extract from `exec_phase_config()`

**`cca_jobs_save_fav(zone_id, target_id)`**
- Extract from `exec_save_fav()`

**`cca_jobs_dim_config(zone_id, target_id)`**
- Extract from `exec_dim_config()`

### Vive Builders (51-byte, type_base 0xA1, LE byte order)

**`cca_jobs_vive_level(zone_byte, device_id, level_pct, fade_qs)`**
- 1 phase, tx_count=11, type_rotate=1
- Extract from `exec_vive_level()`

**`cca_jobs_vive_dim(zone_byte, device_id, direction)`**
- 2 phases:
  - Phase 0 (start): tx_count=2, type_rotate=1
  - Phase 1 (stop): tx_count=11, type_rotate=1
- Extract from `exec_vive_dim()`

### QS Link Builders (51-byte, type_base 0xA1)

**`cca_jobs_identify(zone_id, target_id)`**
- 1 phase, tx_count=11, type_rotate=1
- Extract from `exec_identify()`

**`cca_jobs_query(zone_id, target_id)`**
- 1 phase, tx_count=11, type_rotate=1
- Extract from `exec_query()`

## Routing

All 15 commands added to `cca_cmd_to_jobs()` switch in `cca_commands.cpp`. After migration, the only commands still hitting the blocking fallback are the 6 pairing commands (GLAB-67).

## Packet Builder Helpers

Extract inline packet construction from each `exec_*()` into named helpers in `cca_tx_builder.h`:

- `cca_build_pico_level(buf, device_id, level16)` — 22 bytes
- `cca_build_state_report(buf, zone_id, level16)` — 22 bytes
- `cca_build_scene_exec(buf, zone_id, scene_id)` — 22 bytes
- `cca_build_unpair(buf, zone_id)` — 22 bytes
- `cca_build_led_config(buf, zone_id, target_id, led_mode)` — 51 bytes
- `cca_build_fade_config(buf, zone_id, target_id, fade_on_qs, fade_off_qs)` — 51 bytes
- `cca_build_trim_config(buf, zone_id, target_id, high_trim, low_trim)` — 51 bytes
- `cca_build_phase_config(buf, zone_id, target_id, phase_byte)` — 51 bytes
- `cca_build_save_fav(buf, zone_id, target_id)` — 51 bytes
- `cca_build_dim_config(buf, zone_id, target_id)` — 51 bytes
- `cca_build_vive_level(buf, zone_byte, device_id, level16, fade_qs)` — 51 bytes
- `cca_build_vive_dim_start(buf, zone_byte, device_id, direction)` — 51 bytes
- `cca_build_vive_dim_stop(buf, zone_byte, device_id, direction)` — 51 bytes
- `cca_build_identify(buf, zone_id, target_id)` — 51 bytes
- `cca_build_query(buf, zone_id, target_id)` — 51 bytes

Existing helpers (`cca_build_set_level`, `cca_build_beacon`, `cca_build_button_short`, `cca_build_button_long`) stay as-is.

## Cleanup

After all 15 commands are migrated:
- Delete the 15 `exec_*()` functions from `cca_commands.cpp`
- Remove old retry constants (`CCA_TDMA_RETRIES_LEVEL`, etc.) replaced by `CCA_TX_COUNT_*`
- The blocking `cca_cmd_execute()` switch shrinks to only pairing cases

## Testing

Unit test each new builder: verify packet bytes match expected layout, correct tx_count, correct type_base. Follow the existing test pattern in `firmware/test/`.
