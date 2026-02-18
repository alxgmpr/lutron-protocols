# CCX Programming Plane (`/cg/db` over CoAP)

## Summary

CCX uses at least two application planes on Thread:

- Runtime/control plane: `UDP 9190` with CBOR messages (`ACK`, `SCENE_RECALL`, `COMPONENT_CMD`, `STATUS`, `PRESENCE`, etc.).
- Programming plane: `UDP 5683` (CoAP), with paths under `/cg/db/...` carrying CBOR payloads during transfer/pairing/programming.

In captures, device programming traffic is primarily on `5683`, not `9190`.

## Evidence (capture set)

- Capture: `/tmp/lutron-sniff/live/lutron-thread-ch25_00001_20260217235133.pcapng`
- Duration: ~500s, packets: 9594
- Ports seen:
  - `5683`: 3410 frames
  - `9190`: 1399 frames
  - `19788`: 553 frames (MLE/network control)
- Event markers: `/tmp/lutron-sniff/live/events.log`

## Observed programming transaction pattern

Per target device/session, we repeatedly see:

1. `DELETE /cg/db`
2. `PUT /cg/db/ct/c/*`
3. `POST /cg/db/mc/c/AAI`
4. `POST /cg/db/pr/c/AAI`
5. `2.02` / `2.04` responses

Top URI counts (same capture):

- `/cg/db/pr/c/AAI`: 1029 packets (request+response)
- `/cg/db/mc/c/AAI`: 203
- `/cg/db`: 56
- `/cg/db/ct/c/AAI`: 53
- plus many `/cg/db/ct/c/<token>` variants (`AAM`, `AFE`, `AFI`, `AFQ`, `AHA`, etc.)

## `ct` Bucket Token Encoding (confirmed)

`/cg/db/ct/c/<token>` uses a Base64URL token that decodes to a 2-byte bucket ID.

Examples:

- `AAC` -> `0x0007`
- `AAg` -> `0x0008`
- `AFE` -> `0x0051`
- `AFI` -> `0x0052`

Observed map in this capture:

- `AAA` -> `0x0000`
- `AAE` -> `0x0001`
- `AAI` -> `0x0002`
- `AAM` -> `0x0003`
- `AAQ` -> `0x0004`
- `AAU` -> `0x0005`
- `AAc` -> `0x0007`
- `AAg` -> `0x0008`
- `AAo` -> `0x000A`
- `ABI` -> `0x0012`
- `ABM` -> `0x0013`
- `AFE` -> `0x0051`
- `AFI` -> `0x0052`
- `AFM` -> `0x0053`
- `AFQ` -> `0x0054`
- `AFY` -> `0x0056`
- `AHA` -> `0x0070`
- `AIE` -> `0x0081`

## Likely meaning of names (inference)

These are hypotheses from traffic behavior and payload shape, not vendor-confirmed names.

- `db`:
  - Likely "database" (high confidence).
  - Evidence: frequent `DELETE /cg/db` before config/program writes.
- `pr`:
  - Preset records (confirmed).
  - Evidence: payload keys map to LEAP preset IDs; user validation confirms `pr` is preset.
- `mc`:
  - Likely "mapping/membership/index records" (medium confidence).
  - Evidence: compact 5-byte IDs ending in `ef`, used alongside `pr`.
- `ct`:
  - Likely "configuration/control table" writes (medium confidence).
  - Evidence: many setup-like writes across multiple named buckets before/with `pr` traffic.
- `c` path segment (`.../c/...`):
  - Likely "collection/class/channel" sub-namespace (low/medium confidence).
- `AAI`, `AAM`, `AFE`, etc.:
  - Likely table/bucket IDs (high confidence they are bucket IDs, low confidence on naming expansion).

## Payload findings

### `/cg/db/pr/c/AAI` (CoAP `POST`, code `2`)

Payload decodes as CBOR map keyed by bytes ending in `ef20`, for example:

- Hex: `a1440dc3ef20821848a10000`
- Decoded form (semantic): `{ 0x0dc3ef20: [72, {0: 0}] }`

Observed value structure:

- `[72, {...}]` dominates (504/508 rows in analyzed capture).
- Inner map keys:
  - `0`: level-like value (`0`, `0x3DD2`, `0x7E36`, `0xBE9B`, `0xFEFF`, etc.)
  - `3`: fade time (confirmed)
  - `4`: delay time (confirmed)

The level ladder matches known CCX level encoding (`0xFEFF` full-on, quarter/half/three-quarter values, etc.).

In this capture:

- `pr` rows: 508
- unique `pr` keys: 126
- keys matching local LEAP presets dump: 72
- keys matching Designer `tblPreset.PresetID`: 76
- remaining keys not in `tblPreset`: 50

Current LEAP dump (`~/lutron-tools/data/leap-10.0.0.1.json`) contains:

- 33 zones
- 44 devices
- 101 presets

DB enumeration on the active Designer LocalDB (`Project`) shows those 50 non-`tblPreset` keys map to scene/assignment records:

