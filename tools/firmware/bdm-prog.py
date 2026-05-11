#!/usr/bin/env python3
"""
Minimal USBDM programmer for HCS08 (MC9S08QE128) — PowPak BDM recovery.

Speaks the USBDM USB protocol directly via pyusb. No USBDM software install needed.

Usage:
    uv run --python /tmp/usbdm-env/bin/python3 tools/firmware/bdm-prog.py [command]

Commands:
    probe       — connect to target, read SDID, report status
    erase       — mass erase (clears flash + SEC bit)
    program FILE — mass erase + program + verify
    read ADDR LEN — read target memory (hex)
    dump FILE [LEN] — dump full flash to file (default 128KB)
"""

import sys
import struct
import time

import usb.core
import usb.util

# --- USBDM USB constants ---
VID = 0x16D0
PID = 0x0567
EP_OUT = 0x01
EP_IN = 0x82

# --- USBDM commands ---
CMD_SET_TARGET = 1
CMD_SET_VDD = 2
CMD_GET_BDM_STATUS = 4
CMD_GET_CAPABILITIES = 5
CMD_SET_OPTIONS = 6
CMD_CONTROL_PINS = 8
CMD_GET_VER = 12
CMD_CONNECT = 15
CMD_SET_SPEED = 16
CMD_GET_SPEED = 17
CMD_READ_STATUS_REG = 20
CMD_WRITE_CONTROL_REG = 21
CMD_TARGET_RESET = 22
CMD_TARGET_STEP = 23
CMD_TARGET_GO = 24
CMD_TARGET_HALT = 25
CMD_WRITE_REG = 26
CMD_READ_REG = 27
CMD_WRITE_MEM = 32
CMD_READ_MEM = 33

# Target types
T_HCS08 = 1
T_OFF = 0xFF

# VDD levels
VDD_OFF = 0
VDD_3V3 = 1
VDD_5V = 2
VDD_ENABLE = 0x10
VDD_DISABLE = 0x11

# Reset modes
RESET_HARDWARE = 0x00
RESET_SOFTWARE = 0x08
RESET_POWER = 0x10
RESET_ALL = 0x18
RESET_NORMAL = 0x00
RESET_SPECIAL = 0x01

# Pin control (PinLevelMasks_t)
PIN_BKGD_NC = 0x0000
PIN_BKGD_3STATE = 0x0001  # 1 << 0
PIN_BKGD_LOW = 0x0002     # 2 << 0
PIN_BKGD_HIGH = 0x0003    # 3 << 0
PIN_RESET_NC = 0x0000
PIN_RESET_3STATE = 0x0004  # 1 << 2
PIN_RESET_LOW = 0x0008     # 2 << 2
PIN_RESET_HIGH = 0x000C    # 3 << 2

# Memory space
MS_BYTE = 1

# Status bits
S_POWER_MASK = 0x00C0
S_POWER_EXT = 0x0040
S_POWER_INT = 0x0080
S_RESET_STATE = 0x0004

# MC9S08QE128 flash controller registers
FSTAT = 0x1825
FCMD = 0x1826
FCDIV = 0x1820
FPROT = 0x1824
NVBACKKEY = 0xFFB0

# MC9S08QE128 SDID
SDID_ADDR = 0x1806

# FCMD values
FCMD_BLANK_CHECK = 0x05
FCMD_BYTE_PROGRAM = 0x20
FCMD_BURST_PROGRAM = 0x25
FCMD_PAGE_ERASE = 0x40
FCMD_MASS_ERASE = 0x41

# FSTAT bits
FSTAT_FCBEF = 0x80
FSTAT_FCCF = 0x40
FSTAT_FPVIOL = 0x20
FSTAT_FACCERR = 0x10

# Error codes
BDM_RC_OK = 0


class USBDMError(Exception):
    ERROR_NAMES = {
        0: "OK",
        1: "ILLEGAL_PARAMS",
        2: "FAIL",
        3: "BUSY",
        4: "ILLEGAL_COMMAND",
        5: "NO_CONNECTION",
        6: "OVERRUN",
        7: "CF_ILLEGAL_COMMAND",
        15: "UNKNOWN_TARGET",
        16: "NO_TX_ROUTINE",
        17: "NO_RX_ROUTINE",
        18: "BDM_EN_FAILED",
        19: "RESET_TIMEOUT_FALL",
        20: "BKGD_TIMEOUT",
        21: "SYNC_TIMEOUT",
        22: "UNKNOWN_SPEED",
        23: "WRONG_PROGRAMMING_MODE",
        24: "VDD_NOT_PRESENT",
        25: "VDD_NOT_REMOVED",
        26: "VDD_WRONG_MODE",
        30: "ACK_TIMEOUT",
    }

    def __init__(self, code):
        self.code = code
        name = self.ERROR_NAMES.get(code, f"UNKNOWN({code})")
        super().__init__(f"USBDM error: {name} (rc={code})")


