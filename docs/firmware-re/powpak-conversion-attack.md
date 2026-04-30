# PowPak RMJ/RMJS → LMJ conversion attack — plan & state

**Status (2026-04-29):** Protocol RE complete, bootloader RE shows no active DeviceClass cross-check, **synth-OTA-TX builders + Phase 2a `cca ota-begin` shell command landed** (TDD against captured-on-air ground truth, all 154 firmware tests pass, ARM build clean). Awaiting hardware test for Phase 2a (subnet recon).

**Goal:** flash a non-smart PowPak (RMJ standalone for ESN, or RMJS for Vive) with smart firmware (LMJ for RA2/RA3/HWQS), entirely RF-side from a Nucleo+CC1101, bypassing every Lutron host system. End state: a device that physically exists as an RMJ/RMJS now boots as an LMJ and pairs to an RA3 processor.

## Architectural framing

The PowPak family (RMJ / RMJS / LMJ / LMQ / LMK across 434 MHz / 868 MHz variants) shares physical hardware. They differ in:

- **DeviceClass byte at LDF body offset `0x8AD`** — `0x16/0x03/0x02/0x01` for RMJ vs `0x16/0x08/0x02/0x01` for LMJ
- **Host system pairing** — RMJ pairs only to ESN, RMJS only to Vive, LMJ only to RA2/3/HWQS
- **Compiled firmware** — LMJ and RMJ `.ldf` images differ by **95.98% of bytes** (only 4.02% identical). They are NOT "same code with one byte patched"; they are separately compiled.
- **Strings** — both binaries carry the same Lutron hardware-SKU strings (`RMJ-16R-DV-B`, `RMJ-CCO1-24-B`, `RMJ-UNDEFINED`) regardless of protocol family. The "RMJ-" prefix is Lutron's hardware naming, distinct from the protocol-family designation we use elsewhere.

## What we know (RE complete)

### On-air OTA wire protocol — runtime CCA, not raw-bit (live-capture confirmed 2026-04-28..04-29)

Earlier static-RE claimed OTA used a separate raw-bit framing on a different channel. Live capture against a Caseta Pro REP2 + DVRF-6L disproved this:

- **Same channel as runtime CCA** (`433.602844 MHz`, `Project.SystemRFChannel = 26` in bridge SQLite)
- **N81 framing** with `0xFA DE` sync, CRC-16 / `0xCA0F`
- **OTA-specific packet types** ride the standard CCA framing, with sub-opcodes at body bytes 14-15

### Standard CCA packet header (bytes 2-7)

| Byte | Field | Notes |
|---|---|---|
| 0 | type | `0xB1`-`0xB3` long chunk; `0x91`/`0x92` short unicast; `0x81`/`0x83` short broadcast; etc. |
| 1 | sequence | TDMA / retx counter |
| 2 | flags | `0xA0` first packet / `0xA1` retx; high nibble varies by class (0xA cmd, 0x2 state) |
| 3-4 | **subnet** | BE 16-bit, **`Project.SubnetAddress`** in bridge SQLite (`0xEFFD` for the captured Caseta) |
| 5 | pair_flag | `0x00` normal / `0x7F` during pairing |
| 6 | proto | `0x21 = QS_PROTO_RADIO_TX` |
| 7 | body length sig | `0x2B` long, `0x0E`/`0x0C`/`0x08` short variants |

The `0xC1+` response cluster has a slightly shifted layout (no sequence byte at offset 1, subnet at bytes 2-3).

### On-air sub-opcodes (bytes 14-15 = `06 nn`)