- `tblScene.SceneID` (all 50 IDs hit)
- `tblPresetAssignment.ParentID` (all 50 IDs hit)
- `tblAssignmentCommandParameter.ParentId` (all 50 IDs hit)
- `AllPresetsAndSceneDefinition.scene_id` with `preset_id = NULL` for these rows

So the `pr` key space in this capture is mixed:

- Preset IDs (`tblPreset.PresetID`)
- Scene IDs (`tblScene.SceneID`) used as assignment parents

### `/cg/db/mc/c/AAI` (CoAP `POST`, code `2`)

Payload shape is usually a single CBOR byte-string item:

- Example: `8145000007c9ef` -> `[0x000007c9ef]`

IDs are commonly 5 bytes ending with `ef`.

### `/cg/db/ct/c/*` (CoAP `PUT`, code `3`)

Payloads are short CBOR arrays, often opcode-like first element + parameter map:

- `[57, {"1":1}]`
- `[9, {"1":65279, "7":229, "10":3}]`
- `[107, {"0":37}]`
- `[108, {"4":153, "5":20}]`
- `[3, {"2":58685, "3":2638, "8":5}]`
- `[92, {}]`, `[94, {}]`

Exact semantics are still unresolved, but these appear to establish supporting tables/config used by `mc`/`pr` programming rows.

### Confirmed: `AHA` (`0x0070`) controls keypad status LED levels

For office keypad programming captures, this write is confirmed:

- Path: `/cg/db/ct/c/AHA`
- CoAP: `PUT` (`0.03`)
- Payload CBOR form: `[108, {4: <activated_level>, 5: <deactivated_level>}]`
- Level range: `0..255` for both values

Observed values:

- High: `82186ca20418e5051819` -> `[108, {4:229, 5:25}]`
- Low: `82186ca2041833050c` -> `[108, {4:51, 5:12}]`

### Addressing prerequisite for successful injection

To reproduce writes from STM32+nRF injection:

- Use mesh-local RLOC addresses, not the `::...` display addresses shown in Wireshark decode.
- Format used successfully:
  - Source (injector): `fd0d:02ef:a82c:0000:0000:00ff:fe00:4c00`
  - Office keypad target: `fd0d:02ef:a82c:0000:0000:00ff:fe00:2c00`

Example commands:

```bash
# HIGH
bun run tools/ccx-coap-send.ts aha \
  --stm32-host 10.0.0.3 \
  --dst fd0d:02ef:a82c:0000:0000:00ff:fe00:2c00 \
  --src fd0d:02ef:a82c:0000:0000:00ff:fe00:4c00 \
  --k4 229 --k5 25 \
  --repeat 3 --interval 150 --timeout-ms 9000

# LOW
bun run tools/ccx-coap-send.ts aha \
  --stm32-host 10.0.0.3 \
  --dst fd0d:02ef:a82c:0000:0000:00ff:fe00:2c00 \
  --src fd0d:02ef:a82c:0000:0000:00ff:fe00:4c00 \
  --k4 51 --k5 12 \
  --repeat 3 --interval 150 --timeout-ms 9000
```

### Strong correlation: `0x0051..0x0054` carry LED link indices

For keypad sessions, `AFE/AFI/AFM/AFQ` (`0x0051..0x0054`) carry values matching Designer `tblLed.LedNumberOnLink`.

Office keypad session (`dst ::3c2e:f5ff:fef9:73f9`, `ControlStationDeviceID=926`) writes:

- `AFE (0x0051)` payload `[107, {0: 3}]`
- `AFI (0x0052)` payload `[107, {0: 4}]`
- `AFM (0x0053)` payload `[107, {0: 5}]`

Designer DB for `ParentDeviceID=926` has `LedNumberOnLink` = `3,4,5`.

## How this maps to user-observed flow

- Designer transfer to processor (LAN-side) happens before Thread programming bursts.
- After processor comes back online, Thread programming appears as large `5683` `/cg/db/*` bursts.
- `9190` remains active for runtime/control state traffic, not the main programming record stream.

## Open questions

- Exact expansion of `cg`, `ct`, `mc`, and token buckets (`AAI`, `AAM`, ...).
- Which `ct` opcodes map to which internal objects.
- Exact runtime decision logic for choosing `pr` key as preset ID vs scene ID.

## Quick extraction commands

```bash
FILE=/tmp/lutron-sniff/live/lutron-thread-ch25_00001_20260217235133.pcapng

# CoAP programming paths
tshark -r "$FILE" -d udp.port==5683,coap \
  -Y 'udp.port==5683 && coap.opt.uri_path_recon' \
  -T fields -e coap.code -e coap.opt.uri_path_recon | sort | uniq -c | sort -nr

# pr payloads (program records)
tshark -r "$FILE" -d udp.port==5683,coap \
  -Y 'coap.opt.uri_path_recon=="/cg/db/pr/c/AAI" && coap.code==2 && data' \
  -T fields -e frame.time_relative -e data

# runtime CCX plane
tshark -r "$FILE" -Y 'udp.port==9190 && data' \
  -T fields -e frame.time_relative -e ipv6.src -e ipv6.dst -e data
```
