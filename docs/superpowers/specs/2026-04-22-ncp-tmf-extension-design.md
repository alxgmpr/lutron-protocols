# NCP TMF Vendor Extension — Design Spec

**Date:** 2026-04-22
**Status:** Approved for planning
**Author:** alexgompper (+ Claude Opus 4.7)
**Related:** `docs/superpowers/plans/2026-04-21-stable-ccx-addressing-tmf-diag.md` (predecessor work; its Phase 5 TMF-diag path was blocked at the NCP port-61631 filter — this spec addresses that blocker).

## Goal

Add a vendor Spinel extension to the OpenThread NCP firmware running on the Nucleo-soldered nRF52840, exposing four OT APIs that are not plumbed through stock Spinel:

- `otThreadSendDiagnosticGet()` — multicast-capable `/d/dg` TMF query.
- `otThreadSendDiagnosticReset()` — diagnostic-counter reset on remote devices.
- `otThreadGetNextNeighborInfo()` — local neighbor table read.
- `otThreadGetNextChildInfo()` — local child table read.

Once landed, the STM32 host gains a Spinel-level channel to the mesh control plane. Specifically, this unblocks `tools/ccx/tmf-diag.ts` (which currently fails because host-injected CoAP on port 61631 is dropped by the NCP with `LAST_STATUS=14`) and gives us general TMF / diagnostic read access we can extend later.

## Non-goals

- STM32 host integration or TS tool rewiring — those live in a separate follow-up plan (Plan 2). This spec is scoped to the NCP patch + isolated verification.
- Upstreaming to OpenThread proper.
- Concurrent `DIAG_GET` requests (single-outstanding is enforced in the NCP).
- Additional OT APIs beyond the four named above.
- `nrfutil` install automation — treated as a user prerequisite.
- UI for browsing neighbor/child tables.

## Success criterion (Plan 1)

> From a dev machine, running `npx tsx tools/nrf/nrf-ncp-probe.ts diag-get ff03::1 0 1 8` against the Nucleo sends a multicast `/d/dg` TypeList request through the new Spinel property, collects streamed TLV responses from every responder over ~5 seconds, and prints one `src=<ipv6> tlv=<hex>` line per responder, terminated by a `DONE` event. The Office Entrance keypad appears in the output on its first button press. Existing CCX comms (zone dimming, keypad events, bridge) continue to function with no regression.

## Context & background

### Why this is necessary

OpenThread's NCP interface deliberately excludes the diagnostic-get family from Spinel property space. See `openthread/openthread#853` for the upstream issue listing the APIs (~49 total) that are host-unreachable via Spinel. The consequence for us: host-injected CoAP on port 61631 via `SPINEL_PROP_STREAM_NET` is dropped by the NCP because Thread reserves that port for its own MLE-secured TMF client. Reproducible with `LAST_STATUS=14 (SPINEL_STATUS_PACKET_DROPPED)`. Documented in detail in `docs/protocols/ccx-coap.md` under "NCP restriction on port 61631".

### Why direct patch vs. vendor hooks

OT has an `otVendor*` extension point meant for vendor-specific property handlers. It's designed for **synchronous** `PROP_SET` / `PROP_GET` only. Our `DIAG_GET_RESPONSE` path is **asynchronous streaming** — responses arrive whenever mesh devices reply, independent of the original request's round-trip. Emitting async `PROP_INSERTED` frames requires access to `NcpBase` internals (`WritePropertyValueIsFrame` or equivalent) that vendor hooks don't expose. Direct patching of OT's `NcpBase` source is the cleanest path.

## Architecture

```
  ┌──────── STM32H723 (FreeRTOS) ────────┐       ┌────── nRF52840 NCP ──────┐
  │                                       │       │                          │
  │  Plan 2: ccx_send_diag_get()          │       │  ot-ncp-ftd              │
  │  Plan 1: tools/nrf/nrf-ncp-probe.ts ─────────┬─────►  + tmf-extension.patch   │
  │          (raw Spinel frames over      │  │    │   - VENDOR_DIAG_GET_*    │
  │           stream :9433 → HDLC → NCP)  │  │    │   - VENDOR_DIAG_RESET   │
  │                                       │  │    │   - VENDOR_NEIGHBOR_TBL │
  └───────────────────────────────────────┘  │    │   - VENDOR_CHILD_TBL    │
                                              │    └───────────┬──────────────┘
                                              └─ HDLC/UART ─────┤ 802.15.4
                                                                ▼
                                                         ┌─── Thread PAN ───┐
                                                         │  Sunnata dimmers, │
                                                         │  keypads, RA3     │
                                                         │  leader           │
                                                         └───────────────────┘
```

