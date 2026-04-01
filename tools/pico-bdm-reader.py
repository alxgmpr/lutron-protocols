#!/usr/bin/env python3
"""
HCS08 BDM Flash Reader via Raspberry Pi Pico (MicroPython)

Reads flash memory from MC9S08QE128 (and similar HCS08 MCUs) via the BDM
(Background Debug Module) single-wire debug interface. Target: Lutron PowPak
modules (RMJS-16R, RMJ-16R, LMJ-16R, RMJS-5RCCO, etc.)

The Pico runs MicroPython and bit-bangs the BDM protocol using open-drain
GPIO with timing calibrated via the BDM SYNC handshake. The host Python
script uploads the MicroPython code, collects hex data, and writes output files.

Wiring (PowPak test pads → Pico):
  TP1 BKGD  (MCU pin 1)  → Pico GP20 (pin 26) + 10kΩ pull-up to 3V3
  TP3 RESET (MCU pin 2)  → Pico GP18 (pin 24)
  TP2 GND                → Pico GND  (pin 18)
  TP4 VDD                → don't connect if mains-powered

Usage:
  python3 tools/pico-bdm-reader.py [port] [--model NAME] [--output FILE]

Options:
  port          Serial port (default: /dev/cu.usbmodem*)
  --model NAME  PowPak model for output filename (e.g., RMJS-16R-DV-B)
  --output FILE Override output filename (default: dumps/<model>.bin)
  --skip-dump   Just check BDM status, don't dump flash
"""

import sys
import os
import time
import struct
import glob as globmod

# Attempt pyserial import, guide user if missing
try:
    import serial
except ImportError:
    print("pyserial required: python3 -m venv /tmp/bdm-venv && "
          "/tmp/bdm-venv/bin/pip install pyserial")
    print("Then: /tmp/bdm-venv/bin/python3 tools/pico-bdm-reader.py")
    sys.exit(1)

# --- CLI args ---
args = sys.argv[1:]
def get_arg(name):
    if name in args:
        i = args.index(name)
        return args[i + 1] if i + 1 < len(args) else None
    return None

model = get_arg("--model") or "powpak"
output_file = get_arg("--output") or f"dumps/{model}.bin"
skip_dump = "--skip-dump" in args

# Find port: explicit arg or auto-detect
port_arg = None
for a in args:
    if a.startswith("/dev/") or a.startswith("COM"):
        port_arg = a
        break
if not port_arg:
    candidates = globmod.glob("/dev/cu.usbmodem*")
    port_arg = candidates[0] if candidates else "/dev/cu.usbmodem112201"