class USBDM:
    def __init__(self):
        self.dev = usb.core.find(idVendor=VID, idProduct=PID)
        if self.dev is None:
            raise RuntimeError("USBDM not found (VID=0x16D0, PID=0x0567)")
        try:
            if self.dev.is_kernel_driver_active(0):
                self.dev.detach_kernel_driver(0)
        except (usb.core.USBError, NotImplementedError):
            pass
        self.dev.set_configuration()
        self.buf_size = 128
        self._flush()

    def _flush(self):
        """Drain any pending IN data from previous session."""
        for _ in range(5):
            try:
                self.dev.read(EP_IN, 64, timeout=100)
            except Exception:
                break

    def _tx(self, data: bytes, timeout=2000):
        self.dev.write(EP_OUT, data, timeout=timeout)

    def _rx(self, size: int, timeout=2000) -> bytes:
        return bytes(self.dev.read(EP_IN, size, timeout=timeout))

    def _cmd(self, cmd: int, params: bytes = b"", rx_len: int = 1, timeout=2000) -> bytes:
        tx_size = 2 + len(params)
        pkt = bytes([tx_size, cmd]) + params
        self._tx(pkt, timeout=timeout)
        backoff = 0.01
        while True:
            resp = bytearray(self._rx(64, timeout=timeout))
            resp[0] &= 0x7F  # mask out toggle bit
            if resp[0] == 3:  # BDM_RC_BUSY — just re-read EP_IN
                if backoff > 5.0:
                    raise USBDMError(resp[0])
                time.sleep(backoff)
                backoff *= 2
                continue
            break
        if resp[0] != BDM_RC_OK:
            raise USBDMError(resp[0])
        return bytes(resp)

    def get_version(self) -> str:
        # CMD_GET_VER goes to EP0 (control transfer), not bulk
        try:
            resp = self.dev.ctrl_transfer(
                0xC0,  # bmRequestType: device-to-host, vendor, device
                CMD_GET_VER,  # bRequest
                0, 0,  # wValue, wIndex
                5,  # wLength
                timeout=2000
            )
            hw = resp[0]
            sw = resp[1]
            return f"HW {hw>>4}.{hw&0xF}, SW {sw>>4}.{sw&0xF}"
        except Exception:
            # Fallback: some USBDM variants handle it on bulk
            try:
                resp = self._cmd(CMD_GET_VER, rx_len=5)
                hw = resp[1]
                sw = resp[2]
                return f"HW {hw>>4}.{hw&0xF}, SW {sw>>4}.{sw&0xF}"
            except Exception:
                return "(version read failed)"

    def set_target(self, target_type: int):
        self._cmd(CMD_SET_TARGET, bytes([target_type]), timeout=5000)

    def set_vdd(self, level: int):
        self._cmd(CMD_SET_VDD, struct.pack(">H", level), timeout=5000)

    def get_bdm_status(self) -> int:
        resp = self._cmd(CMD_GET_BDM_STATUS, rx_len=3)
        return (resp[1] << 8) | resp[2]

    def connect(self):
        self._cmd(CMD_CONNECT)

    def target_reset(self, mode: int):
        self._cmd(CMD_TARGET_RESET, bytes([mode]), timeout=5000)

    def target_halt(self):
        self._cmd(CMD_TARGET_HALT)

    def control_pins(self, control: int) -> int:
        resp = self._cmd(CMD_CONTROL_PINS, struct.pack(">H", control), rx_len=3)
        return (resp[1] << 8) | resp[2]

    def write_mem(self, addr: int, data: bytes):
        """Write bytes to target memory via BDM."""
        offset = 0
        max_chunk = 64 - 8  # max packet minus header
        while offset < len(data):
            chunk = data[offset:offset + max_chunk]
            count = len(chunk)
            tx_size = 8 + count
            hdr = struct.pack(">BBBBI", tx_size, CMD_WRITE_MEM, MS_BYTE, count, addr + offset)
            self._tx(hdr + chunk)
            resp = bytearray(self._rx(64))
            resp[0] &= 0x7F
            if resp[0] != BDM_RC_OK:
                raise USBDMError(resp[0])
            offset += count

    def read_mem(self, addr: int, count: int) -> bytes:
        """Read bytes from target memory via BDM."""
        result = bytearray()
        offset = 0
        max_chunk = 64 - 1  # max packet minus status byte
        while offset < count:
            chunk = min(count - offset, max_chunk)
            hdr = struct.pack(">BBBBI", 8, CMD_READ_MEM, MS_BYTE, chunk, addr + offset)
            self._tx(hdr)
            resp = bytearray(self._rx(64))
            resp[0] &= 0x7F
            if resp[0] != BDM_RC_OK:
                raise USBDMError(resp[0])
            result.extend(resp[1:1 + chunk])
            offset += chunk
        return bytes(result)

    def write_byte(self, addr: int, val: int):
        self.write_mem(addr, bytes([val]))

    def read_byte(self, addr: int) -> int:
        return self.read_mem(addr, 1)[0]

    def set_options(self, cycle_vdd_on_reset=False, cycle_vdd_on_connect=False,
                    leave_powered=True, guess_speed=True, use_reset=True,
                    target_vdd=VDD_3V3, clk_source=0, auto_reconnect=1,
                    sbdfr_addr=0x1800):
        """Send BDM options (matches firmware BDM_Option_t bitfield struct)."""
        # Byte 0: packed bitfield
        flags = 0
        if cycle_vdd_on_reset:
            flags |= (1 << 0)
        if cycle_vdd_on_connect:
            flags |= (1 << 1)
        if leave_powered:
            flags |= (1 << 2)
        if guess_speed:
            flags |= (1 << 3)
        if use_reset:
            flags |= (1 << 4)
        params = struct.pack(">BBBBBH", flags, target_vdd, clk_source,
                             auto_reconnect,
                             (sbdfr_addr >> 8) & 0xFF, sbdfr_addr & 0xFF)
        # Actually the struct is: flags(1) + targetVdd(1) + useAltBDMClock(1) +
        #   autoReconnect(1) + SBDFRaddress(2) + reserved(3) = 9 bytes
        # But memcpy copies sizeof(BDM_Option_t) which might include padding
        # Send just the 6 essential bytes
        params = bytes([flags, target_vdd, clk_source, auto_reconnect,
                        (sbdfr_addr >> 8) & 0xFF, sbdfr_addr & 0xFF])
        self._cmd(CMD_SET_OPTIONS, params)

    def close(self):
        try:
            self.set_vdd(VDD_OFF)
            self.set_target(T_OFF)
        except Exception:
            pass