### STM32 unchanged in Plan 1

The STM32 already forwards Spinel frames unmodified between the UDP stream protocol on port 9433 and the NCP's UART, via the existing `shell spinel raw <hex>` passthrough. Plan 1 uses only that path — no STM32 firmware changes required. Every new codepath lives inside the NCP patch.

## Design decisions (from brainstorming)

| Question | Decision | Rationale |
|----------|----------|-----------|
| Response delivery shape | **Hybrid streaming + terminal `DONE` event** | Multicast `/d/dg` produces N asynchronous responses. Streaming matches the mesh's natural cadence; the `DONE` event lets the host end collection on a real signal instead of a wall-clock guess. |
| Scope | **TMF toolkit (6 properties)** | Diag-get + diag-reset + local neighbor + local child table reads. Solves the immediate problem AND the next two diagnostics-adjacent feature requests in one patch. |
| Host API shape | **Hybrid per-command** | Diag-get is async streaming (broadcasts via the stream channel). Diag-reset / neighbors / children are synchronous (each produces one result). Semantic honesty over API uniformity. |
| Patch strategy | **Separate `tmf-extension.patch`** | Keeps `nucleo-uart.patch` as the hardware shim. TMF extension patch is ~300 lines of feature code in its own file. Easier to review, rebase, and extend. |
| Recovery artifact | **Two DFU packages in tree** | `ot-ncp-ftd-dfu.zip` (known-good) stays. Add `ot-ncp-ftd-tmf-dfu.zip` alongside. `nrf-dfu-flash.ts --rollback` restores in one command. |
| Plan structure | **Two plans in sequence** | Plan 1 = NCP patch + build + DFU + standalone probe verification. Plan 2 = STM32 + TS integration. All the brick-the-dongle risk lives in Plan 1; Plan 2 is low-risk wiring. |

## Spinel property definitions

OpenThread reserves `0x3C00`–`0x3FFF` for vendor properties. This spec allocates `0x3C00`–`0x3C05`, leaving `0x3C06+` for future extension. All multi-byte integers are little-endian per Spinel convention; IPv6 addresses are byte-order-neutral (16 raw bytes as they appear on the wire).

### `VENDOR_DIAG_GET_REQUEST` (0x3C00)

Direction: host → NCP, `SPINEL_CMD_PROP_SET`.

Payload:

| Offset | Size | Field | Notes |
|--------|------|-------|-------|
| 0 | 16 B | `dst_addr` | IPv6 destination. Unicast (any `fd0d::` / `fd00::` / `fe80::`) or multicast (`ff03::1`). |
| 16 | 1 B | `tlv_count` | Number of Diagnostic TLV types requested (1–32). |
| 17 | N B | `tlv_types[]` | `tlv_count` bytes, one Diag TLV type ID per byte (0=ExtMac, 1=RLOC16, 8=IPv6 List, …). |

Response: `LAST_STATUS` with one of:

- `SPINEL_STATUS_OK` — request accepted, responses will stream via `DIAG_GET_RESPONSE`.
- `SPINEL_STATUS_BUSY` — a previous `DIAG_GET` is still in flight. Wait for its `DIAG_GET_DONE`.
- `SPINEL_STATUS_INVALID_ARGUMENT` — malformed payload (too short, `tlv_count` = 0 or > 32, total size mismatch).
- `SPINEL_STATUS_FAILURE` — underlying `otThreadSendDiagnosticGet()` failed (e.g. not attached, memory alloc fail).

Concurrency: one outstanding query at a time, enforced by the extension's `mInFlight` flag. NCP starts a 5-second completion timer on accept.

### `VENDOR_DIAG_GET_RESPONSE` (0x3C01)

Direction: NCP → host only, `SPINEL_CMD_PROP_INSERTED`.

Payload:

| Offset | Size | Field | Notes |
|--------|------|-------|-------|
| 0 | 16 B | `src_addr` | IPv6 of the responding device. |
| 16 | 2 B | `tlv_len` (LE) | Length of the TLV blob that follows. |
| 18 | `tlv_len` B | `tlv_payload` | Raw Diagnostic TLV stream — same bytes that appear after the CoAP `0xFF` marker in a `/d/dg` response. Already parseable by `ccx/tmf-diag.ts::decodeDiagResponse`. |

