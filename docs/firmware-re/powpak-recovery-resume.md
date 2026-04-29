# Resume prompt — PowPak BDM recovery session (paste this into a fresh Claude session when USBDM arrives)

Use this verbatim as the opening message of a new Claude Code session. It bootstraps the agent into the right context for the BDM recovery + Phase 2a retry.

---

## Prompt

**Resume PowPak conversion attack — BDM brick recovery + Phase 2a retry**

USBDM hardware just arrived. We bricked one RMJ unit (serial `0x00BC2107`, line-voltage RMJ-16R-DV-B 434 MHz) on 2026-04-29 by sending OTA `BeginTransfer` packets at an unpaired factory-fresh device. Hypothesis: the bootloader accepted BeginTransfer with no subnet check, executed a flash-erase of the application section in preparation for chunks we never sent, and is now stuck with bootloader-alive / app-empty.

**Read these first** (they have the full state):
1. [docs/firmware-re/powpak-bdm-recovery.md](docs/firmware-re/powpak-bdm-recovery.md) — the BDM recovery procedure: HCS08 BKGD/RST/VDD/GND wiring, USBDM software, step-by-step recovery
2. [docs/firmware-re/powpak-conversion-attack.md](docs/firmware-re/powpak-conversion-attack.md) §"2026-04-29: Brick incident" — full TX sequence, brick mechanism, reachability matrix
3. [docs/firmware-re/powpak.md](docs/firmware-re/powpak.md) — PowPak HCS08 bootloader RE, register tables, MCU family hypothesis (MC9S08QE128 family)

## Step 1 — recover the bricked RMJ

**Hardware to confirm with the user**:
- USBDM programmer connected via USB
- Mac or Linux host (driver: USBDM_Programmer GUI or CLI)
- The bricked RMJ unit, opened to expose the PCB

**Do NOT do anything before the user confirms:**
- Photographs of the PCB (top + bottom, MCU clearly visible). Drop them in `data/firmware-re/powpak/` (gitignored). Use them to identify the MCU silkscreen part number.
- BDM access points located: a 4-6 pin header, unpopulated thru-holes, or test pads near the MCU. The user may need to fly-wire to the MCU package directly using the datasheet pinout.

**Recovery commands** (run as the user, after wiring):

```sh
# Confirm USBDM detects the connected target
/Applications/USBDM/USBDM_Programmer.app/Contents/MacOS/USBDM_Programmer \
  --target=MC9S08QE128 --device=MC9S08QE128 --command=connect

# If detect succeeds, run the wrapper to mass-erase + program + verify + reset
tools/firmware/bdm-recovery.sh \
  --target MC9S08QE128 \
  --image data/firmware-re/powpak/PowPakRelay434_1-49.bin
```

Expected outcome:
1. Power LED flashes on power-up.
2. Button-press LED flash works.
3. Device pairs to ESN system if available; otherwise just verify the relay clicks via local button.

**If USBDM detect fails**: check wiring (BKGD↔RST swap is common), 3.3V at MCU VDD, target part number matches `--target` exactly (silkscreen vs. typed). Some MCUs have BDM_DIS fuse that permanently disables BDM — uncommon, but if mass-erase fails after a clean detect, suspect this.

**If `--target MC9S08QE128` is wrong**: ask the user for the silkscreen photo and re-check. Common variants in PowPak units: `MC9S08QE128CLH` (44-pin LQFP, the most likely), `MC9S08LL64CLH` (32-pin LQFP), or older `MC9S08DZ60`. Re-run with the correct part.

## Step 2 — capture an ESN→RMJ exchange BEFORE further OTA tests

**Highest-leverage next investigation.** We have no captured ground truth for what packet format an unpaired RMJ accepts. The Caseta REP2 → DVRF-6L OTA capture we have is for a PAIRED device of a different chip family. We tried 8 different addressing modes against an unpaired RMJ pre-brick — none elicited any RX response. Either the unpaired bootloader is dormant until specifically woken, or the on-air format from an ESN host differs from anything we've tried.

If the user has access to an EnergiSavr Node (ESN) system:
1. Pair an RMJ to the ESN system normally
2. Capture the pairing exchange with `rtl_sdr -f 433602844 -s 2000000 -g 40 -n 60000000 capture.bin` (30 s @ 2 Msps)
3. Decode with `npx tsx tools/cca/rtlsdr-cca-decode.ts --rate 2000000 capture.bin`
4. Identify the ESN-side packet format that wakes the RMJ — that's the addressing scheme to try first in Phase 2a.

If no ESN access: deeper RE on the bootloader RX path (BN `0x92be` containing the FA DE sync check) to identify factory-state acceptance criteria. The plan doc lists the relevant anchors.

## Step 3 — retry Phase 2a SAFELY with the recovered RMJ (or a new sacrificial unit)