# ============================================================
# MicroPython script uploaded to Pico
# ============================================================
PICO_SCRIPT = r'''
import machine
import time
import ubinascii

# --- Pin assignments ---
BKGD_PIN = 20
RESET_PIN = 18

# RP2040 SIO registers for fast GPIO
GPIO_IN     = const(0xD0000004)
GPIO_OUT_CLR = const(0xD0000018)
GPIO_OE_SET  = const(0xD0000024)
GPIO_OE_CLR  = const(0xD0000028)

BKGD_MASK = const(1 << 20)

# Init BKGD as input with pull-up (open-drain: toggle OE to drive/release)
bkgd_pin = machine.Pin(BKGD_PIN, machine.Pin.IN, machine.Pin.PULL_UP)
reset_pin = machine.Pin(RESET_PIN, machine.Pin.OUT, value=1)

# Pre-set output value to 0 (when OE enabled, drives low)
machine.mem32[GPIO_OUT_CLR] = BKGD_MASK

# --- Timing parameters (calibrated by SYNC) ---
# Defaults for ~4 MHz bus clock
short_us = 2    # >= 4 target cycles (speed pulse)
long_us = 5     # >= 13 target cycles (data '0' hold)
sample_us = 3   # ~10 target cycles (RX sample point)
bit_us = 40     # ~128 target cycles (full bit period)

# --- Low-level GPIO ---
def bkgd_low():
    machine.mem32[GPIO_OE_SET] = BKGD_MASK

def bkgd_release():
    machine.mem32[GPIO_OE_CLR] = BKGD_MASK

def bkgd_read():
    return (machine.mem32[GPIO_IN] >> 20) & 1

# --- BDM bit-level I/O ---
def bdm_tx_bit(bit):
    bkgd_low()
    if bit:
        time.sleep_us(short_us)
    else:
        time.sleep_us(long_us)
    bkgd_release()
    time.sleep_us(bit_us - (short_us if bit else long_us))

def bdm_rx_bit():
    bkgd_low()
    time.sleep_us(short_us)
    bkgd_release()
    time.sleep_us(sample_us)
    val = bkgd_read()
    time.sleep_us(bit_us - short_us - sample_us)
    return val

def bdm_tx_byte(byte):
    for i in range(7, -1, -1):
        bdm_tx_bit((byte >> i) & 1)

def bdm_rx_byte():
    val = 0
    for i in range(8):
        val = (val << 1) | bdm_rx_bit()
    return val

def bdm_tx_word(word):
    bdm_tx_byte((word >> 8) & 0xFF)
    bdm_tx_byte(word & 0xFF)

def bdm_rx_word():
    return (bdm_rx_byte() << 8) | bdm_rx_byte()

# --- BDM protocol commands ---

def bdm_sync():
    """Send SYNC pulse, measure target response to calibrate timing."""
    global short_us, long_us, sample_us, bit_us

    # Long low pulse (>128 target cycles at any bus clock)
    bkgd_low()
    time.sleep_ms(2)
    bkgd_release()
    time.sleep_us(2)

    # Measure target's 128-cycle response (low pulse)
    sync_us = machine.time_pulse_us(bkgd_pin, 0, 100000)
    if sync_us < 0:
        print("ERR:SYNC no response")
        return False

    cycle_ns = (sync_us * 1000) // 128
    bus_khz = 1000000 // cycle_ns if cycle_ns > 0 else 0

    # Calibrate timing with conservative margins
    short_us  = max(1, (5 * cycle_ns + 999) // 1000)    # 5 cycles (need >= 4)
    long_us   = max(2, (15 * cycle_ns + 999) // 1000)   # 15 cycles (need >= 13)
    sample_us = max(1, (11 * cycle_ns + 999) // 1000)   # 11 cycles (target at 10)
    bit_us    = max(10, (150 * cycle_ns + 999) // 1000)  # 150 cycles (need >= 128)

    print("SYNC:{}us cycle={}ns bus={}kHz".format(sync_us, cycle_ns, bus_khz))
    print("TIMING:short={} long={} sample={} bit={}".format(
        short_us, long_us, sample_us, bit_us))
    return True

def bdm_background():
    """BACKGROUND (0x90): halt target CPU, enter active BDM."""
    bdm_tx_byte(0x90)
    time.sleep_us(bit_us * 2)

def bdm_read_status():
    """READ_STATUS (0xE4): read BDCSC register."""
    bdm_tx_byte(0xE4)
    return bdm_rx_byte()

def bdm_write_control(val):
    """WRITE_CONTROL (0xC4): write BDCSC register."""
    bdm_tx_byte(0xC4)
    bdm_tx_byte(val)

def bdm_read_byte(addr):
    """READ_BYTE (0xE0): read memory at 16-bit address."""
    bdm_tx_byte(0xE0)
    bdm_tx_word(addr)
    return bdm_rx_byte()

def bdm_write_byte(addr, val):
    """WRITE_BYTE (0xC0): write memory at 16-bit address."""
    bdm_tx_byte(0xC0)
    bdm_tx_word(addr)
    bdm_tx_byte(val)

def bdm_read_a():
    """READ_A (0x68): read accumulator."""
    bdm_tx_byte(0x68)
    return bdm_rx_byte()

def bdm_write_hx(val):
    """WRITE_HX (0x4C): write H:X index register pair."""
    bdm_tx_byte(0x4C)
    bdm_tx_word(val)

def bdm_read_hx():
    """READ_HX (0x6C): read H:X index register pair."""
    bdm_tx_byte(0x6C)
    return bdm_rx_word()

def bdm_read_next():
    """READ_NEXT (0x62): read [H:X] then increment H:X."""
    bdm_tx_byte(0x62)
    return bdm_rx_byte()

# --- High-level operations ---

def enter_bdm():
    """Force active background mode via BKGD+RESET sequence."""
    print("BDM:forcing entry via reset")

    bkgd_release()
    reset_pin.value(1)
    time.sleep_ms(50)

    # Assert RESET, then hold BKGD low during reset release
    reset_pin.value(0)      # RESET asserted
    time.sleep_ms(10)
    bkgd_low()              # BKGD low = request BDM mode
    time.sleep_ms(10)
    reset_pin.value(1)      # release RESET — MCU sees BKGD low, enters BDM
    time.sleep_ms(50)       # MCU startup time
    bkgd_release()
    time.sleep_ms(10)

def check_status():
    """Read and report BDM status."""
    status = bdm_read_status()
    unsec   = bool(status & 0x04)  # bit 2: 1=unsecured
    enbdm   = bool(status & 0x08)  # bit 3: BDM enabled
    active  = bool(status & 0x40)  # bit 6: active background
    print("STATUS:0x{:02x} unsec={} enbdm={} active={}".format(
        status, unsec, enbdm, active))
    return status

def read_block(addr, length):
    """Read sequential bytes using WRITE_HX + READ_NEXT for speed."""
    bdm_write_hx(addr)
    time.sleep_us(bit_us)
    buf = bytearray(length)
    for i in range(length):
        buf[i] = bdm_read_next()
    return buf

def dump_flash():
    """Dump all 128KB flash via PPAGE window (0x8000-0xBFFF), 8 pages."""
    PPAGE_REG = 0x001A
    CHUNK = 64  # bytes per line

    for page in range(8):
        # Select flash page
        bdm_write_byte(PPAGE_REG, page)
        time.sleep_us(100)

        # Verify PPAGE write
        verify = bdm_read_byte(PPAGE_REG)
        if verify != page:
            print("ERR:PPAGE write {} read {}".format(page, verify))
            return

        print("PAGE:{}".format(page))

        # Read 16KB through paging window
        for offset in range(0, 0x4000, CHUNK):
            addr = 0x8000 + offset
            chunk = read_block(addr, CHUNK)
            print("D:" + ubinascii.hexlify(chunk).decode())

        print("ENDPAGE:{}".format(page))

    print("DUMP:COMPLETE")

def read_mem(addr, length=16):
    """Read arbitrary memory range (for interactive use)."""
    data = read_block(addr, length)
    print("MEM:0x{:04x}:".format(addr) + ubinascii.hexlify(data).decode())
    return data

def read_security():
    """Read security/option bytes at 0xFFB0-0xFFBF (non-volatile register area)."""
    data = read_block(0xFFB0, 16)
    sec_byte = data[0x0D]  # NVOPT at 0xFFBD
    sec_bits = sec_byte & 0x03
    print("SECURITY:nvopt=0x{:02x} sec={} ({})".format(
        sec_byte, sec_bits,
        "unsecured" if sec_bits == 0x02 else "SECURED"))
    print("NVREGS:" + ubinascii.hexlify(data).decode())
    return data

# === Main init sequence ===
print("PICO:BDM reader starting")
enter_bdm()

if not bdm_sync():
    print("FAIL:sync")
else:
    bdm_background()
    time.sleep_ms(10)
    status = check_status()

    if status & 0x04:  # UNSEC bit
        print("READY:unsecured")
    elif status == 0xFF:
        print("FAIL:no response (check wiring)")
    else:
        print("SECURED:flash reads blocked (try CDN firmware)")
'''