Emitted once per responder, in arrival order. Multicast queries can produce many. If `tlv_payload` would exceed the Spinel frame size, it is truncated and the high bit of `tlv_len` is set as a "truncated" flag (`tlv_len & 0x8000`). Not expected in practice for the TLV types we use.

### `VENDOR_DIAG_GET_DONE` (0x3C02)

Direction: NCP → host only, `SPINEL_CMD_PROP_INSERTED`.

Payload:

| Offset | Size | Field | Notes |
|--------|------|-------|-------|
| 0 | 1 B | `reason` | 0 = timer elapsed (normal), 1 = error, 2 = reserved for future cancellation. |
| 1 | 2 B | `responder_count` (LE) | How many `DIAG_GET_RESPONSE` frames were emitted for this request. |

Fires exactly once per accepted `DIAG_GET_REQUEST`, after the 5-second completion timer elapses (no native OT "no more responders coming" signal exists, so the timer is the authoritative end-of-stream marker). Clears the busy flag — next `DIAG_GET_REQUEST` will be accepted.

### `VENDOR_DIAG_RESET_REQUEST` (0x3C03)

Direction: host → NCP, `SPINEL_CMD_PROP_SET`. Payload shape identical to `DIAG_GET_REQUEST`. Fire-and-forget — TMF diag-reset elicits no replies per Thread spec. Response: `LAST_STATUS` only. No busy flag (reset is not tracked).

### `VENDOR_NEIGHBOR_TABLE` (0x3C04)

Direction: host → NCP, `SPINEL_CMD_PROP_GET`. No request payload.

Response payload:

| Offset | Size | Field |
|--------|------|-------|
| 0 | 1 B | `entry_count` |
| 1 | 17 B × `entry_count` | `entries[]` |

Each entry:

| Offset | Size | Field | Notes |
|--------|------|-------|-------|
| 0 | 8 B | `ext_addr` | EUI-64 (wire byte order). |
| 8 | 2 B | `rloc16` (LE) | |
| 10 | 4 B | `age_s` (LE) | Seconds since last heard. |
| 14 | 1 B | `avg_rssi` | Signed int8, dBm. |
| 15 | 1 B | `last_rssi` | Signed int8, dBm. |
| 16 | 1 B | `mode_flags` | bit 0=child, 1=rx_on_when_idle, 2=ftd, 3=secure_data_req, 4=full_network_data. |

Source: `otThreadGetNextNeighborInfo()` iterated from `OT_NEIGHBOR_INFO_ITERATOR_INIT`.

### `VENDOR_CHILD_TABLE` (0x3C05)

Same pattern as neighbor table. Each entry is 21 B and includes `timeout_s` (4 B LE). Source: `otThreadGetNextChildInfo()`.

Each entry:

| Offset | Size | Field |
|--------|------|-------|
| 0 | 8 B | `ext_addr` (EUI-64) |
| 8 | 2 B | `rloc16` (LE) |
| 10 | 4 B | `timeout_s` (LE) |
| 14 | 4 B | `age_s` (LE) |
| 18 | 1 B | `avg_rssi` (signed) |
| 19 | 1 B | `last_rssi` (signed) |
| 20 | 1 B | `mode_flags` |

## NCP patch structure

`tools/nrf/ncp-build/tmf-extension.patch` — applied by `build.sh` after `nucleo-uart.patch`.

### Files in the patch

| File | Operation | Purpose |
|------|-----------|---------|
| `src/ncp/ncp_base.hpp` | modify | Declare handler methods for the six vendor properties + completion-timer callback. Declare the extension's init function. |
| `src/ncp/ncp_base.cpp` | modify | Extend the property dispatch table (`sHandlerEntry[]` or equivalent in the pinned OT version) with six entries mapping `0x3C00..0x3C05` to the handlers. Call `NcpTmfExtensionInit(instance)` from `NcpBase::NcpBase()`. |
| `src/ncp/ncp_tmf_ext.cpp` | new file | All handler bodies — request parsing, `otThreadSendDiagnosticGet()` / `otThreadSendDiagnosticReset()` calls, neighbor-table and child-table iterators, completion-timer expiration handler, `DIAG_GET_RESPONSE` / `DIAG_GET_DONE` frame emitters. |
| `src/ncp/ncp_tmf_ext.hpp` | new file | Property-ID constants, per-request state struct (`mInFlight`, `mResponderCount`, `mTimer`, `mTid`), function decls. |