**Critical change vs. the bricked attempt: send `06 03` Device-poll FIRST, not BeginTransfer.**

Device-poll has no payload (`cc cc cc cc cc cc` filler) and is observed in the captured Caseta OTA as a pre-flight broadcast. It should NOT trigger flash-erase. If poll gets a `0x0B` ACK back from the unpaired device, we know:
- The radio path is working
- The addressing scheme (subnet/serial/DevClass) is correct

Only THEN escalate to `BeginTransfer`. Add a new shell command if needed:

```c
// firmware/src/cca/cca_pairing.cpp — exec_ota_poll (NEW)
static void exec_ota_poll(uint32_t target_serial, uint16_t subnet, uint8_t duration_sec) {
    // Builds a 0x91 unicast packet with sub-op 06 03, body filler 0xCC.
    // NO flash side effects. Safe pre-flight for unpaired devices.
}
```

Or use `cca raw` to one-shot test:
```
cca raw 0 0 08 91 00 a1 ff ff 00 21 08 00 <SERIAL_BE> fe 06 03 cc cc cc cc cc cc
```

Watch the Nucleo's stream for type `0x0B` packets — XOR-decoded format byte indicates state:
- `0xC1` READY (pre-OTA)
- `0x2E` IN_PROGRESS (during chunks)
- `0xC2` ADVANCING_PAGE (at page wrap)
- `0xEC` COMMITTING (post-OTA, success)

Decoder rule: `firmware/src/cca/cca_decoder.h:309 try_parse_dimmer_ack`.

## Step 4 — DO NOT brick the RMJS

**RMJS unit is OFF-LIMITS for OTA experiments until subnet/handshake is fully validated against a sacrificial RMJ.** The user has both an RMJ and an RMJS; the RMJS pairs to Vive (CCA link type 30) and the user does NOT want to lose it. If sacrifying-by-recovery becomes a habit (we now have BDM tooling), the RMJ is fine to risk; the RMJS is not.

## Hardware available

- Nucleo H723ZG + CC1101 (firmware on `main` branch, working as of 2026-04-29 after the cc1101 wait-loop fix landed in PR #46).
- RTL-SDR (RTL2832U/R820T2) for monitoring.
- USBDM programmer (just arrived).
- 1× bricked RMJ (recovery target) + 1× pristine RMJS (DO NOT brick).

## Files reference

- Bricked-RMJ context: this doc + [powpak-conversion-attack.md](powpak-conversion-attack.md) §"2026-04-29: Brick incident"
- BDM procedure: [powpak-bdm-recovery.md](powpak-bdm-recovery.md)
- BDM wrapper: [tools/firmware/bdm-recovery.sh](../../tools/firmware/bdm-recovery.sh)
- Original RMJ firmware: `data/firmware-re/powpak/PowPakRelay434_1-49.bin` (sha256 `61fdafb984ff79e37ec4ac3af301df518f83cd420727607aca69a31e9187d853`)
- Synth-OTA-TX builders: `firmware/src/cca/cca_ota_tx.h`
- Shell command: `cca ota-begin <subnet> <serial> [dur]` — already wired up; **do not use against an unpaired RMJ before Step 2 + Step 3 above**

## Memory pointers (`/Users/alex/.claude/projects/-Users-alex-lutron-tools/memory/`)

- `reference-cca-ota-wire-protocol.md` — full on-air protocol scorecard
- `project-powpak-pairing-rules.md` — RMJ→ESN, RMJS→Vive, LMJ→RA2/3/HW
- `feedback-powpak-is-pure-cca.md` — PowPaks are 433 MHz CCA
- `feedback-never-bypass-hooks.md` — no `--no-verify` or force-push without explicit permission

## Constraints (re-stated for emphasis)

- **No bricking RMJS.** Verify on RMJ first, always.
- **TDD for any new lib code.** Per CLAUDE.md.
- **No git hook bypassing.** No `--no-verify`, no force-push without explicit user permission.
- **Use venv for Python.** Per global config.
- **Never use `st-flash`.** Always `make flash` (OpenOCD) for STM32.
- **Don't launch Designer.** User-only operation.

## Begin by

1. Confirming USBDM is plugged in and recognized: `system_profiler SPUSBDataType | grep -i usbdm` (Mac) or `lsusb | grep -i USBDM` (Linux).
2. Asking the user for: (a) the bricked PowPak's PCB photos to identify the exact MCU part, (b) where the BDM access points are (header / pads / fly-wire?), (c) whether they have an ESN system available for the Step-2 capture.
3. Walking through the BDM recovery interactively, confirming each step with the user before proceeding.

End-state of this session: bricked RMJ recovered (relay clicks, LED works), and the user has a documented Phase 2a retry plan that won't brick the RMJS.
