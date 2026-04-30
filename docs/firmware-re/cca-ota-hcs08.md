# CCA OTA — HCS08 mode (HW-CCA dimmers + PowPak)

Notes on extending [`tools/cca/ota-tx.ts`](../../tools/cca/ota-tx.ts) and [`lib/cca-ota-tx-builder.ts`](../../lib/cca-ota-tx-builder.ts) to drive on-air OTA against HCS08-based devices — HW-CCA dimmers (HQR/HWQS/MRF2 family, DeviceClass `0x04xxxxxx`) and PowPaks (family `0x16xxxxxx`).

## Why this code path matters

The Phoenix RA3 IPL HW-CCA OTA path is dead (verified 2026-04-30 via Binary Ninja decompile of `lutron-core` v26.02.15f000): `CCA_LINK_DRIVER` vtable[0xc0] is a 2-instruction `mov r0,#0; bx lr` stub, so `IPL opId 272 UpdateDeviceFirmware` reaches TASKLINK and silently returns 0 without doing anything on-air. Designer doesn't OTA HW-CCA via Phoenix RA3 either. See [`reference-phoenix-hwcca-ota-prerequisite-271.md`](file:///Users/alex/.claude/projects/-Users-alex-lutron-tools/memory/reference-phoenix-hwcca-ota-prerequisite-271.md).

So driving the openBridge directly via `STREAM_CMD_TX_RAW_CCA` is the only path. The TS host-side OTA driver in `tools/cca/ota-tx.ts` was already calibrated against the captured Caseta REP2 → DVRF-6L OTA — DVRF-6L is BASENJI / EFR32. Adapting it to HCS08 is the topic here.

## What's the same as EFR32

Per the cross-MCU bootloader RE in [`powpak.md`](powpak.md) and [`powpak-conversion-attack.md`](powpak-conversion-attack.md), the HCS08 bootloader's on-air RX path looks structurally identical to the EFR32 case. The on-air protocol fields that match byte-for-byte:

- **Outer N81 framing** — `[55 55 55][FF][FA DE][LEN][TYPE][...][CRC16(0xCA0F)]`. The Nucleo's framer adds these around the pre-CRC body the builder emits.
- **Type bytes** — `0x91/0x92` short unicast, `0xB1/0xB2/0xB3` long unicast (3-arm TDMA cycle). Same dispatch.
- **Header layout** (bytes 0-13) — `[type][seq][flags=0xA1][subnet:2 BE][pair_flag=0][proto=0x21][bodyLenSig][0x00][serial:4 BE][0xFE]`. The HCS08 bootloader's sync-detect at body `0x52BF` is `CPHX #$FADE; BNE $5330` with no subnet/serial/DeviceClass filter — it accepts any sync-matching packet, then filters at the OTA dispatcher level by serial + sub-opcode.
- **Sub-opcode pattern** (`06 nn` at bytes 14-15) — confirmed via PowPak HCS08 dispatcher decode at body `0x1A23`. The dispatcher branches on the same sub-op byte the EFR32 capture used:
  - `06 00` BeginTransfer → falls through to default → `CALL $0292, #$67` (flash-write primitive)
  - `06 01` ChangeAddressOffset → `CALL $009A, #$F6`
  - `06 02` TransferData → `CALL $009B, #$2F`
  - `06 03` Poll → `CALL $009A, #$B0`
  - `06 04` / `06 06` → `CALL $009B, #$CD` (semantics unknown; not seen on-air in the EFR32 capture)
  - `06 05` → `CALL $009B, #$B5` (semantics unknown)
