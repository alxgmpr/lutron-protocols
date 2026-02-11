# Scene Config Discovery: Format 0x1A Fade & Delay

## Discovery Summary

On 2026-02-10, we cracked the CCA scene configuration protocol (format 0x1A), which programs per-device fade and delay times for scene recall. This required significant improvements to the RTL-SDR decoder to reliably decode 53-byte packets.

**Result**: Fade and delay are encoded as **uint16 big-endian quarter-seconds** at bytes 28-31 of a 53-byte format 0x1A config packet.

## The Problem

We knew from RA3 scene captures that fade and delay were configurable (the Lutron Designer app lets you set both per-device per-scene, in 0.25-second increments up to 4 hours). But we couldn't find where they were encoded:

- **Format 0x0B** (scene trigger): identical payloads regardless of fade/delay settings. Bytes 16-18 vary but are a scene revision hash, not parameters.
- **Format 0x0D** (scene definition): completely static across all captures. Just a preset identifier.
- **Format 0x1C** (default fade config): only has fade-on/fade-off, no delay field.

The actual config had to be in a packet type we weren't capturing cleanly.

## What Was Missing: 53-Byte A3 Packets

CC1101 captures showed format 0x1A packets but **truncated to 24 bytes** — the CC1101 was only capturing the header. The full packet is 53 bytes (51 data + 2 CRC), and the fade/delay values live at bytes 28-31, past the truncation point.

RTL-SDR captures contained the full packets, but the decoder was failing to decode them (0 CRC-OK for any 53-byte packet across 4 captures).

## RTL-SDR Decoder Improvements

Three issues prevented 53-byte packet decoding:

### 1. Burst Onset Transients Skewing Threshold

When an RF burst begins, the FM discriminator produces large transient swings (typically ±1.0) for the first ~10 bit periods. The actual data signal is much smaller (±0.08). The old code computed the bit-decision threshold from only the 16-bit preamble region, which often fell within this transient, resulting in a threshold 5-10x too high for the data.

**Fix**: Compute threshold from a 100-bit-period window (preamble + early data), which dilutes the transient's effect.

### 2. False Preamble Lock on Transients

The transient oscillations resembled the alternating preamble pattern, causing the correlator to lock onto a position several bits before the actual preamble. This consumed the entire burst search window (700+ bits), preventing the real preamble from being found.

**Fix**: Amplitude consistency check — reject preamble candidates where FM values vary by >40% of signal swing. Real preambles have <10% variation; transients have 60%+.

### 3. Polarity Ambiguity

The alternating preamble pattern (101010...) is self-complementary when phase-shifted by one bit. The preamble detector sometimes chose the wrong polarity, causing the sync byte (0xFF) to appear as 0x00 — and packet extraction to fail.

**Fix**: When sync/prefix extraction fails, retry with all bits flipped.

### Results

| Metric | Before | After |
|--------|--------|-------|
| 53-byte CRC OK | 0 | 6/6 across 3 captures |
| Overall CRC rate (1s/0s capture) | 6 | 48 |
| Decode rate | ~20% | 100% (all bursts decoded) |

## Format 0x1A Packet Layout

```
Byte   Value      Description
─────  ─────────  ─────────────────────────────────
 0     A1/A2/A3   Type (rotating counter)
 1     01         Sequence
 2-5   zone LE    Bridge zone (little-endian)
 6     21         Protocol marker
 7     1A         Format: scene config
 8     00         Zero
 9-12  device ID  Target (big-endian)
13     FE         Command prefix
14     06         Config class
15     40         Component: scene (not 0x50 dimmer!)
16-17  00 00      Zero
18     0C         Static
19     50         Dimmer marker
20-21  EF 20      Static
22     00         Zero
23     02/03      Packet number (first=02, second=03)
24     09         Static
25     02         Static
26-27  FE FF      Static
28-29  uint16 BE  *** FADE TIME (quarter-seconds) ***
30-31  uint16 BE  *** DELAY TIME (quarter-seconds) ***
32-33  00 00      Zero
34-50  CC         Padding
51-52  CRC        CRC-16 over bytes 0-50
```

### Confirmed Values

| Setting | Bytes 28-29 (fade) | Bytes 30-31 (delay) |
|---------|-------------------|---------------------|
| 1s fade, 0s delay | `00 04` (4 qs) | `00 00` (0 qs) |
| 5s fade, 10s delay | `00 14` (20 qs) | `00 28` (40 qs) |
| 0s fade, 10s delay | `00 00` (0 qs) | `00 28` (40 qs) |

Encoding: `value = seconds * 4` as uint16 big-endian. Max = 65535 qs = ~4.55 hours (Lutron caps UI at 4 hours).

### Programming Sequence

The RA3 bridge programs scenes in this order (each burst = 2-20 retransmissions):