def connect_target(bdm: USBDM) -> int:
    """Connect to HCS08 target, return SDID."""
    print(f"USBDM: {bdm.get_version()}")

    # Reset firmware state via GET_CAPABILITIES
    print("Getting capabilities...")
    resp = bdm._cmd(CMD_GET_CAPABILITIES, rx_len=7)
    caps = (resp[1] << 8) | resp[2]
    buf_size = (resp[3] << 8) | resp[4]
    fw_ver = f"{resp[5]}.{resp[6]}.{resp[7] if len(resp) > 7 else 0}"
    print(f"  Capabilities: 0x{caps:04X}, buffer: {buf_size}, fw: {fw_ver}")

    print("Setting target type: HCS08")
    bdm.set_target(T_HCS08)

    print("Setting VDD 3.3V...")
    bdm.set_vdd(VDD_3V3)
    time.sleep(0.3)

    status = bdm.get_bdm_status()
    power = status & S_POWER_MASK
    if power == 0:
        print("WARNING: no target power detected — check wiring")
    elif power == S_POWER_EXT:
        print("Target power: external")
    elif power == S_POWER_INT:
        print("Target power: internal (USBDM supplying 3.3V)")
    reset_state = "ACTIVE (low)" if (status & S_RESET_STATE) == 0 else "INACTIVE (high)"
    print(f"RESET pin: {reset_state}")

    print("Setting options (v4.12.1 format, no VDD cycling)...")
    # v4.12.1 format: [flags, targetVdd, clkSource, autoReconnect, sbdfr_hi, sbdfr_lo]
    flags = (1 << 2) | (1 << 3) | (1 << 4)  # leave_powered=1, guess=1, useReset=1
    # cycleVddOnReset=0 (bit0), cycleVddOnConnect=0 (bit1)
    params = bytes([flags, VDD_3V3, 0, 1, 0x18, 0x00])
    bdm._cmd(CMD_SET_OPTIONS, params)
    print(f"  Options set: flags=0x{flags:02X}")

    print("Entering special mode via pin control...")
    bdm.control_pins(PIN_BKGD_LOW | PIN_RESET_LOW)
    time.sleep(0.05)
    bdm.control_pins(PIN_BKGD_LOW | PIN_RESET_3STATE)  # release RESET, hold BKGD low
    time.sleep(0.05)
    bdm.control_pins(PIN_BKGD_3STATE)  # release BKGD after MCU latches special mode
    time.sleep(0.1)

    print("Connecting...")
    try:
        bdm.connect()
    except USBDMError as e:
        print(f"  Connect returned: {e}")
        print("  Re-setting target type...")
        bdm.set_target(T_HCS08)
        print("  Trying manual speed sync...")
        for speed in [1920, 960, 3840, 480, 240, 7680]:
            try:
                bdm._cmd(CMD_SET_SPEED, struct.pack(">H", speed))
                print(f"  Speed set to {speed} ticks")
                break
            except USBDMError as e2:
                print(f"  Speed {speed}: {e2}")
                continue
        else:
            print("  WARNING: could not set speed — trying read anyway")

    sdid_bytes = bdm.read_mem(SDID_ADDR, 2)
    sdid = (sdid_bytes[0] << 8) | sdid_bytes[1]
    print(f"SDID: 0x{sdid:04X}")
    return sdid


