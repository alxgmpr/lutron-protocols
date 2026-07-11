#!/usr/bin/env python3
"""
Reset-time FSEC voltage-glitch capture loop for MC9S08QE128 (PowPak) — dump a
SECURED working device's full flash so we can recover the ~16KB low-flash library
that the OTA LDF doesn't ship (see powpak-firmware-re-binja memory / bdm-recovery.md).

WHY THIS WORKS (established this session):
  HCS08 flash security is NOT cryptographic. Every reset, the flash module loads
  NVOPT(0xFFBF) -> FOPT(0x1821); SEC[1:0]=0b10 => unsecured, anything else => secured,
  and the BDC then blocks flash reads (they return 0x00). A well-timed Vcc dip during
  that reset-time SEC latch can make FOPT come up 0b10 for the whole session => BDM can
  read all of flash. ONE good glitch unlocks the session; no per-byte work.

SUCCESS DETECTOR (clean): after the glitch, BDM-connect and read FOPT(0x1821).
  (FOPT>>0)&3 == 0b10  ->  UNSECURED. Confirm with a flash read (0xFFFE != 0x00), then dump.

================================ RIG =========================================
Target: a WORKING, secured PowPak (any variant — the low-flash library is shared
        across PowPak builds; we only need a bootable sibling to dump).

Power / injection (the glitch):
  - Feed a STIFF bench 3.3V to the MCU VDD (QE128 pin 4 and/or 30) through a small
    series R ~2-5 ohm (or a ferrite) so a crowbar can dip the rail AT the die.
  - REMOVE the MCU's local VDD decoupling cap(s) (100nF next to the MCU) — they
    absorb the glitch. Leave bulk cap on the supply side of the series R.
  - Crowbar: a fast logic-level N-MOSFET, drain=MCU-VDD (die side of series R),
    source=GND, gate driven by the glitcher. Shorts VDD->GND for ~50-500 ns.
  - The USBDM JS16 CANNOT switch Vdd (established) — do NOT power the target from it.

Signals:
  - RESET  (QE128 pin 47): driven by the USBDM pod (control_pins). Its RISING edge
    (reset release) is t=0 for the glitch.
  - BKGD/PTA4 (pin 48): held LOW by the USBDM across the reset so the CPU halts in
    active background mode (unsecured or not) and we can read FOPT/flash.
  - Glitch trigger: the glitcher triggers on the RESET rising edge (tap RESET), then
    fires the crowbar at (delay, width). Because it triggers off the real RESET line,
    it stays synced regardless of USBDM host-timing jitter.

Glitcher (pick one):
  A) ChipWhisperer-Husky/Lite/Nano  (recommended: crowbar + parametric ext_offset/
     width + edge trigger, all in one). Fill in CWGlitcher below with pyusb/chipwhisperer.
  B) DIY: RP2040/Teensy/FPGA delay-gen + the MOSFET crowbar, armed over serial and
     hardware-triggered by RESET. Fill in SerialGlitcher below.

Read side: this script uses the repo's USBDM client (bdm-prog.py) for RESET/BKGD
control and the LAP linear-read (LAP2:LAP0=0x79-0x7b, read LBP=0x7d auto-increment)
to dump the whole 0x00000-0x1FFFF flash array once unlocked.

Sweep: reset-time SEC latch lands µs..tens-of-µs after RESET release. Start
  delay 0..80us (step ~0.5us), width 40..400ns. Expect a narrow winning window;
  refine around partial hits (resets/hangs are harmless — power-cycle and retry).
==============================================================================
"""
import sys, time, struct, importlib.util

_spec = importlib.util.spec_from_file_location(
    "bdmprog", __file__.rsplit("/", 1)[0] + "/bdm-prog.py")
bp = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(bp)

FOPT = 0x1821
LAP2, LAP1, LAP0, LBP, LB = 0x0079, 0x007A, 0x007B, 0x007D, 0x007E
RESET_VEC = 0x0FFFE   # linear addr of CPU reset vector; non-0x00 on a real device


# ---- glitcher backends: fill ONE in for your hardware -----------------------
class Glitcher:
    """Abstract. arm(delay_ns, width_ns) sets params; the crowbar must then fire
    automatically on the next RESET rising edge (hardware trigger)."""
    def arm(self, delay_ns, width_ns): raise NotImplementedError
    def close(self): pass


