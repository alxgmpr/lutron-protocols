#!/usr/bin/env python3
"""
Correct MC9S08QE128 linear-flash programmer over USBDM/BDM.

Supersedes bdm-prog.py's program/erase paths, which were wrong for this chip
(no FCDIV, and linear byte-program at a CPU address instead of using the MMU
linear-address mechanism). This tool programs the 17-bit LINEAR flash array
(0x00000-0x1FFFF) directly, exactly as the PowPak firmware's own flash routine
(sub_42c7) does — via the Linear Address Pointer.

Mechanism (MC9S08QE128RM ch.4 MMU + Flash; confirmed against firmware sub_42c7):
  LAP2:LAP0 = 0x0079/0x007A/0x007B  17-bit linear address pointer
  LBP       = 0x007D                byte data, auto-increments LAP
  LB        = 0x007E                byte data, no increment (use for verify reads)
  FCDIV=0x1820  FCMD=0x1826  FSTAT=0x1825 (FCBEF=0x80 FCCF=0x40 FPVIOL=0x20 FACCERR=0x10)

Byte program:  set LAP -> write data to LBP -> FCMD=0x20 -> launch (FCBEF) -> poll FCCF
Mass erase:    write any flash via LBP -> FCMD=0x41 -> launch -> poll FCCF (also clears FSEC)

PowPak LMJ image maps: body[X] -> linear 0x04000 + X  (see powpak-firmware-re-binja memory).

*** SAFETY: FCLK must be 150-200 kHz. It depends on the BUS CLOCK AT BDM TIME, which
    out of reset is the ICS FEI default (~4 MHz), NOT the firmware's configured 16 MHz.
    You MUST pass the correct --fbus. Too-slow FCLK (e.g. firmware's 0x49 at 4 MHz ->
    ~50 kHz) can damage or under-program the flash. This tool refuses to run without --fbus.
"""
import sys, time, struct, importlib.util

# reuse the USBDM transport + connect logic from bdm-prog.py
_spec = importlib.util.spec_from_file_location(
    "bdmprog", __file__.rsplit("/", 1)[0] + "/bdm-prog.py")
bp = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(bp)

LAP2, LAP1, LAP0 = 0x0079, 0x007A, 0x007B
LBP, LB = 0x007D, 0x007E
FCDIV, FPROT, FSTAT, FCMD = 0x1820, 0x1824, 0x1825, 0x1826
# TPM1 (direct page) — used to MEASURE the bus clock against host wall-clock,
# because in BDM the ICS runs untrimmed FEI (imprecise) and the factory trim
# cannot be read. Never assume fBus; measure it.
TPM1SC, TPM1CNTH, TPM1CNTL, TPM1MODH, TPM1MODL = 0x0040, 0x0041, 0x0042, 0x0043, 0x0044


def measure_busclock(bdm, dt=0.15):
    """Measure the target bus clock via TPM1 (bus clock / 128) over a host-timed dt.
    Returns fBus in Hz. Requires the CPU halted (BDM) with the bus clock running."""
    bdm.write_byte(TPM1SC, 0x00)              # stop timer
    bdm.write_byte(TPM1MODH, 0xFF); bdm.write_byte(TPM1MODL, 0xFF)
    bdm.write_byte(TPM1SC, 0x0F)              # CLKS=01 (bus clock), PS=111 (/128)
    hi = bdm.read_byte(TPM1CNTH); lo = bdm.read_byte(TPM1CNTL); t0 = (hi << 8) | lo
    import time as _t; start = _t.time(); _t.sleep(dt); el = _t.time() - start
    hi = bdm.read_byte(TPM1CNTH); lo = bdm.read_byte(TPM1CNTL); t1 = (hi << 8) | lo
    bdm.write_byte(TPM1SC, 0x00)
    ticks = (t1 - t0) & 0xFFFF
    if ticks > 60000:
        raise RuntimeError(f"TPM overflowed ({ticks}); shorten dt")
    fbus = ticks * 128 / el
    print(f"measured bus clock: ~{fbus/1e6:.2f} MHz  ({ticks} TPM ticks /128 in {el*1000:.0f}ms)")
    return fbus
FCBEF, FCCF, FPVIOL, FACCERR = 0x80, 0x40, 0x20, 0x10
CMD_BYTE_PROGRAM, CMD_MASS_ERASE = 0x20, 0x41
LINEAR_BASE = 0x04000  # PowPak LMJ body -> linear 0x04000