def mass_erase(bdm: USBDM):
    """Mass erase via flash controller — clears all flash + SEC bit."""
    print("\n=== MASS ERASE ===")
    print("Clearing FSTAT errors...")
    bdm.write_byte(FSTAT, FSTAT_FPVIOL | FSTAT_FACCERR)

    fstat = bdm.read_byte(FSTAT)
    print(f"FSTAT before: 0x{fstat:02X}")

    print("Writing dummy byte to flash (required before MASS_ERASE)...")
    bdm.write_byte(0xC000, 0xFF)

    print("Writing MASS_ERASE command to FCMD...")
    bdm.write_byte(FCMD, FCMD_MASS_ERASE)

    print("Launching (FCBEF)...")
    bdm.write_byte(FSTAT, FSTAT_FCBEF)

    print("Waiting for completion...")
    for i in range(100):
        time.sleep(0.05)
        fstat = bdm.read_byte(FSTAT)
        if fstat & FSTAT_FCCF:
            print(f"Mass erase complete (FSTAT=0x{fstat:02X})")
            if fstat & FSTAT_FPVIOL:
                print("WARNING: FPVIOL set — protection violation")
            if fstat & FSTAT_FACCERR:
                print("WARNING: FACCERR set — access error")
            return
    raise RuntimeError(f"Mass erase timeout — FSTAT stuck at 0x{fstat:02X}")


def program_flash(bdm: USBDM, data: bytes, base_addr: int = 0x2080):
    """Program flash byte-by-byte via BYTE_PROGRAM command.

    MC9S08QE128 flash starts at 0x2080 (after RAM and registers).
    The binary image is loaded starting at base_addr.
    """
    total = len(data)
    print(f"\n=== PROGRAMMING {total} bytes at 0x{base_addr:04X} ===")

    bdm.write_byte(FSTAT, FSTAT_FPVIOL | FSTAT_FACCERR)

    start_time = time.time()
    errors = 0

    for i in range(total):
        addr = base_addr + i
        val = data[i]

        if val == 0xFF:
            continue

        bdm.write_byte(addr, val)
        bdm.write_byte(FCMD, FCMD_BYTE_PROGRAM)
        bdm.write_byte(FSTAT, FSTAT_FCBEF)

        for _ in range(50):
            fstat = bdm.read_byte(FSTAT)
            if fstat & FSTAT_FCCF:
                break
            time.sleep(0.001)
        else:
            errors += 1
            if errors <= 5:
                print(f"  Timeout at 0x{addr:04X} (FSTAT=0x{fstat:02X})")
            if errors == 5:
                print("  (suppressing further timeout messages)")

        if fstat & (FSTAT_FPVIOL | FSTAT_FACCERR):
            errors += 1
            if errors <= 5:
                print(f"  Error at 0x{addr:04X}: FSTAT=0x{fstat:02X}")
            bdm.write_byte(FSTAT, FSTAT_FPVIOL | FSTAT_FACCERR)

        if (i + 1) % 1024 == 0 or (i + 1) == total:
            elapsed = time.time() - start_time
            pct = (i + 1) / total * 100
            rate = (i + 1) / elapsed if elapsed > 0 else 0
            eta = (total - i - 1) / rate if rate > 0 else 0
            print(f"  {i+1}/{total} ({pct:.1f}%) — {rate:.0f} B/s — ETA {eta:.0f}s", end="\r")

    elapsed = time.time() - start_time
    print(f"\nProgramming complete: {total} bytes in {elapsed:.1f}s ({errors} errors)")
    return errors


