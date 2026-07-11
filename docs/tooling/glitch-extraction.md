# Firmware Extraction via Reset-Time Voltage Glitch (proposal)

*A campaign plan to non-destructively defeat HCS08 flash security (FSEC) with a voltage glitch, so secured Lutron S08 devices can be read out over BDM instead of mass-erased.*

> **Status:** proposal / campaign plan — **not yet run.** No exploit has been executed
> and no firmware/keys have been extracted. Per this repo's convention
> (`CLAUDE.md`: security research — exploits, vulnerability writeups, extracted keys —
> is maintained outside this repository), **relocate any actual results, dumps, or
> extracted keys to the external security location**, and move this plan there too if
> preferred. It lives here for now only so it links from
> [`bdm-recovery.md`](bdm-recovery.md) and isn't lost.

## Goal

Non-destructively read out flash from **secured Freescale S08 (MC9S08QE128)** Lutron
devices — by defeating the flash-security bit with a voltage glitch, instead of the
destructive mass-erase (which wipes the very firmware we want and clears the per-unit
serial).

**Concrete driver (2026-07):** a bricked RMJ-16R was flashed with the LMJ LDF image and
verified byte-perfect but **would not boot** — the firmware makes 17 `JSR`/`JMP` into a
factory **low-flash library at CPU `0x2080–0x3FFF`** that the OTA LDF does NOT ship
(the LDF only covers CPU `0x4000+`), and the mass-erase we needed to unsecure the part
wiped the factory copy. That ~16 KB library exists in **no file we have** (see
`powpak-firmware-re-binja` memory). The only way to get it is a **full-flash dump of a
working PowPak** — which, since production units are secured, means this glitch.
So a glitch dump is now a hard prerequisite for any CCA HCS08 firmware conversion:
you need the *complete* target image (bootloader + low-flash library + app), not the LDF.
Also generalizes to extracting the per-model AES key from encrypted eagle-owl/PFF firmware.

Capture script: [`tools/firmware/glitch-capture.py`](../../tools/firmware/glitch-capture.py)
(its header is the full rig spec; the USBDM read/dump side is already proven —
`bdm-flash-qe128.py` reads the linear flash array via the LAP pointer).

## Why a glitch works

HCS08 flash security is **not cryptographic** — it's a state latched from flash at
reset:

- Every reset, the chip loads the nonvolatile options byte **NVOPT (`0xFFBF`)** into
  the **FOPT** register; `SEC[1:0]` there sets the security state (`0b10` = unsecured,
  any other value = secured). The BDC then blocks flash reads while secured.
- A well-timed **Vcc dip during the reset-time load/latch of the SEC bits** can make
  FOPT come up **unsecured for the entire session** → BDM reads all of flash. **One
  good glitch unlocks the session** — no per-byte work.
- The backdoor-key path (NVBACKKEY `0xFFB0-7`, KEYEN) is infeasible: the key sits in
  unreadable flash, and brute-forcing 8 bytes is out.

## What we already have (reuse)

- A **working BDM entry to this exact secured part**: cold power-on with BKGD held low
  → active-background halt → `SDID = 0x3015`. Full procedure in
  [`bdm-recovery.md`](bdm-recovery.md#in-system-bdm-entry-on-a-secured-running-powpak-bench-log-2026-07).
- [`tools/firmware/bdm-prog.py`](../../tools/firmware/bdm-prog.py) reads
  SDID/registers/RAM fine; **flash currently returns `0x00`** (secured). The glitch
  only needs to flip that to real data — then the existing read/dump path works
  unchanged.

## Rig

- **Crowbar:** a fast low-Rds N-MOSFET (logic-level, fast gate driver) shorting the
  MCU Vcc to GND for **~50–500 ns**.
- **Power:** a **stiff bench 3.3 V** to the die through a small series **R (~1–10 Ω)**
  or ferrite, so the crowbar can actually dip the rail *at the chip*. The USBDM JS16's
  TVDD is too weak and **can't be switched** (see `bdm-recovery.md`), so it's no use
  for glitching — use bench power.
- **Timing/trigger:** `t=0` from the **RESET edge** (the pod drives RESET; tap it).
  Sweep **delay** (tens of ns → a few µs after reset release) × **glitch width**. Use a
  **ChipWhisperer** (purpose-built: crowbar + parametric glitch + trigger/measure) or a
  DIY delay generator (RP2040/Teensy/FPGA).
- **Read side:** the USBDM pod + `bdm-prog.py` for the post-glitch BDM read.

## Campaign

1. **Loop:** hold RESET+BKGD low, arm glitcher, release RESET (its rising edge = t=0,
   hardware-triggers the crowbar at `(delay, width)`), then BDM-sync in background mode.
2. **Success detector (clean):** read **`FOPT` (0x1821)** — `(FOPT & 3) == 0b10` means
   the SEC latch came up **UNSECURED**. Confirm with a flash read (reset vector at linear
   `0x0FFFE` ≠ `0x00`), then **dump the full 128 KB linearly** via the LAP pointer
   (`LAP2:LAP0=0x79-0x7b`, read `LBP=0x7d` auto-increment) — same read path as
   `bdm-flash-qe128.py`, covering linear `0x00000–0x1FFFF` in one sweep (no PPAGE
   juggling needed). This is exactly what `glitch-capture.py` does.
3. **Sweep** `(delay, width)` on a grid; log each outcome
   (no-effect / reset-loop / hang / **UNLOCKED**). Expect a narrow winning window;
   refine around partial hits.
4. **Confirm:** capture ≥2 independent successful dumps and diff for integrity.

A `glitch → BDM-read → detect → auto-dump` driver can be scripted on top of
`bdm-prog.py` once an injector is on the bench (the read/detect half already works).

## Success criteria / caveats

- **Success** = a full, self-consistent flash image: valid reset vector, sane HCS08
  code, the DeviceClass at body `0x8AD`, and the per-unit serial.
- Lots of resets/hangs are normal; each is harmless — recover by power-cycle. Budget
  an afternoon of parameter sweeping. S08 is generally considered glitchable.

## Extensions

- **Per-read glitch** fallback if the reset-time latch proves stubborn: glitch on each
  flash-read command as the BDC evaluates security.
- **eagle-owl / PFF key (the real payoff):** the same reset-time-security defeat,
  applied to a secured **eagle-owl** device, would expose the bootloader region where
  the **per-model AES key** lives — decrypting the eagle-owl/basenji/bananaquit PFFs we
  already hold and unblocking the MRF→HQR firmware-conversion work that motivated all
  of this. (See the PFF key discussion in
  [`../devices/coprocessor-firmware.md`](../devices/coprocessor-firmware.md) and
  [`../protocols/cca/end-devices.md`](../protocols/cca/end-devices.md).)

## Equipment shopping list

- **ChipWhisperer-Lite/Husky** (recommended) — or crowbar MOSFET + fast gate driver +
  RP2040/Teensy/FPGA delay generator.
- Bench 3.3 V supply, series R / ferrite, an oscilloscope for tuning, and the USBDM pod
  for the BDM read side.

## Safety

- Bench-only, isolated. **Do not power the PowPak from mains during glitching** — feed
  bench 3.3 V to the MCU rail directly; the module's SMPS may be non-isolated
  (line-referenced ground → shock/fry hazard when tied to USB ground).