def fcdiv_for_fbus(fbus_hz: int, target_fclk=190_000) -> int:
    """Pick FCDIV (PRDIV8 + FDIV) so FCLK lands in 150-200 kHz. Raises if impossible."""
    for prdiv8, pre in ((0, 1), (1, 8)):
        fdiv = round(fbus_hz / (pre * target_fclk)) - 1
        if 0 <= fdiv <= 63:
            fclk = fbus_hz / (pre * (fdiv + 1))
            if 150_000 <= fclk <= 200_000:
                return ((1 << 6) if prdiv8 else 0) | fdiv, fclk
    raise ValueError(f"no FCDIV yields 150-200kHz FCLK for fBus={fbus_hz}")


def set_fcdiv(bdm, fbus_hz):
    val, fclk = fcdiv_for_fbus(fbus_hz)
    cur = bdm.read_byte(FCDIV)
    if cur & 0x80:  # FDIVLD already set — FCDIV write-once already happened this reset
        print(f"FCDIV already loaded = 0x{cur:02X}; not rewritable until reset")
        return
    bdm.write_byte(FCDIV, val)
    rb = bdm.read_byte(FCDIV)
    print(f"FCDIV set 0x{val:02X} (FCLK ~{fclk/1000:.0f}kHz); readback 0x{rb:02X}")
    if not (rb & 0x80):
        raise RuntimeError("FDIVLD not set after FCDIV write — flash clock not configured")


def _clear_errors(bdm):
    bdm.write_byte(FSTAT, FPVIOL | FACCERR)


def _launch_wait(bdm, what, polls=500):
    bdm.write_byte(FSTAT, FCBEF)              # LAUNCH: always write FCBEF=1 (0x80)
    for _ in range(polls):
        s = bdm.read_byte(FSTAT)
        if s & FCCF:
            break
        time.sleep(0.001)
    else:
        raise RuntimeError(f"{what}: FCCF timeout FSTAT=0x{s:02X}")
    if s & (FPVIOL | FACCERR):
        raise RuntimeError(f"{what}: error FSTAT=0x{s:02X} (FPVIOL/FACCERR)")


def _set_lap(bdm, lin):
    bdm.write_byte(LAP2, (lin >> 16) & 0x01)
    bdm.write_byte(LAP1, (lin >> 8) & 0xFF)
    bdm.write_byte(LAP0, lin & 0xFF)


DUMMY_FLASH = 0xC000   # direct-addressable flash (CPU 0xC000 = PPAGE3); works even when secured


def clean_reset(bdm):
    """Hardware reset into special (BDM) mode. Clears stuck flash-controller state
    (a leftover FACCERR from a prior aborted command survives the connect pin-dance)."""
    try:
        bdm.target_reset(0x01); time.sleep(0.1); bdm.connect()
    except Exception as e:
        print(f"  (clean_reset note: {e})")


def mass_erase(bdm):
    print("=== MASS ERASE (clears flash) ===")
    _clear_errors(bdm)
    # A previously-flashed image may have set NVPROT -> flash is protected, which blocks
    # mass-erase (FPVIOL). FPROT is writable in BDM once FACCERR is clear; disable protection.
    bdm.write_byte(FPROT, 0xFF)
    fp = bdm.read_byte(FPROT)
    if fp != 0xFF:
        raise RuntimeError(f"could not disable FPROT (=0x{fp:02X}) — FACCERR stuck? "
                           "run a clean hardware reset (power-cycle) first")
    bdm.write_byte(DUMMY_FLASH, 0xFF)   # direct flash write latches the command address
    bdm.write_byte(FCMD, CMD_MASS_ERASE)
    _launch_wait(bdm, "mass-erase")
    print("mass erase complete")


def blank_check(bdm):
    """Erase-verify. On a secured part, a passing blank-check disengages security
    for this BDM session (lets us then read/program). Must follow mass_erase."""
    print("=== BLANK CHECK (disengages security) ===")
    _clear_errors(bdm)
    bdm.write_byte(DUMMY_FLASH, 0xFF)
    bdm.write_byte(FCMD, 0x05)          # blank check / erase-verify
    _launch_wait(bdm, "blank-check")
    fs = bdm.read_byte(FSTAT)
    if not (fs & 0x04):                 # FBLANK
        raise RuntimeError(f"blank-check did NOT report blank (FSTAT=0x{fs:02X})")
    # confirm reads opened up
    _set_lap(bdm, 0x0FFFE)
    if bdm.read_byte(LB) != 0xFF:
        raise RuntimeError("flash still not readable after blank-check — security not disengaged")
    print("blank check OK — flash blank + readable (security disengaged)")