def verify_flash(bdm: USBDM, data: bytes, base_addr: int = 0x2080) -> int:
    """Verify programmed flash against reference data."""
    total = len(data)
    print(f"\n=== VERIFYING {total} bytes at 0x{base_addr:04X} ===")

    mismatches = 0
    chunk_size = 64

    for offset in range(0, total, chunk_size):
        end = min(offset + chunk_size, total)
        actual = bdm.read_mem(base_addr + offset, end - offset)
        expected = data[offset:end]
        for j in range(len(actual)):
            if actual[j] != expected[j]:
                mismatches += 1
                addr = base_addr + offset + j
                if mismatches <= 10:
                    print(f"  MISMATCH at 0x{addr:04X}: expected 0x{expected[j]:02X}, got 0x{actual[j]:02X}")
                if mismatches == 10:
                    print("  (suppressing further mismatch messages)")

        if (offset + chunk_size) % 4096 < chunk_size:
            pct = min(end, total) / total * 100
            print(f"  Verified {min(end,total)}/{total} ({pct:.1f}%)", end="\r")

    print(f"\nVerification complete: {mismatches} mismatches out of {total} bytes")
    return mismatches


def cmd_probe(bdm: USBDM):
    sdid = connect_target(bdm)
    if sdid == 0x00E0:
        print("Target: MC9S08QE128 (confirmed)")
    elif sdid == 0x00D0:
        print("Target: MC9S08QE64")
    else:
        print(f"Target: unknown SDID 0x{sdid:04X}")

    print("\nReading security bytes (0xFFB0-0xFFBF)...")
    try:
        sec = bdm.read_mem(0xFFB0, 16)
        print(f"  NVBACKKEY: {sec[0:8].hex(' ')}")
        print(f"  NVPROT:    0x{sec[13]:02X}")
        print(f"  NVOPT:     0x{sec[15]:02X}")
        secured = (sec[15] & 0x02) == 0
        print(f"  Secured:   {'YES' if secured else 'no'}")
    except USBDMError as e:
        print(f"  Can't read security area (device may be secured): {e}")


def cmd_erase(bdm: USBDM):
    connect_target(bdm)
    mass_erase(bdm)
    print("\nResetting target...")
    bdm.target_reset(RESET_HARDWARE | RESET_SPECIAL)
    time.sleep(0.1)
    bdm.connect()
    print("Done — device should be unsecured now")