| `06 nn` | Operation | Carrier | Confirmed |
|---|---|---|---|
| `06 00` | **BeginTransfer** | `0x92` unicast | YES — payload `02 20 00 00 00 1F` (trailing `1F` = chunk size 31; leading 5 bytes' meaning open) |
| `06 01` | **ChangeAddressOffset** | `0x91` unicast | YES — payload `00 PREV 00 NEW` (16-bit BE page indices) |
| `06 02` | **TransferData** | `0xB2`/`0xB3` long (3-arm TDMA, `0xB1` rare/absent) | YES — 31-byte chunk verbatim from PFF/LDF body |
| `06 03` | **Device-poll / pre-flight** | `0x81/82/83` broadcast (DeviceClass at bytes 9-12) or `0x91/92` unicast (serial at bytes 9-12) | YES — body filler `cc cc cc cc cc cc` |

**The bootloader's dispatcher accepts MORE sub-opcodes than seen on-air:**

| Sub-op | Bootloader CALL | Notes |
|---|---|---|
| `02` TransferData | `CALL $009B, #$2F` | seen on-air |
| `01` ChangeAddrOff | `CALL $009A, #$F6` | seen on-air |
| `03` Poll | `CALL $009A, #$B0` | seen on-air |
| **`04` (new)** | `CALL $009B, #$CD` | NOT seen on-air — likely EndTransfer/CommitImage/CodeRevision |
| **`05` (new)** | `CALL $009B, #$B5` | NOT seen on-air |
| (default) | `CALL $0292, #$67` | error/fallback |

### Device-side ACK channel (`0x0B` XOR-encoded, NOT 8N1)

99.95% of `0x0B` packets validate as dimmer-ACKs. 5 bytes:
- `[0]` = `0x0B`
- `[1]` = sequence (cycles `0x02→04→06→08→0A→0C` between chunks)
- `[2]` = format ^ 0xFE (the actual status code)
- `[3]` = byte[1] ^ 0x26 (integrity check)
- `[4]` = format ^ 0x55 ^ 0xFE (redundant XOR-shadow of [2])

The corrected `format` byte is the **device's state code** during OTA:

| `format` | Phase | Inferred state |
|---|---|---|
| `0x2E` | Steady-state TransferData | "in-progress, idle" (89.7% of OTA) |
| `0xC1` | Pre-first-chunk | "ready / handshake" |
| `0xC2` | Around page wrap | "advancing page" |
| `0xEC` | Post-last-chunk | "committing / done" — **the one we watch for to confirm successful flash** |

Decoder rule: `firmware/src/cca/cca_decoder.h:309 try_parse_dimmer_ack`. The device emits 1 ACK every 25 ms regardless of bridge traffic. **Status-only — there is no per-chunk NACK or retransmit-request channel.**

### `0xC1+` response cluster — bridge-internal beacon, NOT device response

6-packet cluster (`0xC1, 0xC7, 0xCD, 0xD3, 0xD9, 0xDF`) fires every ~10.85 s for the full OTA window. Same body across all 6 types within a burst (6-way TDMA, like B1/B2/B3 chunks). Byte 6 is a decrementing counter `0x3F → 0x00 → wrap`; byte 11 toggles between `0x3F`/`0x3A`/`0x24`. **This is the bridge's master-presence beacon, NOT a device response.** Synth-TX from Nucleo doesn't need to emit these.

### EndTransfer / ResetDevice / CodeRevision / QueryDevice on-air

**Were NOT seen on-air during the captured 19-minute OTA.** The bridge fires BeginTransfer + chunk stream + ChangeAddressOffset and stops. The device's bootloader autonomously commits when it has the full firmware, then reboots.

**However** — bootloader sub-ops `0x04` and `0x05` (above) might be on-air-callable variants the bridge didn't exercise during the captured OTA. Worth probing during hardware test.

## What we know (PowPak HCS08 bootloader RE)

### Section structure (PowPakRelay434L1-53.ldf body, 102KB total)

- **Section A** = bootloader / platform code (`0x00..0xe92b`, 59,539 bytes)
- **Section B** = relay application (`0xe92c..end`, 42,977 bytes)
- Boundary marked by `Copyright 2008 Lutron Electronics` banner at `0x038a` (start of A) and `0xe92c` (start of B).
- LDF body bit-identical to the `.bin` loaded in BN/Ghidra — both sections present.

### Key bootloader code anchors (Section A offsets)

| Offset | What |
|---|---|
| `0x0000..0x001F` | 32-byte load-directive table (byte-identical between LMJ and RMJ; format not yet decoded) |
| `0x008AD` | **DeviceClass** = `16 08 02 01` (LMJ for this binary; the byte that distinguishes RMJ from LMJ) |
| `0x01a23` | **OTA sub-op dispatcher** (reads byte 6 of an inner buffer, branches to handlers via banked CALL) |
| `0x02d70..0x02d80` | **DeviceClass match function** (`CMP #$16; CMP #$08; CMP #$02; CMP #$01` with wildcard support) — **DEAD CODE: zero references anywhere in the binary** |
| `0x052c0` / `0x05714` | CCA `0xFA DE` sync detection (bootloader has its own CCA RX) |
| `0x05900..0x05f30` | Flash-write region — OTA chunk-receive flash programming |
| `0x05e78` / `0x05f1b` / `0x05f23` | FSTAT/FCMD writes (HCS08 flash control) |
| `0x49b2..0x49f1` | String table: `RMJ-16R-DV-B`, `RMJ-CCO1-24-B`, `RMJ-UNDEFINED` (Lutron hardware SKU names) |
| `0xbfb2` | FCDIV write (chip clock divider — only one per binary, runs at boot) |

### Chip family

Has `LDA $181E` (LAP register) used **143 times** in Section A — characteristic of HCS08 PA/LH/LL family with linear flash addressing. **Not** standard DZ/QE-family banked PPAGE-at-`$001F`. Page bytes in CALL instructions (0x2F, 0xF6, 0xB0, etc.) likely index into function-pointer tables resolved via LAP, not into 16KB physical flash banks.

### Trampolines (RAM-resident, populated at boot)

Three banked CALL trampolines at zero-page RAM addresses:
- `$009A` (used by sub-ops `0x01`, `0x03` and other call sites — 9 callers total)
- `$009B` (used by sub-ops `0x02`, `0x04`, `0x05` — 5 callers total)
- `$0292` (default fallback, 28 call sites — most often page byte `0x67`)

Each trampoline takes the page byte as an argument and dispatches to flash code. The exact handler addresses are not yet decoded (would require disassembling extended-flash regions and the RAM-init code that copies the trampolines from flash).

### Deadly silent: NO DeviceClass cross-check active in the bootloader

**Critical finding for the conversion attack.** The bootloader contains the hardware to compare an incoming DeviceClass against its own (the function at `0x2db1`), but **nothing calls it**. Verified:
- Zero JSR ext (`CD HH LL`) targeting `0x2d70..0x2d80`
- Zero banked CALL (`AC HH LL PP`) targeting it
- Zero relative branches reaching it
- Zero data references (function pointer tables) to it
- BN's xrefs view also reports zero

So the implied gate "the bootloader rejects cross-class flashes" is empirically absent. The OTA path has no active DeviceClass validation we've found.

### What's still unknown about the bootloader

1. **CRC32 / signature verification at OTA-end** — likely exists. The expected value source is unknown (could be derived from BeginTransfer payload `02 20 00 00 00 1F`, or computed at OTA-end and compared against a known good).
2. **NVPROT-imposed flash write-protection range** — `NVPROT byte = 0xCC`, but PA/LH chip family decoding of FPS bits is chip-specific. Worst case: bootloader region itself is write-protected. Best case: only specific small regions are protected (e.g., the load-directive table at `0x00..0x1F`).
3. **Sub-ops `0x04` and `0x05` semantics** — the bootloader handles them but we never saw them on-air. Hypothesis: they're EndTransfer / ResetDevice / CommitImage variants triggered by the bridge in conditions our captured OTA didn't exercise.
4. **Banked function-pointer table** — reading the RAM-init code that populates the trampolines would tell us where the actual handler functions live.

## What we know (live capture corpus + tooling)

### Capture artifacts on disk

- `/Users/alex/lutron-tools/data/captures/cca-ota-20260428-190439.rf.bin` (5.7 GB, gitignored) — 19-min IQ capture of Caseta Pro REP2 → DVRF-6L OTA at 2 Mhz sample rate
- `/Users/alex/lutron-tools/data/captures/cca-ota-20260428-190439.packets.jsonl` — every decoded packet (45,130 entries) over the OTA window 37s..1130s
- `/Users/alex/lutron-tools/data/captures/cca-pair-20260428-175549.rf.bin` + transcript — 547-packet pairing capture, same Caseta bridge
- `/Users/alex/lutron-tools/data/firmware/dvrf6l-v3.021.pff` (187,060 bytes) — source firmware that 90.7% of decoded chunks match byte-exact

### Tooling that landed in this PR

- `tools/ota-extract.ts --dump-all <jsonl>` — extends existing chunk reassembler to emit every decoded packet (all types) as JSONL for downstream analysis. **The JSONL is the corpus** — no other tool needed for control-packet decode.
- `tools/decrypt-lutron-firmware.sh` (existing) — bundle decryption with `6cba80b2bf3cf2a63be017340f1801d8`
- `tools/ldf-extract.py` (existing) — strips 0x80-byte LDF header to expose plaintext HCS08 image

### Updated reference docs

- [docs/protocols/cca.md §9 Firmware OTA Wire Protocol](../protocols/cca.md#9-firmware-ota-wire-protocol) — full rewrite to reflect on-air format (vs the old static-RE'd raw-bit description, which we now know is the host↔coproc IPC layer)
- [docs/firmware-re/cca-ota-live-capture.md](cca-ota-live-capture.md) — capture writeup with decoded sub-opcodes, packet layouts, ACK-channel state machine
- [docs/firmware-re/powpak.md](powpak.md) Bootloader-unknowns section — partial PowPak HCS08 RE findings
- [docs/firmware-re/caseta-cca-ota.md](caseta-cca-ota.md) — Phoenix EFR32 coproc dispatcher RE notes

### Updated TypeScript constants (`protocol/cca.protocol.ts`)

- New: `OTAOnAirSubOpcode` (`BEGIN_TRANSFER=0x00, CHANGE_ADDRESS_OFFSET=0x01, TRANSFER_DATA=0x02, POLL=0x03`)
- New: `OTADeviceAckState` (`IN_PROGRESS=0x2E, READY=0xC1, ADVANCING_PAGE=0xC2, COMMITTING=0xEC`)
- Renamed: `OTAOpcode → OTACoprocIPCOpcode` (with backward-compat alias) — these are the static-RE'd values, now correctly labeled as host↔coproc IPC, not on-air
- Removed wrong claim: `HOP_CHANNELS: 35` (it's single-channel)

## Hardware test plan (next session)

### Goal

Validate the conversion attack end-to-end: TX an LMJ `.ldf` body to a real RMJS device via Nucleo+CC1101, watch the device's ACK fmt byte transition through `0xC1 → 0x2E → 0xC2 → 0xEC`, then power-cycle and verify it pairs to an RA3 processor as LMJ.

### What's needed

| Item | Source | Notes |
|---|---|---|
| Nucleo H723ZG + CC1101 module | existing benchtop setup | the firmware in `firmware/src/cca/` already does runtime CCA TX/RX |
| RTL-SDR (RTL2832U/R820T2) | existing | for monitoring device ACKs |
| Target RMJS unit | TBD by user | factory-fresh or unpaired from any Vive controller |
| LMJ `.ldf` source firmware | already on disk | `data/designer-firmware/QuantumResi/.../powpak modules/PowPakRelay434L1-53.ldf` |
| LDF body extraction | `tools/ldf-extract.py` | strip 0x80 header → 102,516-byte plaintext body |
| Subnet to use | TBD | for a fresh attack, use a benign value like `0xEFFD` (matches our captured Caseta) or generate fresh; see "Attack params" below |

### Attack params

Constructing a valid TX requires picking values for fields that are normally bridge-side state:

- **Subnet** (bytes 3-4 of every packet) — `0xEFFD` works for our captured Caseta. For a fresh attack, the device may accept any subnet during initial pairing or factory state. Empirically test by trying multiple subnets.
- **Target device serial** (bytes 9-12) — read off the RMJS unit's product label.
- **BeginTransfer payload `02 20 00 00 00 1F`** — copy from our captured OTA verbatim. The trailing `0x1F` is the chunk size (31 bytes); leading 5 bytes' meaning is unknown but the captured value is known-good for at least the DVRF-6L case.
- **ChangeAddressOffset** — fire at every 64 KB page boundary in the LDF body. Payload bytes 16-19 = `00 PREV 00 NEW` where PREV/NEW are the page indices (0, 1, 2, ...).
- **TransferData chunks** — 31 bytes each from the LDF body, in order, with `addrLo` advancing by `0x1F` (31) per packet, wrapping at 64 KB.

### Step-by-step protocol

**Phase 2a — subnet recon (LANDED, awaiting hardware)**

The captured-OTA subnet `0xEFFD` is `Project.SubnetAddress` from a paired bridge's runtime DB. Per [cca-ota-live-capture.md §"On-air OTA wire protocol"](cca-ota-live-capture.md#byte-2-7-are-the-standard-cca-header-not-ota-specific), devices learn their subnet during pairing and filter incoming packets that don't match. **An unpaired RMJ never pairs (no host system addresses it via subnet) and an unpaired RMJS hasn't yet learned a subnet — both presumably fall back to the factory default `0xFFFF`.** That's hypothesis #1 to test.

`cca ota-begin <subnet> <serial> [dur]` — emits BeginTransfer packets at the captured cadence (~75 ms apart). Wired into the existing CCA TX engine via `CCA_CMD_OTA_BEGIN_TX`; uses the new builders in `firmware/src/cca/cca_ota_tx.h` (TDD against captured-on-air ground truth, all bytes byte-for-byte verified).

Hardware test procedure:

1. Read the target RMJ's serial off the product label (8 hex digits).
2. Power on RMJ (factory-fresh, never paired).
3. Start RTL-SDR capture at the runtime CCA channel (`433.602844 MHz`) and stream into a JSONL via `npx tsx tools/cca/ota-extract.ts --dump-all <out>.jsonl --capture <iq>` running in the background.
4. From the Nucleo shell: `cca ota-begin ffff <serial> 5` (TX BeginTransfer for 5 s with subnet `0xFFFF`).
5. Look for `type:0x0B` packets in the JSONL stream. The decoder (`firmware/src/cca/cca_decoder.h:309 try_parse_dimmer_ack`) XOR-decodes the format byte; we want `format=0xC1` (READY) to indicate the device entered OTA receive mode.
6. If no `0xC1` seen with `0xFFFF`: sweep candidates `0x0000`, `0xFFFE`, `0x82D7`, `0xEFFD`. Record which, if any, triggers `0xC1`.
7. If still no `0xC1`: the bootloader RX path may not accept on-runtime-channel packets in factory state at all. Next step: capture an actual ESN→RMJ transaction (if user has access to ESN) to see what address path the host uses for unpaired devices, OR drill into the bootloader's RX dispatcher (BN `0x92be` containing the FA DE sync check) to identify factory-state acceptance criteria.

**Phase 2b — full OTA TX (NOT YET BUILT — needs subnet recon result first)**

Adds `CCA_CMD_OTA_FULL_TX` that:
1. Receives an LMJ LDF body via the TCP stream protocol (one or more ~32 KB chunks)
2. Buffers it in Nucleo SRAM (~102 KB; well within RAM_D1 320 KB)
3. Runs the full BeginTransfer → 3,300× TransferData → ChangeAddrOff sequence at the captured cadence
4. Emits progress to UART log

Once Phase 2a confirms a working subnet, building Phase 2b is mechanical (the builders + chunk iterator are already done in `cca_ota_tx.h` — only the orchestration is missing).

**Phase 2c — monitor ACK transitions**

Watch device-side `0x0B` ACKs in real-time during the full OTA. Decode XOR via `try_parse_dimmer_ack` and watch the `format` byte:
- Expected start: `0xC1` (READY) — if NEVER seen, device didn't enter receive mode → BeginTransfer payload may need revisiting
- Expected mid-OTA: `0x2E` (IN_PROGRESS) — if stalls, decoder/CRC issue on our TX side
- Expected at page wraps: `0xC2` (ADVANCING_PAGE) — if missing, ChangeAddrOff format is wrong
- Expected at end: `0xEC` (COMMITTING) — **success signal**. If never seen, the device received chunks but bootloader rejected commit — likely CRC verification failure.

**Phase 3 — power-cycle and pair test**

After seeing `0xEC`, power-cycle the RMJ. Try to pair to an RA3 processor. If it pairs as LMJ, attack succeeded. **RMJS unit is not to be bricked — only test on RMJS once the protocol is fully validated against RMJ.**

### Decision tree at each stall point

| Stall | Likely cause | Fix |
|---|---|---|
| No `0xC1` after BeginTransfer | Subnet mismatch | Try subnet from RMJS's prior pairing (capture during pairing first); or sweep a few subnet values |
| `0xC1` but no `0x2E` after first chunk | Chunk format wrong | Verify CRC, byte ordering, sequence-byte advancement |
| `0x2E` but no `0xC2` at page boundary | ChangeAddrOff format wrong | Verify payload byte ordering, the 16-bit page index encoding |
| `0xC2` reached but no `0xEC` at OTA end | CRC verification failed at commit | The `02 20 00 00 00 1F` BeginTransfer payload may need a real value (not the captured DVRF-6L value); coproc RE needed (Phoenix EFR32, IPC opcode `0x2A` handler) |

### Risks & mitigations

- **Brick the device.** Mitigation: only target devices we're willing to lose. After successful BDM-recovery becomes possible (or deemed a viable backup), the risk drops.
- **HCS08 SEC bit blocks BDM read.** If the device boots and we can't read its flash post-attack, we can still erase + re-flash via BDM blind. So worst-case we lose factory data but not the device.
- **Subnet rejection at every value.** If the bootloader requires a SPECIFIC subnet (e.g., one matching its prior commissioning), we may need to capture the RMJS during pairing to learn its expected subnet. Easy enough to set up.
- **Signature/CRC at commit.** If the commit step verifies a signature over the body (not just CRC), we may need to RE the verification logic. The Phoenix EFR32 coproc IPC `0x2A` handler is the place to start (BN entry points at `0x08018c18` / `0x08018c98`; load the larger phoenix binary `_8003000-803FF08.bin`).

## 2026-04-29: Brick incident on RMJ 0x00BC2107 (line-voltage RMJ-16R-DV-B)

**Status: device is non-responsive.** No power-up LED flash, no button-press LED flash, no relay click. Pre-test it had normal LED behavior (intermittent flash on power-up + button press). Recovery via RF unsuccessful through 25+ attempts. Recovery requires BDM — see [powpak-bdm-recovery.md](powpak-bdm-recovery.md).

### TX sequence in chronological order

All transmits at 433.602844 MHz, runtime CCA framing, against unpaired factory-fresh RMJ (serial `0x00BC2107`, DeviceClass `0x16/0x03/0x02/0x01`):

1. **`cca ota-begin ffff 00bc2107 1`** — 1-second BeginTransfer burst (~13 packets). `0x92` unicast, sub-op `06 00`, payload `02 20 00 00 00 1F`, subnet `0xFFFF`.
   - This is the most likely culprit. The bootloader's BeginTransfer handler at section-A `0x1a23` likely (a) accepted the packet despite no prior pairing, (b) executed a flash-erase of the application section in preparation for the new image, (c) parked the chip in OTA-receive mode waiting for chunks.
   - We never sent valid TransferData chunks. The application section was erased but never refilled. The bootloader is alive but has nothing to boot.
2. Subsequent broadcasts (`cca broadcast`, `cca level`, `cca raw` with various class/component bytes) — these likely had no effect because the chip was already in OTA-wait mode and only listens for `06 nn` sub-opcodes, not runtime control packets.
3. **`cca ota-begin ffff 00bc2107 5`** — 58 BeginTransfer packets at subnet `0xFFFF`. If the chip was already in OTA mode from step 1, this resent the same Begin which may have re-erased and reset the OTA window.
4. **Subnet sweep** (`0x0000`, `0xFFFE`, `0xEFFD`, `0x82D7`, `0x1234`, `0xABCD`) — 105 BeginTransfer packets across 6 subnets.
5. **Recovery attempts** (`cca raw` with sub-ops `0x04`, `0x05`, `0x06`-`0x0F`, `0xFF` against unicast 0x91 and broadcast 0x81) — none recovered.
6. **`cca ota-begin` then sub-op `04` spam** — sequence intended to BeginTransfer + immediately abort. No effect.

### Hypothesis on the brick mechanism

**Most likely**: BeginTransfer (sub-op `0x00`) at any subnet was sufficient to make the unpaired bootloader execute a flash-erase of the application region. The bootloader has no `subnet` filter at the BeginTransfer-RX stage in factory state — it simply matches its serial in bytes 9-12 (`0x00BC2107`) and accepts. Once erased, it cannot revert to the old app because the old app no longer exists in flash. It can only be reflashed.

This is consistent with the observed symptoms:
- Power-up LED flash gone: the application owns the LED toggle in the boot sequence; if the app is erased, the LED never gets driven.
- Button-press LED flash gone: same code path (application).
- Relay never clicks: relay is application-controlled.
- No on-air response to any sub-op: the bootloader's RX dispatcher requires the chip to first execute `cc1101_init` (or equivalent), which runs in the application's startup code. With no application, the radio never initializes.

### Implications for RMJS / LMJ targets

**DO NOT send `cca ota-begin` against the RMJS unit (the unit we don't want to brick) until subnet/handshake is fully validated against a sacrificial RMJ.** The same flash-erase will fire on first BeginTransfer regardless of what we plan to do next.

Lessons:
1. BeginTransfer is destructive, not exploratory. The first packet erases the application.
2. Need a way to test reachability *without* triggering the OTA flash-erase. Probable candidates: `06 03` Device-poll (no payload, observed in captured OTA pre-flight, less likely to trigger erase) or pairing-stage packets (B0/B8/B9). Verify what response, if any, an unpaired device gives to those before attempting BeginTransfer.
3. The next live-fire test should target a DIFFERENT sacrificial RMJ — not the bricked one — and use Device-poll (`06 03`) first to confirm RX is alive, *then* BeginTransfer only after confirming the device responds.

### Reachability matrix that yielded no response (pre-brick, first RMJ)

For the record — none of these elicited an `0x0B` ACK from the unpaired RMJ before it was bricked:

| Method | bytes 3-4 (subnet) | bytes 9-12 | byte 13 | Result |
|---|---|---|---|---|
| `cca level` (unicast) | zone bytes | serial BE | FE | silent |
| `cca broadcast` | zone | FF FF FF FF | FF | silent |
| Raw broadcast w/ DevClass | 00 00 | 16 03 02 01 | FF | silent |
| Raw broadcast w/ DevClass + subnet=FFFF | FF FF | 16 03 02 01 | FF | silent |
| Raw 0x83 + DevClass + RELAY component (06 38) | 00 00 | 16 03 02 01 | FF | silent |
| Raw 0x83 + DevClass + format 09 CTRL | 00 00 | 16 03 02 01 | FF | silent |
| Raw 0x83 + DevClass + pair_flag=7F | 00 00 | 16 03 02 01 | FF | silent |
| Raw 0x83 + 5-byte broadcast (FF×5) | 00 00 | FF FF FF FF FF | (n/a) | silent |

**No subnet, no addressing mode, and no command class produced an `0x0B` XOR-ACK from the unpaired device on any of those tests** — *before* the brick. This is a separate concern from the brick itself: it suggests an unpaired factory-fresh RMJ does not respond to runtime CCA commands of any kind we tried. Either the bootloader RX path is dormant until something specific wakes it, or the application's RX-side filtering rejects everything that doesn't match a paired-state subnet+zone.

The successful capture we have (Caseta REP2 → DVRF-6L) was always against a *paired* device. We have no captured ESN→RMJ exchange to compare against. Acquiring such a capture (if an ESN system is available) is now the highest-value next step before any further OTA work.

## Open questions (in rough priority order)

1. ~~**Will the device subnet-filter our packets?**~~ — **Resolved 2026-04-29** (further bootloader RE pass). The bootloader's sync-detect at body `0x52BF` (`CPHX #$FADE; BNE +0x6C`) sets a state flag at `$0F3E` on match without any subnet/serial/DeviceClass filter. The bootloader silently accepts any packet matching its serial. Subnet sweeping was unnecessary. The reachability matrix's silent rejection of runtime-CCA addressing modes is explained by the APPLICATION (Section B) requiring paired-state filters, NOT by the bootloader filtering. See [powpak.md §"Sync-detect / unpaired-state RX"](powpak.md#sync-detect--unpaired-state-rx-q3).

2. **What do the leading 5 bytes of BeginTransfer payload mean?** — **Partially resolved 2026-04-29**. The HDLC IPC payload built by the Phoenix coproc is `40 00 00 00 00 00`, NOT the on-air `02 20 00 00 00 1F` we captured. The on-air bytes are constructed by a layer downstream of the HDLC IPC handler — `0x80160e8` is the next-level function called with the 6-byte HDLC buf. The `0x02` and `0x20` likely come from per-device PFF metadata (image type, page count) read from the OTA state struct at `0x200028A4`. See [caseta-cca-ota.md §"Phoenix EFR32 IPC 0x113 BeginTransfer handler chain"](caseta-cca-ota.md#phoenix-efr32-ipc-0x113-begintransfer-handler-chain-2026-04-29).

3. **Did sub-op `0x00` BeginTransfer cause the brick?** — **Mechanism identified 2026-04-29**. The bootloader's OTA dispatcher at body `0x1A23` has NO explicit handler for sub-op `0x00`. It falls to the default block (body `0x1A5C`):
   ```
   TSX; CLR $02,X; CALL $0292, #$67
   ```
   `$0292` is the **flash-write primitive** (decoded from body `0x0292`: standard HCS08 FSTAT/FCMD pattern). The default block page-aligns the flash address (CLR $02,X clears low byte) and invokes the primitive with **whatever FCMD the dispatcher's caller pre-set**. There is NO guard.

   **Open**: confirm the FCMD value the OTA-RX path sets in its caller frame before invoking the dispatcher. Strong hypothesis: PAGE_ERASE (`0x40`) for "prepare next page". If confirmed, sub-op `0x00` (and any other unrecognized sub-op) erases a flash page. 32 dispatcher fallback sites all use `CALL $0292,#$67`, so this is uniform across the bootloader. See [powpak.md §"$0292 is the flash-write primitive"](powpak.md#0292-is-the-flash-write-primitive--sub-op-0x00-routes-there-directly).

4. **Sub-ops `0x04`/`0x05` semantics** — **Partially resolved 2026-04-29**. Hand-decoded the dispatcher:
   - sub-op `0x04` → `CALL $009B, #$CD` (also reached on sub-op `0x06` via `CBEQA #$06`)
   - sub-op `0x05` → `CALL $009B, #$B5`
   The trampolines `$009A`/`$009B` are flash-resident handler entry points (PA family linear flash addressing — NOT RAM-copied). Body offset `0x9A`/`0x9B` contain function prologues. The CALL convention sets PPAGE/LAP register to the page byte (e.g., `0xCD` or `0xB5`) at entry, which the handler uses to index a function table. Specific operation semantics still require tracing the handler's own table lookup — one or both could plausibly trigger flash erase or commit. **DO NOT spam these against a non-sacrificial target.**

5. **NVPROT flash-protection range** — does it cover Section A? If yes, can't update bootloader. Empirically test by attempting to write to Section A region first; observe via SDR whether device acknowledges.

6. **Does the RMJ→LMJ DeviceClass change persist across power cycle?** Required for the device to pair as LMJ after commit. Tested implicitly by pair-test step 3.

7. **Does the OTA-RX caller pre-set FCMD = PAGE_ERASE before invoking the dispatcher?** — Highest-leverage remaining RE question. Trace the 25 dispatcher prelude sites (body `0x1A14`, `0x1D9A`, etc.) backward to find the OTA-RX state machine that calls them. Look for `LDA #$40; STA $X+09,X` (or equivalent) in the OTA-RX path. **Without this confirmation, the brick mechanism is hypothetical.** With confirmation, every probe of an unrecognized sub-op against an unpaired RMJ becomes a potential page-erase, and the conversion attack feasibility hinges on never sending an unrecognized sub-op (or on initiating sub-op `0x02` chunks before any `0x00`/unknown).

## Files reference (this branch)

```
docs/firmware-re/
├── powpak-conversion-attack.md       ← THIS FILE (plan)
├── cca-ota-live-capture.md           ← capture writeup, on-air protocol decode
├── caseta-cca-ota.md                 ← Phoenix EFR32 coproc dispatcher RE
└── powpak.md                         ← PowPak HCS08 bootloader RE

docs/protocols/
└── cca.md                            ← rewritten §9 with on-air format

protocol/
└── cca.protocol.ts                   ← OTAOnAirSubOpcode, OTADeviceAckState constants

tools/
├── ota-extract.ts                    ← --dump-all flag for full-packet JSONL
├── ldf-extract.py                    ← strip LDF header (existing)
└── decrypt-lutron-firmware.sh        ← bundle decryption (existing)

firmware/src/cca/
├── cca_decoder.h:309                 ← try_parse_dimmer_ack — XOR-ACK decoder rule
├── cca_tx_builder.h                  ← existing CCA TX builder
├── cca_ota_tx.h                      ← NEW: synth-OTA-TX builders (BeginTransfer, TransferData, ChangeAddrOff, chunk iter)
├── cca_pairing.cpp                   ← exec_ota_begin (Phase 2a subnet recon TX loop)
└── cca_commands.h                    ← CCA_CMD_OTA_BEGIN_TX = 0x1C

firmware/tests/
└── test_ota_tx.cpp                   ← 15 TDD tests against captured-on-air ground truth

data/
├── captures/cca-ota-20260428-190439.rf.bin             ← 19-min IQ capture (gitignored)
├── captures/cca-ota-20260428-190439.packets.jsonl      ← 45,130 decoded packets
├── captures/cca-pair-20260428-175549.transcript.txt    ← 547-pkt pairing capture
├── firmware/dvrf6l-v3.021.pff                          ← reference firmware (90.7% match)
└── designer-firmware/.../powpak modules/
    ├── PowPakRelay434L1-53.ldf                         ← LMJ source (target firmware)
    └── PowPakRelay434_1-49.LDF                         ← RMJ comparison (4.02% body match)

data/firmware-re/powpak/
├── PowPakRelay434L1-53.bin                             ← LDF body, BN binary
├── split/section_a_bootloader.bin                      ← bootloader (0..0xe92b)
├── split/section_b_app.bin                             ← application (0xe92c..end)
└── ghidra_project/                                     ← Ghidra project, both sections imported
```

## Anchors for the next RE session (if needed before hardware)

If hardware test stalls and deeper RE is needed:

- **Phoenix EFR32 coproc IPC `0x2A` handler** — load `data/firmware/phoenix-device/coprocessor/phoenix_efr32_8003000-803FF08.bin` (249KB, the larger binary — Ghidra currently has the smaller 117KB one) into Ghidra. The 5 dispatcher functions identified earlier (`0x080190a8`, `0x080192d4`, `0x08019490`, `0x08019724`, `0x080199d8`) construct outgoing packets; the data structures they reference live past the current Ghidra segment's end.
- **PowPak banked CALL targets** — the trampoline at RAM `$009A`/`$009B` is populated at boot from flash. Find the RAM-init code (`memcpy`-style copy from flash to `0x009A`) to learn what handler addresses the page bytes index into. Once decoded, load the relevant flash region into Ghidra and disassemble the TransferData / sub-op-04 / sub-op-05 handlers.

## Memory pointers (`/Users/alex/.claude/projects/-Users-alex-lutron-tools/memory/`)

- `reference-cca-ota-wire-protocol.md` — full protocol scorecard (updated this session)
- `project-powpak-pairing-rules.md` — RMJ→ESN, RMJS→Vive, LMJ→RA2/3/HW family rules
- `feedback-powpak-is-pure-cca.md` — PowPaks are 433 MHz CCA only, not QS-Link
- `project-designer-doesnt-ota-cca.md` — Designer only updates CCX; CCA OTA is host-system-driven