class CWGlitcher(Glitcher):
    """ChipWhisperer. glitch.ext_offset = delay in clock cycles; width in cycles.
    Trigger source = the RESET rising edge on a tio/gpio pin. Skeleton — wire to
    your CW clock so ns<->cycles is exact."""
    def __init__(self, clk_hz=100_000_000):
        import chipwhisperer as cw          # noqa: F401  (import here so the file loads without CW)
        self.scope = cw.scope()
        self.clk = clk_hz
        self.scope.glitch.clk_src = "clkgen"
        self.scope.glitch.output = "enable_only"     # crowbar-style
        self.scope.glitch.trigger_src = "ext_single" # RESET edge -> trigger
        self.scope.io.hs2 = "glitch"                 # crowbar MOSFET gate on HS2
    def arm(self, delay_ns, width_ns):
        c = self.clk / 1e9
        self.scope.glitch.ext_offset = max(0, round(delay_ns * c))
        self.scope.glitch.repeat = max(1, round(width_ns * c))
        self.scope.arm()
    def close(self):
        try: self.scope.dis()
        except Exception: pass


class SerialGlitcher(Glitcher):
    """DIY RP2040/Teensy over serial. Firmware: on 'A d w\\n' arm; wait for a rising
    edge on the RESET input pin; after d ns fire the MOSFET gate high for w ns."""
    def __init__(self, port="/dev/tty.usbmodemGLITCH", baud=921600):
        import serial
        self.s = serial.Serial(port, baud, timeout=1)
    def arm(self, delay_ns, width_ns):
        self.s.write(f"A {delay_ns} {width_ns}\n".encode()); self.s.flush()
    def close(self):
        try: self.s.close()
        except Exception: pass


# ---- USBDM control + read ----------------------------------------------------
def reset_with_bkgd_low_and_glitch(bdm, glitcher, delay_ns, width_ns):
    """Hold RESET+BKGD low, arm the glitcher, release RESET (its rising edge fires
    the crowbar at delay/width), then sync in background mode."""
    bdm.control_pins(bp.PIN_BKGD_LOW | bp.PIN_RESET_LOW)
    glitcher.arm(delay_ns, width_ns)
    time.sleep(0.002)
    bdm.control_pins(bp.PIN_BKGD_LOW | bp.PIN_RESET_3STATE)   # RESET rising edge = t=0
    time.sleep(0.01)
    bdm.control_pins(bp.PIN_BKGD_3STATE)
    try:
        bdm.connect()
    except bp.USBDMError:
        pass   # sync may fail on a bad glitch (reset loop/hang) — treated as no-unlock


def is_unsecured(bdm):
    try:
        fopt = bdm.read_byte(FOPT)
    except Exception:
        return None
    return (fopt & 0x03) == 0b10, fopt


def read_flash_lin(bdm, lin, n):
    bdm.write_byte(LAP2, (lin >> 16) & 1)
    bdm.write_byte(LAP1, (lin >> 8) & 0xFF)
    bdm.write_byte(LAP0, lin & 0xFF)
    return bytes(bdm.read_byte(LBP) for _ in range(n))


def dump_full_flash(bdm, path="powpak-full-dump.bin"):
    print(f"UNLOCKED — dumping 128KB to {path} ...")
    bdm.write_byte(LAP2, 0); bdm.write_byte(LAP1, 0); bdm.write_byte(LAP0, 0)
    data = bytearray()
    for i in range(0x20000):
        data.append(bdm.read_byte(LBP))         # auto-increments LAP
        if (i + 1) % 0x1000 == 0:
            print(f"  {i+1}/0x20000", end="\r")
    open(path, "wb").write(bytes(data))
    print(f"\nsaved {len(data)} bytes -> {path}")


def main():
    # sweep grid (ns)
    delays = range(0, 80_000, 500)      # 0..80us step 0.5us
    widths = range(40, 400, 40)         # 40..360ns
    repeats = 3

    which = sys.argv[1] if len(sys.argv) > 1 else "serial"
    glitcher = CWGlitcher() if which == "cw" else SerialGlitcher(
        sys.argv[2] if len(sys.argv) > 2 else "/dev/tty.usbmodemGLITCH")
    bdm = bp.USBDM(); bdm.set_target(bp.T_HCS08); bdm.set_vdd(bp.VDD_3V3)

    tried = 0
    try:
        for d in delays:
            for w in widths:
                for _ in range(repeats):
                    tried += 1
                    reset_with_bkgd_low_and_glitch(bdm, glitcher, d, w)
                    res = is_unsecured(bdm)
                    if res and res[0]:
                        # confirm with a flash read
                        rv = read_flash_lin(bdm, RESET_VEC, 2)
                        print(f"\n*** SEC=unsecured at delay={d}ns width={w}ns "
                              f"(FOPT=0x{res[1]:02X}); reset-vec={rv.hex(' ')}")
                        if rv != b"\x00\x00":
                            dump_full_flash(bdm)
                            return
                        print("  (FOPT unlocked but flash still 0 — retrying)")
                if (d // 500) % 20 == 0:
                    print(f"  swept delay={d}ns width<= {w}ns  ({tried} attempts)", end="\r")
        print(f"\nno unlock in {tried} attempts — widen delay/width, check crowbar/decoupling")
    finally:
        glitcher.close(); bdm.close()


if __name__ == "__main__":
    main()