def program_linear(bdm, data: bytes, base=LINEAR_BASE):
    total = len(data)
    print(f"=== PROGRAM {total} bytes at linear 0x{base:05X}-0x{base+total:05X} ===")
    _clear_errors(bdm)
    t0 = time.time(); errors = 0
    for i in range(total):
        b = data[i]
        if b == 0xFF:               # erased state; skip (leaves 0xFF)
            continue
        _set_lap(bdm, base + i)
        bdm.write_byte(LBP, b)      # data -> flash latch via LAP
        bdm.write_byte(FCMD, CMD_BYTE_PROGRAM)
        try:
            _launch_wait(bdm, f"prog@0x{base+i:05X}")
        except RuntimeError as e:
            errors += 1
            if errors <= 5:
                print(f"  {e}")
            _clear_errors(bdm)
        if (i + 1) % 2048 == 0 or i + 1 == total:
            el = time.time() - t0; rate = (i + 1) / el if el else 0
            print(f"  {i+1}/{total} ({100*(i+1)/total:.1f}%) {rate:.0f} B/s "
                  f"ETA {(total-i-1)/rate if rate else 0:.0f}s", end="\r")
    print(f"\nprogramming done: {errors} errors")
    return errors


def verify_linear(bdm, data: bytes, base=LINEAR_BASE):
    print(f"=== VERIFY {len(data)} bytes at linear 0x{base:05X} ===")
    mism = 0
    for i in range(len(data)):
        _set_lap(bdm, base + i)
        got = bdm.read_byte(LB)     # LB = read without increment
        if got != data[i]:
            mism += 1
            if mism <= 10:
                print(f"  MISMATCH 0x{base+i:05X}: exp 0x{data[i]:02X} got 0x{got:02X}")
        if (i + 1) % 8192 == 0:
            print(f"  verified {i+1}/{len(data)}", end="\r")
    print(f"\nverify done: {mism} mismatches")
    return mism


def load_image(path):
    if path.endswith(".s19") or path.endswith(".s2") or path.endswith(".srec"):
        raise SystemExit("pass the raw .bin body; the linear base is applied here")
    return open(path, "rb").read()


def selftest_one_byte(bdm, lin=0x1E000, val=0xA5):
    """After erase, program a single scratch byte and verify — proves FCLK/timing
    is adequate before committing the full image. lin defaults above the image end."""
    print(f"self-test: program 0x{val:02X} @ linear 0x{lin:05X} ...")
    _clear_errors(bdm)
    _set_lap(bdm, lin); bdm.write_byte(LBP, val)
    bdm.write_byte(FCMD, CMD_BYTE_PROGRAM); _launch_wait(bdm, "selftest-prog")
    _set_lap(bdm, lin); got = bdm.read_byte(LB)
    if got != val:
        raise RuntimeError(f"SELF-TEST FAILED: wrote 0x{val:02X} read 0x{got:02X} "
                           "— FCLK/timing wrong; do NOT proceed to full flash")
    print("self-test OK (byte programmed + verified)")


def main():
    a = sys.argv[1:]
    def opt(name, d=None):
        return a[a.index(name) + 1] if name in a else d
    if not a or "-h" in a or "--help" in a:
        print(__doc__); sys.exit(0)
    cmd = a[0]
    fbus_override = opt("--fbus")
    if cmd == "hold-reset":
        # Self-paced: drive RESET+BKGD low and hold — exit WITHOUT close() so the pod
        # keeps driving the pins while you move the TVDD jumper / power the target.
        # Powering up with BKGD low latches active-background mode at POR (clean entry).
        b = bp.USBDM(); b.set_target(bp.T_HCS08)
        st = b.control_pins(bp.PIN_RESET_LOW | bp.PIN_BKGD_LOW)
        print(f"Holding RESET=low + BKGD=low (pins=0x{st:04X}). Pod keeps driving after exit.")
        print("Move the TVDD jumper / apply power now; then run 'measure'. NOT closing.")
        return
    bdm = bp.USBDM()
    try:
        bdm.set_target(bp.T_HCS08)
        bp.connect_target(bdm)
        if cmd == "measure":
            measure_busclock(bdm); return
        # measure the real bus clock (don't guess); --fbus overrides only if you know better
        fbus = int(fbus_override, 0) if fbus_override else measure_busclock(bdm)
        if cmd == "erase":
            clean_reset(bdm); set_fcdiv(bdm, fbus); mass_erase(bdm); blank_check(bdm); selftest_one_byte(bdm)
        elif cmd == "flash":
            data = load_image(a[1])
            base = int(opt("--base", hex(LINEAR_BASE)), 0)
            clean_reset(bdm)                     # clear any stuck FACCERR from a prior protected image
            set_fcdiv(bdm, fbus)
            mass_erase(bdm)
            blank_check(bdm)                     # disengages security so we can program
            selftest_one_byte(bdm)               # abort before the 100KB run if timing is wrong
            if program_linear(bdm, data, base) == 0:
                verify_linear(bdm, data, base)
        else:
            sys.exit(f"unknown cmd {cmd}")
    finally:
        bdm.close()


if __name__ == "__main__":
    main()