# ============================================================
# Host-side Python
# ============================================================

def upload_and_run(ser, script):
    """Upload MicroPython script to Pico REPL and execute."""
    ser.write(b'\x03\x03')  # Ctrl+C to interrupt
    time.sleep(0.5)
    ser.reset_input_buffer()

    ser.write(b'\x01')  # Ctrl+A → raw REPL
    time.sleep(0.3)
    ser.read(ser.in_waiting or 256)

    for line in script.split('\n'):
        ser.write((line + '\n').encode())
        time.sleep(0.01)

    ser.write(b'\x04')  # Ctrl+D → execute
    time.sleep(0.5)


def read_until(ser, marker, timeout=30):
    """Read serial until marker string or timeout."""
    buf = b""
    start = time.time()
    while time.time() - start < timeout:
        data = ser.read(ser.in_waiting or 1)
        if data:
            buf += data
            if marker.encode() in buf:
                return buf.decode('utf-8', errors='replace')
    return buf.decode('utf-8', errors='replace')


def collect_dump(ser, timeout=300):
    """Collect flash dump data from Pico, organized by page."""
    pages = {}
    current_page = None
    current_data = b""
    buf = b""

    deadline = time.time() + timeout
    while time.time() < deadline:
        data = ser.read(ser.in_waiting or 1)
        if not data:
            time.sleep(0.01)
            continue
        buf += data

        while b'\n' in buf:
            line, buf = buf.split(b'\n', 1)
            line = line.decode('utf-8', errors='replace').strip()

            if line.startswith("PAGE:"):
                tag = line[5:]
                current_page = tag
                current_data = b""
                sys.stdout.write(f"\r  Reading page {tag}...")
                sys.stdout.flush()

            elif line.startswith("D:"):
                try:
                    current_data += bytes.fromhex(line[2:])
                except ValueError:
                    pass

            elif line.startswith("ENDPAGE:"):
                tag = line[8:]
                pages[tag] = current_data
                kb = len(current_data) / 1024
                sys.stdout.write(f"\r  Page {tag}: {kb:.1f} KB    \n")
                sys.stdout.flush()

            elif line.startswith("DUMP:COMPLETE"):
                print("  Dump complete!")
                return pages

            elif line.startswith("ERR:"):
                print(f"\n  Error: {line}")

            elif line:
                print(f"  {line}")

    print("\n  Timeout waiting for dump!")
    return pages


