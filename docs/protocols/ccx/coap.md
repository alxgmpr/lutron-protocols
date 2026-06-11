# Lutron CCX Device CoAP Protocol

Reverse-engineered from live probing of Sunnata devices over Thread mesh (2026-04-01).

All endpoints are CoAP over UDP port 5683. Devices are addressed by Thread RLOC
(`fd0d:02ef:a82c::00ff:fe00:<rloc16>`). Device RLOCs are available from
`/var/log/ccx-diagnostics-log.0.gz` on the RA3 processor.

## Firmware Metadata

### GET fw/ic/md — Image Catalog

Returns a summary of all firmware image slots on the device. 26 bytes on Sunnata.

```
[slot_count:1] [slot_entry:8] × count

slot_entry:
  [flags:4 LE] [component:1] [major:1] [minor:1] [patch:1]
```

**Flags** (little-endian uint32):
- `0x00000008` — pending/staged (not yet active)
- `0x00000080` — installed/active

**Component IDs**:
- `1` — Application firmware
- `2` — Bootloader
- `4` — Peripheral/radio firmware

Example (Sunnata dimmer):
```
03                            # 3 slots
08 00 00 00  04 00 07 00      # Slot 0: pending,  comp=4 (peripheral), v0.7.0
80 00 00 00  02 01 06 00      # Slot 1: active,   comp=2 (bootloader), v1.6.0
80 00 00 00  01 03 0E 0D      # Slot 2: active,   comp=1 (app),        v3.14.13
```

### GET fw/ia/md, fw/ib/md, fw/ip/md — Per-Slot Detail

12 bytes per slot with version, build hash, and image metadata.

```
[major:1] [minor:1] [patch:1] [0x80] [build_hash:4] [image_meta:3] [0x00]
```

- `ia` = Slot A → maps to ic/md component 1 (application)
- `ib` = Slot B → maps to ic/md component 2 (bootloader)
- `ip` = Pending → maps to ic/md component 4 (peripheral)
- Byte 3 is always `0x80` (image valid/verified flag)
- `build_hash` (4 bytes): varies between device types; may be CRC32 or build timestamp
- `image_meta` (3 bytes): likely image size or secondary hash; trailing byte always `0x00`

Cross-device comparison: `ia` and `ip` are **identical** on dimmer and keypad when running
the same firmware version — the application and peripheral images are shared across device types.
The bootloader (`ib`) differs per device model.

### GET fw/it/md — Transfer State

17 bytes describing the current DFU state and running firmware identity.

```
[state:1] [0x00:3] [slot_count:1] [version:4] [build_num:2 BE] [unk:2] [variant_str:N+NUL]
```

- `state`: 1 = idle (no transfer in progress)
- `version`: matches the active slot (ia) version bytes (e.g., `03 0E 0D 80`)
- `build_num`: model-specific build number (BE uint16)
  - Dimmer: 0x045E (1118)
  - Keypad: 0x0127 (295)
- `variant_str`: null-terminated ASCII firmware variant identifier
  - `"13a"` = Sunnata Dimmer
  - `"13a"` = Sunnata Dimmer, Sunnata Fan Control (build 1118)
  - `"15a"` = Sunnata Keypad (build 295)
  - `"20a"` = Sunnata Keypad, Sunnata Hybrid Keypad (build 297)

### PUT/POST fw/it — DFU Upload

GET returns `4.05 Method Not Allowed`. This endpoint accepts firmware image data
via CoAP Block-Wise Transfer (RFC 7959). The Kinetis coprocessor firmware RE shows
options 0x17 (Block1) and 0x1B (Block2) are used. PFF files are relayed unmodified.

## Device Database (cg/db)

Configuration data is organized in containers. All database endpoints are **write-only** —
GET returns `0.00` (exists, empty) or `4.04` (not found). Data is written via PUT or POST.

### Container Hierarchy