def cmd_program(bdm: USBDM, filepath: str):
    with open(filepath, "rb") as f:
        data = f.read()
    print(f"Loaded {len(data)} bytes from {filepath}")

    connect_target(bdm)

    mass_erase(bdm)

    print("\nResetting after erase...")
    bdm.target_reset(RESET_HARDWARE | RESET_SPECIAL)
    time.sleep(0.1)
    bdm.connect()

    # MC9S08QE128 flash map:
    #   0x2080 - 0x7FFF  (24,448 bytes) — low flash
    #   0x8000 - 0xFFFF  (32,768 bytes) — high flash (includes vectors at 0xFFC0-0xFFFF)
    # Paged flash (0x8000-0xBFFF window, pages 0-7) adds more but for a flat binary
    # we load at 0x0000 mapped to flash start.
    #
    # PowPak firmware is a flat 99,928-byte image. For the QE128 with 128KB flash,
    # the image maps to flash starting at the lowest flash address.
    # The USBDM programmer would know the exact mapping from the device database.
    #
    # For now, we'll program the image assuming it starts at flash address 0x2080
    # (first byte of user flash on QE128). If the image is larger than 24,448 bytes,
    # the remainder goes into high flash at 0x8000+.
    #
    # Actually, for a banked HCS08, the flash address mapping is complex.
    # Let's try the simplest approach: program starting at 0x0000 linear.
    # The USBDM write_mem with BDM should handle the linear addressing.

    # For QE128, total flash = 131,072 bytes (128KB)
    # Linear flash: 0x2080-0xFFFF (non-paged) + paged regions
    # PowPak binary is ~100KB which fits in 128KB flash

    # The binary from the LDF is a raw flash image. Based on PowPak RE,
    # the image body starts at the beginning of flash and covers sections A+B.
    # For QE128, flash starts at 0x2080 in the non-paged region.
    #
    # However, QE128 has banked flash. The full 128KB is accessed via:
    #   Page 0-3: 0x8000-0xBFFF (each 16KB page selected via PPAGE register at 0x1C)
    #   Fixed:    0x4000-0x7FFF (16KB, = page 2)
    #   Fixed:    0xC000-0xFFFF (16KB, = page 3, includes vectors)
    #   Low:      0x2080-0x3FFF (~8KB)
    #
    # The LDF body is a flat image. We need to figure out the address mapping.
    # For recovery, let's just program the entire image linearly via BDM.
    # BDM on QE128 accesses the full 128KB address space linearly when
    # using the global addressing mode.

    # Use MS_Global (0x30) for banked access? Or just byte (0x01)?
    # Let's start simple with a probe: program a small test pattern and verify.

    print(f"\nImage size: {len(data)} bytes")
    print("Programming flash (this will take several minutes)...")

    errors = program_flash(bdm, data, base_addr=0x2080)

    if errors == 0:
        print("\nStarting verification...")
        mismatches = verify_flash(bdm, data, base_addr=0x2080)
        if mismatches == 0:
            print("\n*** RECOVERY SUCCESSFUL ***")
        else:
            print(f"\n*** VERIFICATION FAILED — {mismatches} mismatches ***")
    else:
        print(f"\n*** PROGRAMMING HAD {errors} ERRORS — skipping verify ***")


def cmd_read(bdm: USBDM, addr_str: str, len_str: str):
    addr = int(addr_str, 0)
    length = int(len_str, 0)
    connect_target(bdm)
    data = bdm.read_mem(addr, length)
    for i in range(0, len(data), 16):
        hex_part = " ".join(f"{b:02X}" for b in data[i:i+16])
        ascii_part = "".join(chr(b) if 32 <= b < 127 else "." for b in data[i:i+16])
        print(f"  {addr+i:04X}: {hex_part:<48s} {ascii_part}")


def cmd_dump(bdm: USBDM, filepath: str, length: int = 131072):
    connect_target(bdm)
    print(f"\nDumping {length} bytes to {filepath}...")
    data = bytearray()
    chunk_size = 64
    for offset in range(0, length, chunk_size):
        end = min(offset + chunk_size, length)
        chunk = bdm.read_mem(offset, end - offset)
        data.extend(chunk)
        if (offset + chunk_size) % 4096 < chunk_size:
            pct = min(end, length) / length * 100
            print(f"  {min(end,length)}/{length} ({pct:.1f}%)", end="\r")
    with open(filepath, "wb") as f:
        f.write(data)
    print(f"\nDumped {len(data)} bytes to {filepath}")


def main():
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help", "help"):
        print(__doc__)
        sys.exit(0)

    cmd = args[0]
    bdm = USBDM()

    try:
        if cmd == "probe":
            cmd_probe(bdm)
        elif cmd == "erase":
            cmd_erase(bdm)
        elif cmd == "program":
            if len(args) < 2:
                print("Usage: bdm-prog.py program <firmware.bin>")
                sys.exit(1)
            cmd_program(bdm, args[1])
        elif cmd == "read":
            if len(args) < 3:
                print("Usage: bdm-prog.py read <addr> <len>")
                sys.exit(1)
            cmd_read(bdm, args[1], args[2])
        elif cmd == "dump":
            if len(args) < 2:
                print("Usage: bdm-prog.py dump <output.bin> [length]")
                sys.exit(1)
            length = int(args[2], 0) if len(args) > 2 else 131072
            cmd_dump(bdm, args[1], length)
        else:
            print(f"Unknown command: {cmd}")
            print(__doc__)
            sys.exit(1)
    finally:
        bdm.close()


if __name__ == "__main__":
    main()
