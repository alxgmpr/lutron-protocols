---
name: Wiz dimming scaling findings
description: Lutron→Wiz percentage mapping was the main source of bridge dimming error, not ramp timing
type: project
---

The Lutron→Wiz 10% offset scaling (`10 + (pct/100)*90`) was the primary cause of bridge dim level mismatch, not the ramp rate.

**Why:** Wiz bulbs have a 10-100% dimming range while Lutron has 1-100%. The original linear mapping added a 10% floor, but this distorted level comparisons when debugging ramp accuracy. With scaling disabled, bridge matches Lutron within 1% (43% vs 44% observed on 2026-03-16).

**How to apply:**
- `wizDimScaling: false` in bridge config `defaults` disables the mapping (pass-through)
- Default is `true` (preserves the 10% floor mapping)
- Use scaling off when debugging ramp accuracy to isolate timing issues from mapping issues
- The wall-clock ramp model (21.053%/sec = 4.75s full range) is accurate — the remaining 1% error is within measurement noise