```
cg/db/ct/c/<BUCKET>   Config Table — device settings (trim, LED, fade, phase)
cg/db/pr/c/<ID>       Presets — scene/preset level data
cg/db/mc/c/<ID>       Multicast — group address assignments
cg/db/ns/c/<ID>       Namespaces — (purpose unknown, 4.04 on tested devices)
```

### Config Table Buckets (cg/db/ct/c/)

Bucket names are 3-character ASCII strings. Availability depends on device type.
All buckets are write-only (GET returns `0.00` exists, PUT/POST to write).

#### Bucket availability by device type

Full scan of A[A-Z][A-Z] range (676 combinations per device, 1 probe/second):

```
Bucket  Dimmer  Fan  Keypad  H-Keypad  Switch
──────  ──────  ───  ──────  ────────  ──────
AAA     ·       ·    ✓       ·*        ·
AAE     ·       ·    ✓       ·*        ·
AAI     ✓       ✓    ✓       ·*        ✓        ← Trim (confirmed)
AAM     ✓       ✓    ✓       ·*        ✓
AAQ     ✓       ✓    ✓       ✓         ✓
AAU     ✓       ✓    ✓       ✓         ✓
AAY     ✓       ✓    ✓       ✓         ✓
ABI     ·       ·    ✓       ✓         ·
ABM     ·       ·    ✓       ✓         ·
AFE     ·       ·    ✓       ✓         ·
AFI     ·       ·    ✓       ✓         ·
AFM     ·       ·    ✓       ✓         ·
AFQ     ·       ·    ✓       ✓         ·
AFU     ·       ·    ✓       ·*        ·
AFY     ·       ·    ✓       ·*        ·
AHA     ·       ·    ✓       ✓         ·        ← LED brightness (confirmed)
AIE     ·       ·    ✓       ✓         ·
```

`*` H-Keypad had 9% packet loss — missing entries likely exist but weren't captured.

**Naming pattern**: Bucket names are NOT mnemonic — they are encoded slot indices.
The 3rd letter follows a delta-4 pattern: A=1, E=5, I=9, M=13, Q=17, U=21, Y=25.
Multiple instances of the same config type use consecutive slots:
- AA* (7 slots) — base device config (trim, etc.)
- AB* (2 slots) — secondary config (button devices only)
- AF* (6 slots) — tertiary config (button devices only)
- AH* (1 slot) — LED brightness
- AI* (1 slot) — additional config (button devices only)

Dimmers/FanControl/Switch: 5 base AA* slots (AAI through AAY).
Keypads: 17 slots across 5 prefix groups.
Hybrid Keypads: 11+ slots (same groups minus some AA* entries).

#### Known CBOR formats

| Bucket | CBOR Format | Purpose |
|--------|-------------|---------|
| `AAI`  | `[3, {2: high_raw, 3: low_raw, 8: profile}]` | Trim (high/low limits) |
| `AHA`  | `[108, {4: active_byte, 5: inactive_byte}]`   | Status LED brightness  |

**Trim encoding**: `raw = percent × 0xFEFF / 100` — same as level encoding (1% → 0x028C, 100% → 0xFEFF)

### Presets (cg/db/pr/c/)

Written via POST with CBOR payload:

```
POST /cg/db/pr/c/<hex_device_id>
{bstr(4, device_id << 16 | 0xEF20): [preset_id, {0: level16, 3: fade_qs}]}
```

Level encoding: `level16 = percent × 0xFEFF / 100`
Fade encoding: `fade_qs = seconds × 4` (quarter-seconds)

## Logging

| Path | Methods | Notes |
|------|---------|-------|
| `lg/all` | GET: 0.00, POST: 0.00/5.03, PUT: 5.03 | All logging, may require CoAP Observe |
| `lg/lim` | GET: 0.00, PUT: 0.00 | Limited logging |

Logging responses are inconsistent. May require CoAP Observe (option 6) subscription
for streaming log data. The 5.03 (Service Unavailable) response suggests the feature
exists but has prerequisites (authentication, observe subscription, or specific payload format).

## Firmware Variants

All Sunnata devices run app version 3.14.13 with different firmware variants:

