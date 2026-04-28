# CCA TDMA Timing and Beacon Scheduling

CCA's MAC layer is a slotted TDMA built on top of the 433 MHz async-serial PHY. Devices share one channel by claiming an N-of-8 slot window, and retransmissions of the same payload are placed exactly one frame period apart so the slot stays consistent across the burst. This page documents the slot/frame parameters, the BEACON_91/92/93 lifecycle, ACK/retry timing, and what we know vs. what remains unconfirmed.

The canonical reference for everything below is our STM32H723 firmware:

- [firmware/src/cca/cca_tdma.h](../../firmware/src/cca/cca_tdma.h) — public API + named constants
- [firmware/src/cca/cca_tdma.cpp](../../firmware/src/cca/cca_tdma.cpp) — engine implementation
- [firmware/src/cca/cca_timer.c](../../firmware/src/cca/cca_timer.c) — TIM2 hardware tick source
- [firmware/src/cca/cca_task.cpp](../../firmware/src/cca/cca_task.cpp) — RX/TX scheduling glue
- [firmware/src/cca/cca_auto_pair.cpp](../../firmware/src/cca/cca_auto_pair.cpp) — Vive beacon transmitter
- [firmware/src/cca/cca_commands.cpp](../../firmware/src/cca/cca_commands.cpp) — `cca_jobs_beacon()` for 0x91/0x92/0x93
- [firmware/src/cca/cca_tx_builder.h](../../firmware/src/cca/cca_tx_builder.h) — `cca_build_beacon()` payload format
- [firmware/tests/test_tdma.cpp](../../firmware/tests/test_tdma.cpp) — slot/seq invariants