Exact line-numbered decisions in `src/ncp/ncp_base.*` are deferred to implementation time since they depend on the OT version pinned when `build.sh` clones `ot-nrf528xx`. The plan will include a task to verify the pin and record the OT commit hash.

### Runtime data flow

**Request path (host → NCP → mesh):**

1. Host sends `SPINEL_CMD_PROP_SET(VENDOR_DIAG_GET_REQUEST, payload)`.
2. NCP dispatch table routes to `NcpBase::HandlePropertySetVendorDiagGetRequest()`.
3. Handler validates payload, checks `mInFlight`. If busy → emit `LAST_STATUS=BUSY`. Else:
   - Set `mInFlight = true`, `mResponderCount = 0`, save `mTid` from the request frame.
   - Copy `tlv_types` into extension state.
   - Register `otThreadSetReceiveDiagnosticGetCallback(instance, HandleDiagGetResponse, this)` if not already registered.
   - Call `otThreadSendDiagnosticGet(instance, &dst, types, count)`.
   - Start 5-second `otTimer` via `otPlatAlarmMilliStartAt()` or the NCP's scheduling layer.
   - Emit `LAST_STATUS=OK`.

**Response path (mesh → NCP → host):**

4. Every matching device responds. OT's internal TMF client receives the CoAP reply, decrypts with MLE key, extracts the TLV payload, invokes `HandleDiagGetResponse(aMessage, aMessageInfo, aContext)`.
5. Callback body:
   - Read source: `aMessageInfo->mPeerAddr` → 16 bytes.
   - Read TLV payload: `otMessageGetLength(aMessage) - otMessageGetOffset(aMessage)` bytes via `otMessageRead()`.
   - Build `VENDOR_DIAG_GET_RESPONSE` frame `[src_addr | tlv_len | tlv_payload]`.
   - Emit via the async property-insertion path.
   - Increment `mResponderCount`.

**Completion path:**

6. 5-second timer fires → `HandleDiagGetTimer()` → emit `VENDOR_DIAG_GET_DONE [reason=0 | responder_count]` → clear `mInFlight`.

### Edge cases

- **Device not attached.** `otThreadSendDiagnosticGet()` returns an error. Handler propagates as `LAST_STATUS=FAILURE`, leaves busy flag clear.
- **Host drops mid-stream.** Responses continue to arrive and `mResponderCount` increments. Timer still fires `DONE`. No buffering — if the host isn't reading the UART, Spinel TX blocks normally.
- **Oversized TLV payload.** Truncate to Spinel frame size; set high bit of `tlv_len`. Not expected in practice.
- **NCP reset during query.** Host sees `SPINEL_LAST_STATUS=RESET_*`, discards pending state, re-issues. NCP's `mInFlight` starts clear.
- **Diagnostic reset.** Fire-and-forget. Thread spec says devices do not reply. No tracking.

## Build & DFU flow

### Build

`tools/nrf/ncp-build/build.sh` extended to apply both patches in sequence:

```bash
git apply "$SCRIPT_DIR/nucleo-uart.patch"
git apply "$SCRIPT_DIR/tmf-extension.patch"
```

Build command unchanged (`./script/build nrf52840 USB_trans -DOT_BOOTLOADER=USB`). Outputs:

- `build/ot-ncp-ftd-nucleo-tmf.zip` — DFU package, copied into `firmware/ncp/ot-ncp-ftd-tmf-dfu.zip`.
- `build/ot-ncp-ftd-nucleo-tmf.hex` — raw hex, copied into `firmware/ncp/ot-ncp-ftd-tmf.hex`.

### Artifacts in tree

| Path | Purpose |
|------|---------|
| `firmware/ncp/ot-ncp-ftd.hex` | **Unchanged.** Known-good baseline. |
| `firmware/ncp/ot-ncp-ftd-dfu.zip` | **Unchanged.** Known-good DFU. |
| `firmware/ncp/ot-ncp-ftd-tmf.hex` | New. Contains TMF extension. |
| `firmware/ncp/ot-ncp-ftd-tmf-dfu.zip` | New. DFU package for the above. |

### DFU wrapper

New helper `tools/nrf/nrf-dfu-flash.ts`:

```bash
npx tsx tools/nrf/nrf-dfu-flash.ts --tmf         # flash ot-ncp-ftd-tmf-dfu.zip
npx tsx tools/nrf/nrf-dfu-flash.ts --rollback    # flash ot-ncp-ftd-dfu.zip (known-good)
```