| Variant | Build | Device Types |
|---------|-------|-------------|
| `"13a"` | 1118  | SunnataDimmer, SunnataFanControl |
| `"15a"` | 295   | SunnataKeypad (older) |
| `"20a"` | 297   | SunnataKeypad, SunnataHybridKeypad |

Switches likely share the keypad variant. Bootloader versions differ per model
(dimmers: v1.6.0, keypads: v2.0.5). The peripheral/radio firmware (component 4)
is v0.7.0 across all devices.

## Other Paths

| Path | Notes |
|------|-------|
| `.well-known/core` | RFC 6690 resource discovery — **4.04 on Sunnata Hybrid Keypad** (2026-04-21, two units). Devices do not expose CoRE Link Format. For mesh enumeration, use TMF `/d/dg` instead — see "TMF Network Diagnostic" below. |
| `em/tc/` | Found in Kinetis firmware strings. 4.04 on all tested devices. Possibly emergency test/control, disabled in production. |
| `lut/ac` | Action Command — **processor-internal only**, 4.04 on all devices |
| `lut/ra` | Resource Access — **processor-internal only**, 4.04 (port 49136 also tested, no response) |
| `cg/nt/able` | Network Table — **processor-internal only**, 4.04 on devices |

## Addressing

Three address forms are visible for every CCX device on the Thread mesh. Only
one of them is stable enough to use in long-lived tooling.

| Form | Example | Stability | Use for |
|------|---------|-----------|---------|
| Primary ML-EID | `fd0d:2ef:a82c:0:<random-IID>` | **rotates** on reboot/re-pair | RX-side device identification only |
| RLOC-EID | `fd0d:2ef:a82c:0:0:ff:fe00:<RLOC16>` | transient — valid while device holds that RLOC | probes against Routers; unreliable for Sleepy End Devices |
| Secondary ML-EID | `fd00::<modified-EUI-64>` | **stable forever** — derived from hardware MAC | all write paths |

The secondary ML-EID is an SLAAC address on the processor-advertised on-mesh
prefix (`fd00::/64`). Its IID is the device's EUI-64 with the U/L bit flipped
(XOR byte 0 with `0x02`), exactly as described by RFC 4291 Section 2.5.1.

Given an EUI-64 (from Designer DB `tblPegasusLinkNode.IPv6Address`, or TLV 0 in
a TMF Network Diagnostic reply), compute the secondary ML-EID with
`ccx/addressing.ts::eui64ToSecondaryMleid`. The TS helper accepts colons,
hyphens, or bare hex; mixed case OK. Sample:

```
e2:79:8d:ff:fe:92:85:fe  →  fd00::e079:8dff:fe92:85fe
```

**Gotcha:** the `fd00::` address only routes once the Nucleo is fully attached
as a Router and has picked up the on-mesh prefix from Thread Network Data. If
you see `CoAP TX failed (not joined?)`, wait for ROUTER role (~30–60 s after
boot).

### Finding device addresses

- **Static** (via Designer DB): see `data/designer-ccx-devices.json` — exported
  from `tblPegasusLinkNode`. Each row has `eui64` and precomputed
  `secondaryMleid`.
- **Live**: run `npx tsx tools/ccx/tmf-diag.ts --save`. This POSTs a TMF Network
  Diagnostic request to `ff03::1:61631/d/dg` and writes
  `data/ccx-mesh-inventory.json` with every responder's EUI-64, RLOC16, and
  derived secondary ML-EID. See next section.