- **Chunk size** — 0x1F = 31 bytes per TransferData. Encoded both in BeginTransfer payload trailer and TransferData header byte 19.
- **64 KB wire-page semantics** — `addrLo` advances by 31 per packet, wraps at `0x10000`, and a `ChangeAddressOffset` packet (payload `00 PREV 00 NEW`) announces the new high-byte page. The HCS08's banked 16 KB physical flash pages are decoupled from the wire-level 64 KB pages: the bootloader's flash-write primitive at body `0x0292` reads a 3-byte address from the caller's stack and resolves it to physical flash via the chip's linear-address mapping.
- **No on-air EndTransfer** — confirmed for EFR32 (the bridge just stops sending TransferData and the device's bootloader autonomously commits). Likely the same for HCS08, but unverified — sub-ops `0x04` / `0x05` may carry close-out semantics the EFR32 capture didn't exercise.

## What might differ

Genuinely unknown until we get a HCS08-OTA ground-truth capture or iterate against a live device. Candidate differences ranked by likelihood:

| Field | EFR32 captured | HCS08 expected | Confidence |
|-------|---------------|----------------|------------|
| BeginTransfer payload bytes 16-20 | `02 20 00 00 00` | unknown | leading 5 bytes' meaning is open even for EFR32; the per-device PFF metadata that produces them likely exists for HCS08 too but in a different form |
| BeginTransfer chunk-size byte (21) | `0x1F` | `0x1F` likely | both bootloaders' TransferData handlers presumably built for the same chunk size, since the dispatcher uses identical CALL targets |
| Page boundary semantics (`06 01` payload) | `00 PREV 00 NEW` (16-bit BE indices) | same likely | HCS08 banked 16 KB flash pages are translated by the bootloader's flash-write primitive — wire-level 64 KB pages are presented to the bootloader as 24-bit addresses |
| Device-side ACK channel | `0x0B` XOR-encoded, 5-byte, `format=0x2E`/`0xC1`/`0xC2`/`0xEC` state machine | likely similar | HCS08 capture would confirm. The decoder rule (`firmware/src/cca/cca_decoder.h:309 try_parse_dimmer_ack`) parses XOR-encoded 5-byte stream; same rule should apply unless HCS08 emits a different format |
| End-of-transfer | none on-air; bootloader self-commits | unknown | sub-ops `0x04`/`0x05` reach handlers but were never seen on-air; potentially used by HCS08 |
| "Already-in-OTA" recovery | n/a | possibly destructive | HCS08 bootloader's default fallback (sub-op `0x00` → flash-write primitive) is currently best-explained as PAGE_ERASE pre-set — see brick incident in [`powpak-conversion-attack.md` §"Brick incident"](powpak-conversion-attack.md) |

## Implementation summary

```
lib/cca-ota-tx-builder.ts
  + McuFamily type ("efr32" | "hcs08")
  + EFR32_BEGIN_TRANSFER_PAYLOAD constant (captured ground truth)
  + HCS08_BEGIN_TRANSFER_PAYLOAD constant (mirrors EFR32 by default)
  + defaultBeginTransferPayload(mcu) helper
  + buildBeginTransfer(subnet, serial, opts?: { payload?: Uint8Array })
  + walkOtaPackets(body, subnet, serial, opts?: { beginTransferPayload?: Uint8Array })

tools/cca/ota-tx.ts
  + --mcu efr32|hcs08 (default efr32; selects MCU-specific defaults)
  + --begin-payload "02 20 00 00 00 1F" (overrides BeginTransfer payload bytes 16-21)
  + --begin-only (emits BeginTransfer, then stops — for non-destructive reachability probing)

test/cca-ota-tx-builder.test.ts
  + 8 new tests covering MCU profiles, payload overrides, error cases, and walker plumbing.
  + Existing 25 tests preserved unchanged — backwards-compatible API.
```

## Dry-run verification

Against `/tmp/lutron-ldfs/HWQS_3PD_3.08.LDF` (DeviceClass `04 24 02 01`, body 109956 bytes):

```
$ npx tsx tools/cca/ota-tx.ts --dry-run --mcu hcs08 \
    --ldf /tmp/lutron-ldfs/HWQS_3PD_3.08.LDF \
    --subnet 0x82D7 --serial 009A36E3 --cadence-ms 0
[ota-tx] LDF: 110084 bytes -> body 109956 bytes (header stripped)
[ota-tx] target subnet=0x82d7 serial=0x009a36e3 mcu=hcs08
[ota-tx] BeginTransfer payload: 02 20 00 00 00 1f (default for hcs08)
[ota-tx] mode=dry-run (no UDP) cadence=0ms
...
[ota-tx] complete: 3547 chunks (3549 packets total)
```

3549 = 1 BeginTransfer + 3547 TransferData + 1 ChangeAddrOff (at the 64 KB page boundary). ChangeAddrOff payload = `00 00 00 01` (page 0 → page 1).

## Iteration workflow on live hardware

The brief from [`reference-phoenix-hwcca-ota-prerequisite-271.md`](file:///Users/alex/.claude/projects/-Users-alex-lutron-tools/memory/reference-phoenix-hwcca-ota-prerequisite-271.md) — for the spoofed MRF2-3PD-1 (subnet `0x82D7`, serial `0x009A36E3`, DeviceClass `0x04240201`, openBridge at 10.1.1.114):

1. **Reachability probe (non-destructive)**: send a single `06 03` Poll (not implemented in this PR; next step). The captured EFR32 OTA used `0x91/06 03` unicast as a pre-flight probe; the HCS08 dispatcher routes `06 03` to `CALL $009A, #$B0` (handler unknown but **not** the flash-write primitive that BeginTransfer falls through to). If the device emits an `0x0B` XOR-ACK in response, we have RX-side reachability without burning a flash page.
2. **Begin-only probe**: `--mcu hcs08 --begin-only` sends one `06 00` BeginTransfer and stops. Watch for `format=0xC1` (READY) ACK on the openBridge capture. If yes, proceed; if no, revise BeginTransfer payload via `--begin-payload`.
3. **Full TX (destructive)**: `--mcu hcs08` with no `--begin-only`. Streams the LDF body. Watch for `format=0x2E` (IN_PROGRESS) during the chunk stream, `format=0xC2` at the page wrap, `format=0xEC` (COMMITTING) at the end.
4. **Power-cycle and re-read DeviceClass** to verify the new image took.

Step 1 (Poll-only probe) needs additional builder code (a `buildPoll` function or extended `walkOtaPackets` mode); not in scope for this PR. The current PR delivers steps 2 and 3.

## Things this PR explicitly doesn't do

- Doesn't add an `06 03` Poll-only TX path. Reachability probing without BeginTransfer would be useful but requires a separate builder function.
- Doesn't expose chunk-size as a parameter. Hardcoded 0x1F at builder level. If HCS08 needs a different chunk size, both the BeginTransfer trailer and TransferData header byte 19 + the OTA_CHUNK_SIZE constant in the iterator need to move together.
- Doesn't differentiate ACK-state-machine decoding by MCU. The `0x0B` decoder in the firmware is calibrated for the EFR32 case; HCS08 ACK validation is unverified.
- Doesn't touch the firmware-side `cca_ota_tx.h` mirror. The host-side TS path is the iteration vehicle; once HCS08 framing is validated, the firmware mirror would follow.
- Doesn't add IPL plumbing. The IPL DataTransfer encoders already in `lib/ipl.ts` are dead-end for HW-CCA OTA per the binary RE; they remain useful as a generic file-upload mechanism for non-firmware purposes.

## References

- [`cca-ota-live-capture.md`](cca-ota-live-capture.md) — captured Caseta REP2 → DVRF-6L OTA; on-air protocol decode against PFF; ACK channel decode.
- [`powpak.md`](powpak.md) — PowPak HCS08 RE (RX-side anchors, dispatcher decode, flash-write primitive, sync-detect).
- [`powpak-conversion-attack.md`](powpak-conversion-attack.md) — conversion-attack plan, brick incident analysis, sub-op routing table.
- [`reference-cca-ota-wire-protocol.md`](file:///Users/alex/.claude/projects/-Users-alex-lutron-tools/memory/reference-cca-ota-wire-protocol.md) — protocol scorecard.
- [`reference-phoenix-hwcca-ota-prerequisite-271.md`](file:///Users/alex/.claude/projects/-Users-alex-lutron-tools/memory/reference-phoenix-hwcca-ota-prerequisite-271.md) — why IPL opId 272 is dead for HW-CCA on Phoenix RA3.