```
A1-A3 format 0x1A  →  Scene config (fade + delay)     [2 retransmissions only]
0x81  format 0x0A  →  LED/device config (broadcast)    [~20 retransmissions]
0xC1-0xDF          →  Device status/acknowledgment
0x82  format 0x0D  →  Scene definition (preset ID)     [~12 retransmissions]
0x81  format 0x0B  →  Scene trigger/recall             [~12 retransmissions]
```

Format 0x0D payload is **static** across all fade/delay settings — it only identifies the scene. Format 0x0B bytes 16-18 change but are a revision hash, not direct fade/delay encoding.

## Implications for CC1101 Improvement

### Current State

The CC1101 is configured in **fixed-length mode at 80 bytes** with a tight-loop accumulation strategy that drains the 64-byte FIFO mid-packet. The Rust N81 decoder handles the actual framing.

The problem: the CC1101 truncates format 0x1A packets to 24 bytes in the CSV logs. This is **not** a FIFO issue (80 bytes is enough for 53-byte N81-encoded packets, which expand to ~67 raw bytes). The truncation likely happens in one of two places:

1. **The N81 decoder** may have a buffer or length limit that stops decoding early
2. **The packet delivery path** may truncate based on the type byte

### What Needs Investigation

Check the Rust crate (`rf/cca/src/`) for:
- Maximum decoded packet length — is there a hardcoded 24-byte output buffer?
- Does the decoder stop after finding a CRC match at 24 bytes (short packet CRC) and miss the 53-byte CRC?
- Is the `raw_len` field in `DecodedPacket` capped?

Check `cc1101_cca.cpp` for:
- Does `deliver_packet()` or the UDP relay truncate based on `pkt.raw_len`?
- Is there a fixed-size buffer between decoder output and UDP transmission?

### Suggested Fix

If the decoder is CRC-boundary limited (finds CRC at byte 24 and stops), the fix is to continue decoding and check for a second CRC at byte 53. The `findCrcBoundary()` approach in the RTL-SDR decoder already does this — it tries all lengths from 10 to max.

## Implications for Delay in Other Commands

### What We Now Know About Delay

Delay is a **per-device, per-scene** configuration, not a per-command parameter. The RA3 system programs delay into the device's flash via format 0x1A config packets. When a scene is triggered (format 0x0B), the device recalls its stored fade/delay values.

### Format 0x0E (SET_LEVEL) — Possible Delay Field?

Format 0x0E carries an explicit fade time at byte 19 (quarter-seconds). Bytes 20-21 are always `0x00 0x00` in all captures. These could be:

- **Delay field**: uint16 LE/BE quarter-seconds, mirroring the format 0x1A layout
- **Reserved/unused**: always zero because SET_LEVEL doesn't support delay
- **Other parameters**: minimum level, ramp curve, etc.

**Test**: Send a SET_LEVEL with non-zero bytes 20-21 and observe whether the device waits before transitioning. If `bytes 20-21 = 0x00 0x28` (10 seconds) causes a 10-second wait before fade begins, we've found per-command delay.

### Format 0x1C (Fade Config) — Default Delay?

Format 0x1C sets the device's default fade-on and fade-off rates (used for physical button presses). We tested bytes 27-30 for delay with no effect. But:

- Format 0x1A uses byte 15 = `0x40` (scene component), while format 0x1C uses `0x50` (dimmer component)
- There might be a **separate config format** for default delay, with a different format byte
- Or delay might only be a scene property, not a device default

### Endianness Clue

Format 0x1A uses **big-endian** for fade/delay. Format 0x1C uses **little-endian** for fade values. This inconsistency suggests they were implemented by different teams or at different times. When testing bytes 20-21 in format 0x0E, try both endiannesses.

### Component Byte (Byte 15) as a Key

Format 0x1A byte 15 = `0x40` (scene). Format 0x1C byte 15 = `0x50` (dimmer). The component byte may unlock different parameter spaces:

| Component | Byte 15 | Known Formats |
|-----------|---------|---------------|
| Scene | 0x40 | 0x1A (fade + delay) |
| Dimmer | 0x50 | 0x11 (LED), 0x1C (fade), 0x15 (trim) |

There might be other component values that enable different config sets.

### Recommended Test Plan

1. **Format 0x0E bytes 20-21**: Try `00 28` (10s, BE) and `28 00` (10s, LE) — watch for delayed fade start
2. **Format 0x1A standalone**: Send a format 0x1A packet directly (outside of scene programming) to see if we can set per-device delay independently
3. **Format 0x1C with component 0x40**: Change byte 15 from 0x50 to 0x40 and add delay bytes at 27-28 — might unlock scene-style config via the fade config format
4. **Capture other scene configs**: Program scenes with longer fade/delay values (e.g., 60s, 120s) to verify uint16 encoding and check high bytes