Shell command: `ccx coap get <addr> <path> [port]` — `addr` may be raw IPv6
(preferred; `::` shorthand accepted), `rloc:<RLOC16>`, or `serial:<N>`
(resolves via the firmware's peer table, which learns from live traffic). TS
tools should prefer to emit the full `fd00::` IPv6 address by calling
`lib/ccx-coap.ts::formatCoapTarget(target, resolveSerial)` with a resolver
backed by `data/designer-ccx-devices.json`.

## TMF Network Diagnostic (port 61631)

Endpoint: `POST coap://[<dst>]:61631/d/dg` where `<dst>` is either a unicast
device address or the all-Thread-nodes multicast `ff03::1` for mesh
enumeration.

Request payload (single TLV, type `0x12` = Type List):

```
[0x12][count][type_1]...[type_N]
```

Example — request ExtMacAddress (0), Address16 (1), and IPv6 List (8):

```
12 03 00 01 08
```

Response payload is a sequence of TLVs in `type(1) | length(1) | value(length)`
format. Types this tooling consumes:

| Type | Name | Value |
|------|------|-------|
| 0 | ExtMacAddress | 8 bytes EUI-64 (as stored in `data/designer-ccx-devices.json::eui64`) |
| 1 | Address16 | 2 bytes RLOC16 (big-endian) |
| 8 | IPv6 Address List | `16 * N` bytes — all IPv6 addresses assigned to the device, including primary ML-EID, RLOC-EID, and secondary ML-EID(s) |

Other Thread spec types (Mode, Timeout, Connectivity, Route64, Leader Data,
Network Data, Channel Pages, MAC Counters, …) are defined but not consumed
here; the decoder ignores them safely. See `ccx/tmf-diag.ts` for the canonical
TLV list constants.

Shell usage:

```
ccx coap post ff03::1 d/dg 1203000108 61631
```

The Nucleo forwards the multicast, and every responder's reply is broadcast
on the `:9433` stream as
`[coap] 2.05 src=<ipv6> mid=<hex> token=<hex> len=<n> payload=<hex>`.
`tools/ccx/tmf-diag.ts` consumes this stream and produces
`data/ccx-mesh-inventory.json`.

### ⚠ NCP restriction on port 61631

On the current firmware stack, outbound CoAP to port 61631 via Spinel
`STREAM_NET` is dropped by the OpenThread NCP with
`LAST_STATUS=14 (PACKET_DROPPED)` — reproducible with both unicast and
multicast destinations. Port 61631 is reserved by Thread for MLE/MeshCoP;
OpenThread expects TMF messages to originate from its own internal TMF
client (secured with MLE), not from a host-injected STREAM_NET packet.

**Verified (2026-04-21, firmware commit d08cbde):**
- `ccx coap get fd00::<secondaryMleid> <path>` on port 5683 → works from cold
  start (2.05 Content response in both `ccx_task` and enriched `[coap]`
  broadcast). Stale-ML-EID problem **structurally solved** for all write
  paths that can address a known device by EUI-64.
- `ccx coap post <fd00::|ff03::1> d/dg <hex> 61631` → `tx=FAIL`,
  `LAST_STATUS=14`.
- Same packet re-targeted to port 49136 (or 5683) → `tx=OK`.

To enable the mesh sweep as originally designed, the NCP would need a
dedicated Spinel property that routes through `otThreadSendDiagnosticGet()`
internally (bypassing STREAM_NET's port filtering). Deferred to a follow-up
plan; `tools/ccx/tmf-diag.ts` and the TLV codec remain in tree so that path can
pick them up when the firmware side lands.

### Scope of multicast

`ff03::1` is the all-Thread-nodes scope-3 multicast. It reaches every node in
the PAN, including Sleepy End Devices (during their listening window). If the
keypad you care about isn't answering, wait longer (`--wait 6000`) to catch
the SED polling interval.

### Finding device RLOCs via the processor

Legacy path, still useful when the Nucleo isn't attached:
```bash
ssh root@10.0.0.1 "zcat /var/log/ccx-diagnostics-log.0.gz | head -20"
```
Output format:
```
 Device ID| SerialNumber|Rx#|Rloc16| ...
      3647|   0x0451A7A0|  3|0x4800| ...
```

## CCX Multicast Messages (port 9190)

Level control and scene recall use multicast CBOR to `ff03::1`, not unicast CoAP.

```
LEVEL_CONTROL: [0, {0: {0: level16, 3: fade_qs}, 1: [16, zone_id], 5: seq}]
SCENE_RECALL:  [1, {1: scene_id, 5: seq}]
```