For protocol-side context (packet types, RF parameters), see [cca.md](cca.md). For 35-channel hop hypothesis, see [firmware-re/powpak.md §"Frequency hopping table (suspected)"](../firmware-re/powpak.md#frequency-hopping-table-suspected).

## 1. Headline numbers

| Parameter | Value | Source |
|-----------|-------|--------|
| Slot count | **8** (`slot_mask = 7`) | `CCA_TDMA_DEFAULT_SLOT_MASK` |
| Frame period | **75 ms** | `CCA_TDMA_DEFAULT_FRAME_MS` |
| Slot duration | **9.375 ms** (75 ms / 8) | `CCA_TDMA_SLOT_DURATION_US = 9375` |
| Per-seq increment | **12.5 ms** | `SLOT_MS_X2 = 25` (half-ms units) in `cca_tdma.cpp` |
| Frame rate | **~13.3 Hz** | derived |
| Slot mask in seq byte | low 3 bits of `seq` | `tdma_seq_low_bits_encode_slot` test |
| Retransmit count: button-tap burst | 2 | `CCA_TX_COUNT_BURST` |
| Retransmit count: beacon | 6 | `CCA_TX_COUNT_BEACON` |
| Retransmit count: standard (level/scene/etc.) | 11 (1 + 10) | `CCA_TX_COUNT_NORMAL` |
| Retransmit cadence | one packet per frame | `fire_job` schedules `next + period_ms` |
| Burst length: 11 retransmits | ~825 ms (11 × 75 ms) | derived |
| Frame-sync confidence floor for slot use | 40 / 100 | `FRAME_SYNC_MIN_CONF` |
| Stale device eviction | 1.2 s | `STALE_MS = 1200` |

The hardware tick base is **TIM2 at 100 kHz** (10 µs resolution) — see `cca_timer.c`. Slot scheduling itself runs off `HAL_GetTick()` (1 ms FreeRTOS tick); TIM2 is reserved for one-shot precise compare callbacks.

## 2. Slot encoding in the sequence byte

The CCA `seq` byte (offset 1 of every packet) carries two pieces of information packed together:

```
seq[7:3] = retransmission counter (incremented by slot_count per retransmit)
seq[2:0] = slot number (0..7)
```

A device that claims slot 6 and emits 4 retransmits of the same payload puts these values in `seq`:

```
6, 14, 22, 30, ...
^   ^   ^   ^
slot slot slot slot   (low 3 bits always 6)
```

This is why `device_slot(d) = d.last_seq & frame_.slot_mask` is sufficient to recover a device's slot from any single packet, and why retransmissions of one logical payload preserve identity.

Stride = slot_count = 8 (not the slot number) — see `tdma_seq_stride_equals_slot_count` test. Earlier captures showing seq increments of **+6** were observations of a stride that happened to equal the device's slot number; the engine implements the universal `stride = slot_count` rule.

## 3. Frame sync model (RX side)

Every CRC-valid RX packet feeds `cca_tdma_on_rx()`, which does two things:

1. **Per-device slot tracker** (`observe_device`). Maintains an EMA of the timing error `(dt_ms × 2) − (12.5 ms × dseq)`. Confidence is a weighted blend of (a) good-sample rate (≤ 2.5 ms error), (b) error magnitude relative to a 6 ms scoring span, and (c) sample count up to a `WARMUP_SAMPLES = 8` floor.
2. **Global anchor** (`update_frame_sync`). Computes `inferred_anchor = rx_ts − slot × 9.375 ms` and folds it into `frame_.anchor_ms` with a 0.2 weight (5× exponential smoothing). Only deltas within ±500 ms are accepted, so a single garbage observation cannot wreck the lock.

Once `frame_.confidence ≥ 40`, `next_slot_time(slot, now)` deterministically picks the next absolute ms timestamp on which our chosen slot will recur. Below 40, the engine falls back to "fire now, then `now + 75 ms`" — the slot still lines up over time because the modular arithmetic eventually re-anchors.

## 4. TX scheduling (TX side)

`cca_tdma_submit()` for one-shot jobs and `cca_tdma_submit_group()` for multi-phase commands follow the same loop:

1. If `our_slot_valid` is false, call `pick_tx_slot(now)` — find the lowest-numbered slot that is **not** in the current occupancy bitmap (devices with confidence > 30, plus our own active jobs). All-occupied falls back to the slot of the device with the oldest `last_seen_ms`.
2. Schedule `next_fire_ms = next_slot_time(slot, now)`.
3. On each `cca_task` poll, fire any job whose `next_fire_ms ≤ now`. Firing reschedules `next_fire_ms = previous_next + 75 ms` (NOT `now + 75 ms`) — this preserves spacing across the ~5 ms TX duration; only on excessive drift do we fall back to `next_slot_time()`.
4. After `retries_total` packets the job completes and a callback fires.

`cc1101_stop_rx()` brackets each `transmit_one()` call, with `cc1101_start_rx()` immediately after — there is no half-duplex idle gap beyond the radio's own RX→TX→RX state transitions. The poll loop runs at **2 ms** baseline and tightens to **1 ms** within ±7 ms of any due fire (`should_hot_poll`).

High-priority jobs (e.g. pairing handshake responses, `req->priority > 0`) bypass slot waiting — `next_fire_ms = now` — see `cca_tdma_submit()`.

## 5. Beacon types and lifecycle

The CCA bridge sends three beacon packet types, all 24 bytes (22 + CRC), `format = 0x0C` ([cca_tx_builder.h `cca_build_beacon`](../../firmware/src/cca/cca_tx_builder.h)):

| Type | Name | Role | Source |
|------|------|------|--------|
| **0x91** | `BEACON_91` (`PKT_BEACON_91`) | Pairing-mode beacon | `cca_jobs_beacon(zone, 0x91)` |
| **0x92** | `BEACON_STOP` | Pairing-mode terminator | `PKT_BEACON_STOP` |
| **0x93** | `BEACON_93` | Initial pairing beacon | `cca_generated.h` |

### 5.1 0x91/0x92/0x93 (Caseta/RA3 bridge pairing)

Layout (`cca_build_beacon`):

```
offset  0: type       (0x91 | 0x92 | 0x93)
offset  1: seq        (low 3 bits = slot)
offset  2: load_id    (4 B BE — bridge zone/load ID)
offset  6: protocol   (QS_PROTO_RADIO_TX = 0x00)
offset  7: format     (QS_FMT_BEACON = 0x0C)
offset 22: CRC-16     (poly 0xCA0F, BE)
```

Submitted as a TDMA job group with `tx_count = CCA_TX_COUNT_BEACON = 6` and no `post_delay_ms`, so the bridge emits **6 packets at one-frame spacing = ~450 ms total per `pairing_beacon` invocation**. The protocol-TS `pairing_beacon` sequence ([protocol/cca.protocol.ts](../../protocol/cca.protocol.ts)) describes the steady-state with `count: null, intervalMs: 65` — meaning the bridge re-arms the burst continuously while pairing is active, with empirically ~65 ms between groups. (60–75 ms intervals across `intervalMs` entries reflect observed jitter against the 75 ms canonical period.)

### 5.2 0xBB (Vive hub beacon)

Vive uses a **53-byte format** with `pkt[7] = QS_FMT_LED (0x11)` and a timer byte at offset 24. See `cca_auto_pair.cpp::submit_beacon_group()`:

| Byte 24 | Meaning |
|---------|---------|
| 0x3C | "Pairing active" (60 in decimal — likely a 60 s timer hint to listeners) |
| 0x00 | "Pairing stopped" — `submit_stop_beacon()` |

This group runs `tx_count = 10`, with `beacon_complete()` re-submitting the group as soon as the previous burst finishes — a continuous loop until `cca_auto_pair_stop()` cancels via `cca_tdma_cancel_groups()` and emits a final `tx_count = 3` stop beacon.

### 5.3 Aggregate beacon period

The actual on-air **per-packet period is exactly 75 ms** (one TDMA frame) regardless of beacon type. What varies is whether the bridge:

- **Bursts** (BEACON_91 × 6, then idle until next caller), or
- **Loops** (BB Vive beacon, re-submitted by `beacon_complete`).

There is no separate "beacon period" register — beacon traffic is just normal TDMA TX with chosen `tx_count` and resubmission policy.

## 6. ACK / retry timing

CCA does not use per-packet stop-and-wait acknowledgement. Reliability comes from **redundant retransmission across one slot**:

- Standard commands (`CCA_TX_COUNT_NORMAL = 11`) fire 11 copies over ~825 ms.
- Short bursts (`CCA_TX_COUNT_BURST = 2`) fire 2 copies over ~150 ms.
- Beacons (`CCA_TX_COUNT_BEACON = 6`) fire 6 copies over ~450 ms.

Dimmers do emit explicit `0x0B` ACK packets after receiving level/scene commands (counted by `cca_ack_count()` in `cca_task.cpp`), but the sender does **not** short-circuit retransmits when an ACK arrives — the full 11-packet train always plays out. There is therefore no "ACK window" or RTO in the classical sense; the next retry is unconditionally `previous_fire + 75 ms`.

Multi-phase commands (e.g. unpair: prepare→beacon) use `post_delay_ms` between phases. From `cca_jobs_unpair`: phase 0 fires 2 packets, then waits **800 ms**, then phase 1 fires 11 packets. From `cca_auto_pair.cpp::submit_config_group`: phase 0 (B9 accept) fires 5 packets then waits **200 ms** before the dimming-cap config phase.

## 7. Channel hopping

**Our STM32H723 firmware does not hop channels.** It camps on `CHANNR = 26` (433.602844 MHz) and never reprograms `FREQ2/1/0` mid-operation. There is no per-frame, per-beacon, or per-slot hop logic in `cca_tdma.cpp`, `cc1101.c`, or `cca_task.cpp`.

The 35-channel hop table at PowPak BN `0x9B30-0x9B7F` ([powpak.md](../firmware-re/powpak.md)) and the hop sequence used by the **firmware-update transport** are a separate code path from the runtime CCA MAC documented here — see [cca.md §10 (CCA OTA)](cca.md). Runtime CCA stays single-channel.

The "two-way devices auto-switch channels; one-way devices must be re-channeled manually" behavior in the field refers to **channel reassignment at provisioning time** (programmed into the device's NV memory by the bridge during transfer), not in-band TDMA-aligned hopping. A two-way dimmer learns its assigned channel from a configuration packet during the activation sequence; one-way Picos and sensors have no return path to receive that configuration, so they ship locked to the channel their HCS08/STM8 ROM was provisioned with.

## 8. Sleep / wake scheduling for one-way devices

Picos and battery sensors do not run continuous RX; they wake on user input and TX. The slot a Pico picks comes from its hardware ID hashed into `[0..7]` (per device firmware) and survives across wakes because `seq[2:0] = slot` is computed at packet build time — there is no continuous frame counter to maintain across deep-sleep events.

The engine's per-device tracker handles re-acquisition cleanly: when a sleeping device first transmits after a long quiet period, its `TdmaDeviceSlot` is allocated (or reclaimed from `STALE_MS = 1200 ms` eviction), the first packet only sets `have_anchor`, and from the second packet onward the EMA error tightens to a confident slot lock within `WARMUP_SAMPLES = 8` good observations (~1 second of activity).

## 9. Multi-link coordination

When two bridges operate on different channels (multi-processor home), they do not coordinate TDMA frames at all — they are on different RF carriers and never observe each other's traffic. Each bridge runs an independent frame anchor.

When two bridges share a channel (rare; typically only during testing), the engine's `pick_tx_slot()` will see the second bridge's beacon traffic as occupied slots and steer our TX into a free slot. There is no explicit "leader election" — slot selection is purely first-free-fit. If both bridges genuinely need slot 0 (e.g. all 8 slots otherwise occupied), the older-device tiebreaker reuses the slot of whichever device hasn't transmitted recently.

## 10. Phoenix EFR32 cross-check (unconfirmed)

The Phoenix CCA coprocessor binaries at [data/firmware/phoenix-device/coprocessor/phoenix_efr32_*.bin](../../data/firmware/phoenix-device/coprocessor/) are **fully stripped** (no debug strings, no symbol table; verified via `strings -n 6 | grep` returning empty for any of `tdma`, `slot`, `beacon`, `frame`, `hop`, `chann`). A pure static read of timing constants from these images is inconclusive: 75 ms, 70 ms, 65 ms, etc. all appear hundreds of times as Thumb-2 immediates, indistinguishable from unrelated 8-bit operands.

We did import `phoenix_efr32_8003000-801FB08.bin` into a scratch Ghidra project (`/tmp/tdma-scratch`, base 0x08003000, ARM:LE:32:Cortex) for completeness; auto-analysis identified ~hundreds of functions but none with a name suggestive of the TDMA path. Confirming the EFR32 frame period would require either tracing the TIMER0–3 / RTC peripheral writes back to a beacon-emitting code path, or sniffing the EFR32 in-system with a logic analyzer — neither is in scope here.

What we **can** assert:

- The on-air protocol is identical (same packet shapes, same seq-byte slot encoding — verified by capture against any RA3 system).
- Therefore the EFR32 coprocessor must observe a 75 ms / 8-slot frame on RX to coexist with field devices.
- Whether its TX scheduler also rounds to exactly 75 ms or runs slightly faster/slower with anchor-snapping is unconfirmed but immaterial at the protocol level: any participant that places retransmits one frame apart and respects the slot mask interoperates.

## 11. Summary — what we definitively know

| Question | Answer | Confidence |
|----------|--------|------------|
| Slot duration (µs) | **9375** | High — `CCA_TDMA_SLOT_DURATION_US`, validated by `test_tdma.cpp` |
| Frame period (ms) | **75** | High — `CCA_TDMA_DEFAULT_FRAME_MS` |
| Slot count | **8** | High — `CCA_TDMA_DEFAULT_SLOT_MASK + 1` |
| Per-seq increment | **12.5 ms** | High — `SLOT_MS_X2 = 25` half-ms |
| Beacon TX count per burst (0x91-0x93) | **6** | High — `CCA_TX_COUNT_BEACON` |
| Beacon group repeat | continuous while pairing | High — `cca_auto_pair.cpp::beacon_complete` |
| Beacon payload format (0x91-0x93) | 22 B with `format=0x0C`, load_id at [2..5] | High — `cca_build_beacon()` |
| Beacon payload format (0xBB Vive) | 51 B with `format=0x11`, timer at [24] | High — `submit_beacon_group()` |
| ACK window | none — 11-packet train always plays | High — `fire_job()` has no ACK branch |
| Retry interval | one frame (75 ms) | High — `next_fire_ms + period_ms` |
| Channel hop cadence (runtime CCA) | none | High — single-channel by inspection |
| Channel hop cadence (firmware update) | unknown, separate code path | Out of scope here |
| EFR32 frame period matches | likely yes by interoperability | Medium — not confirmed by static RE |