def assemble_binary(pages):
    """Assemble 128KB flat binary from page data (page 0 at offset 0)."""
    binary = bytearray(128 * 1024)  # 128KB filled with 0xFF
    for i in range(len(binary)):
        binary[i] = 0xFF

    for page_num in range(8):
        key = str(page_num)
        if key in pages:
            data = pages[key]
            offset = page_num * 0x4000  # 16KB per page
            binary[offset:offset + len(data)] = data

    return bytes(binary)


def generate_s19(binary, filename):
    """Generate S-record file from flat binary for Ghidra import.

    Uses S2 records (24-bit address) with linear addressing:
    page 0 at 0x000000, page 1 at 0x004000, ..., page 7 at 0x01C000.
    """
    BYTES_PER_RECORD = 32
    records = []

    # S0 header
    header = b"HDR"
    s0_data = bytes([0, 0]) + header  # 16-bit addr 0x0000 + header text
    s0_count = len(s0_data) + 1  # +1 for checksum
    s0_sum = s0_count
    for b in s0_data:
        s0_sum += b
    s0_checksum = (~s0_sum) & 0xFF
    records.append("S0{:02X}{}{}".format(
        s0_count,
        s0_data.hex().upper(),
        f"{s0_checksum:02X}"))

    # S2 data records (24-bit address)
    addr = 0
    while addr < len(binary):
        # Skip runs of 0xFF (unprogrammed flash)
        chunk = binary[addr:addr + BYTES_PER_RECORD]
        if chunk == b'\xff' * len(chunk):
            addr += BYTES_PER_RECORD
            continue

        count = 3 + len(chunk) + 1  # 3 addr bytes + data + checksum
        rec_sum = count
        rec_sum += (addr >> 16) & 0xFF
        rec_sum += (addr >> 8) & 0xFF
        rec_sum += addr & 0xFF
        for b in chunk:
            rec_sum += b
        checksum = (~rec_sum) & 0xFF

        records.append("S2{:02X}{:06X}{}{}".format(
            count,
            addr,
            chunk.hex().upper(),
            f"{checksum:02X}"))

        addr += BYTES_PER_RECORD

    # S8 end record (24-bit start address, use reset vector location)
    s8_addr = 0x01FFFE  # top of flash (reset vector for page 7)
    s8_count = 4  # 3 addr + 1 checksum
    s8_sum = s8_count + ((s8_addr >> 16) & 0xFF) + ((s8_addr >> 8) & 0xFF) + (s8_addr & 0xFF)
    s8_checksum = (~s8_sum) & 0xFF
    records.append("S8{:02X}{:06X}{:02X}".format(s8_count, s8_addr, s8_checksum))

    with open(filename, 'w') as f:
        f.write('\n'.join(records) + '\n')

    return len(records)