Flow (same for both flags):

1. Prompt the user to press the reset button on the dongle.
2. Poll for the DFU serial port (`ls /dev/tty.usbmodem*` diff).
3. Invoke `nrfutil nrf5sdk-tools dfu usb-serial -pkg <path> -p <port>`.
4. Report success / failure + next steps.

Human-in-the-loop for the button press because the Nucleo-soldered dongle can only enter DFU mode physically; no software path.

## Verification (Plan 1)

New probe tool `tools/nrf/nrf-ncp-probe.ts` bypasses all STM32 CCX logic. It constructs Spinel frames from scratch and sends them via the STM32's existing `spinel raw <hex>` shell passthrough on UDP `:9433`.

Command surface:

```bash
npx tsx tools/nrf/nrf-ncp-probe.ts diag-get ff03::1 0 1 8
npx tsx tools/nrf/nrf-ncp-probe.ts diag-get <fd00::addr> 0 1 8
npx tsx tools/nrf/nrf-ncp-probe.ts diag-reset <fd00::addr> 9
npx tsx tools/nrf/nrf-ncp-probe.ts neighbors
npx tsx tools/nrf/nrf-ncp-probe.ts children
```

Each command:

1. Builds the `PROP_SET` or `PROP_GET` frame for the appropriate property.
2. Sends it over the stream passthrough.
3. Reads response frames from the same channel.
4. Decodes (via the existing `ccx/tmf-diag.ts` TLV codec for DIAG_GET responses; ad-hoc for neighbor/child tables).
5. Prints human-readable output.

### Verification checklist

1. **Smoke — dispatch works at all.** `npx tsx tools/nrf/nrf-ncp-probe.ts neighbors` prints a non-empty table. Confirms the new property dispatch reached our code.
2. **Unicast diag-get — single responder.** `diag-get <fd00::known-device> 0 1 8` returns one response with EUI-64 matching Designer DB, RLOC16 matching the sniff, `DONE reason=0 count=1`.
3. **Multicast diag-get — many responders.** `diag-get ff03::1 0 1 8` returns ≥ 10 responses (all routers) within 5 s, terminated by `DONE reason=0 count=N`. **Office Entrance keypad appears in the output on first button press during the window.** This is the canonical acceptance case for the entire Phase B effort.
4. **Regression — CCX comms unaffected.** `ccx` shell status still shows `ROUTER` role. `RX`/`TX` counters still increment during normal CCA/CCX activity. A zone-dim command still dims the zone. Keypad button presses still produce CCX broadcasts in `tools/nucleo.ts`.

### Rollback path

If any of the above fails persistently:

```bash
npx tsx tools/nrf/nrf-dfu-flash.ts --rollback
```

Restores the known-good firmware. No git-surgery required.

## Plan 2 preview (out of scope for this spec, separate future plan)

Once Plan 1 is green, Plan 2 wires the proven Spinel properties into production:

- `firmware/src/ccx/tmf_ext.{h,cpp}` — `ccx_send_diag_get()`, `ccx_send_diag_reset()`, `ccx_neighbor_table()`, `ccx_child_table()`. Callback hook that emits `[diag]` stream broadcasts.
- `firmware/src/shell/shell.cpp` — new `ccx diag get/reset/neighbors/children` shell commands.
- `lib/ccx-diag.ts` — TS parser for `[diag] src=... tlv=...\r\n` broadcasts.
- `tools/ccx/tmf-diag.ts` — switch from the dead port-61631 path to the new Spinel channel. Original Phase B success criterion satisfied.

## References

- `docs/superpowers/plans/2026-04-21-stable-ccx-addressing-tmf-diag.md` — predecessor plan; its Phase 5 TMF discovery path ran into the NCP filter, establishing the need for this spec.
- `docs/protocols/ccx-coap.md` § "NCP restriction on port 61631" — reproducer for the original failure, committed 2026-04-21.
- `tools/nrf/ncp-build/build.sh` — existing NCP build pipeline.
- `tools/nrf/ncp-build/nucleo-uart.patch` — existing patch (UART pins / baud / HWFC override).
- `.claude/skills/nrf/SKILL.md` — nRF52840 dongle / NCP / sniffer workflow notes.
- `openthread/openthread#853` — upstream issue documenting which OT APIs are not exposed via Spinel.