def main():
    print(f"=== HCS08 BDM Flash Reader ===")
    print(f"Port:  {port_arg}")
    print(f"Model: {model}")
    print()

    ser = serial.Serial(port_arg, 115200, timeout=1)

    print("Uploading BDM reader to Pico...")
    upload_and_run(ser, PICO_SCRIPT)

    print("Waiting for BDM init...")
    output = read_until(ser, "READY", timeout=20)

    # Print all init output
    for line in output.strip().split('\n'):
        line = line.strip()
        if line and not line.startswith('\x04') and not line.startswith('OK'):
            print(f"  {line}")

    if "FAIL:" in output:
        print("\nBDM init failed. Check:")
        print("  - BKGD pad → GP15 (pin 20) with 4.7k pull-up to 3V3")
        print("  - RESET pad → GP14 (pin 19)")
        print("  - GND pad → Pico GND (pin 18)")
        print("  - MCU powered (VDD at 3.3V)")
        ser.close()
        return

    if "SECURED" in output:
        print("\nMCU is SECURED — BDM flash reads are blocked.")
        print("Options:")
        print("  1. Check Lutron firmware CDN for S19/LDF files (no BDM needed)")
        print("  2. Mass erase via BDM (erases all flash — loses firmware!)")
        print("  3. Try a different unit (security fusing varies)")
        ser.close()
        return

    if "READY" not in output:
        print("\nNo READY response. Possible issues:")
        print("  - Wrong pad identification (re-check with multimeter)")
        print("  - MCU not powered")
        print("  - BKGD pull-up resistor missing")
        ser.close()
        return

    if skip_dump:
        print("\nBDM active — skipping dump (--skip-dump)")
        print("Interactive commands available on Pico REPL:")
        print("  read_mem(0xFFB0, 16)   # read security/option bytes")
        print("  read_block(0x8000, 64) # read flash block")
        print("  dump_flash()           # full 128KB dump")
        ser.close()
        return

    # Read security/option bytes first
    print("\nReading security/option bytes...")
    ser.write(b"read_security()\r\n")
    sec_output = read_until(ser, "NVREGS:", timeout=10)
    for line in sec_output.strip().split('\n'):
        line = line.strip()
        if line.startswith("SECURITY:") or line.startswith("NVREGS:"):
            print(f"  {line}")

    # Trigger full flash dump
    print(f"\nDumping 128KB flash (8 pages x 16KB)...")
    ser.write(b"dump_flash()\r\n")

    pages = collect_dump(ser, timeout=300)

    if not pages:
        print("No data collected!")
        ser.close()
        return

    # Assemble flat binary
    binary = assemble_binary(pages)

    # Create output directory
    out_dir = os.path.dirname(output_file)
    if out_dir and not os.path.exists(out_dir):
        os.makedirs(out_dir)

    # Write binary
    with open(output_file, 'wb') as f:
        f.write(binary)
    print(f"\nBinary: {output_file} ({len(binary)} bytes)")

    # Write S19
    s19_file = output_file.rsplit('.', 1)[0] + '.s19'
    num_records = generate_s19(binary, s19_file)
    print(f"S19:    {s19_file} ({num_records} records)")

    # Summary
    print(f"\nDump summary:")
    total_programmed = sum(1 for b in binary if b != 0xFF)
    print(f"  Flash used: {total_programmed:,} / {len(binary):,} bytes "
          f"({100 * total_programmed / len(binary):.1f}%)")

    # Check for interesting patterns
    # Reset vector (last 2 bytes of page 7)
    reset_vec = (binary[0x1FFFE] << 8) | binary[0x1FFFF]
    if reset_vec != 0xFFFF:
        print(f"  Reset vector: 0x{reset_vec:04X}")

    # Security byte (page 7, offset 0x3FBD = NVOPT at 0xFFBD)
    nvopt = binary[0x1FFBD]
    sec = nvopt & 0x03
    print(f"  NVOPT (security): 0x{nvopt:02X} → {'unsecured' if sec == 0x02 else 'SECURED'}")

    ser.close()
    print("\nDone! Load the .s19 in Ghidra with MC9S08QE128 processor.")


if __name__ == "__main__":
    main()
