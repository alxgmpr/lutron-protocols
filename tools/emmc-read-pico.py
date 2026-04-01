#!/usr/bin/env python3
"""
eMMC Reader via Raspberry Pi Pico (MicroPython)

Uploads a MicroPython script to the Pico that reads the Phoenix processor's
eMMC via SPI mode through the test pads, then dumps specified blocks back
over USB serial.

Wiring (board powered with SYSBOOT2 grounded to keep AM335x in ROM wait):
  TP603 (CLK)  → Pico GP18
  TP604 (CMD)  → Pico GP19
  TP605 (DAT0) → Pico GP16
  TP608 (DAT3) → Pico GP21 (directly, active low for CS, sometimes pulled high via 10k to 3.3v at startup)
  TP602 (DGND) → Pico GND

Usage:
  python3 tools/emmc-read-pico.py [port]
"""

import sys, os, time, struct

sys.path.insert(0, "/tmp/xmodem-venv/lib/python3.14/site-packages")
import serial

PICO_PORT = sys.argv[1] if len(sys.argv) > 1 else "/dev/cu.usbmodem112201"

# MicroPython script to upload to the Pico
PICO_SCRIPT = r'''
import machine
import time
import sys
import ubinascii

# SPI pins matching the wiring
SCK_PIN = 18
MOSI_PIN = 19  # CMD
MISO_PIN = 16  # DAT0
CS_PIN = 21    # DAT3

cs = machine.Pin(CS_PIN, machine.Pin.OUT, value=1)

# Start with slow SPI for init (400kHz), speed up after
spi = machine.SPI(0, baudrate=400000, polarity=0, phase=0,
                  sck=machine.Pin(SCK_PIN),
                  mosi=machine.Pin(MOSI_PIN),
                  miso=machine.Pin(MISO_PIN))

def cs_low():
    cs.value(0)

def cs_high():
    cs.value(1)

def spi_write_read(data):
    buf = bytearray(len(data))
    spi.write_readinto(bytearray(data), buf)
    return buf

def send_cmd(cmd, arg=0, crc=0x01):
    """Send SD/MMC command and get R1 response"""
    cs_low()
    # Command format: 0x40 | cmd, 4-byte arg, CRC
    packet = bytes([0x40 | cmd, (arg >> 24) & 0xFF, (arg >> 16) & 0xFF,
                    (arg >> 8) & 0xFF, arg & 0xFF, crc])
    spi.write(packet)
    # Wait for response (R1 = single byte, bit 7 = 0)
    for i in range(10):
        r = spi_write_read(b'\xff')[0]
        if r != 0xFF:
            return r
    cs_high()
    return 0xFF

def send_cmd_r7(cmd, arg=0, crc=0x01):
    """Send command expecting R7 response (5 bytes)"""
    cs_low()
    packet = bytes([0x40 | cmd, (arg >> 24) & 0xFF, (arg >> 16) & 0xFF,
                    (arg >> 8) & 0xFF, arg & 0xFF, crc])
    spi.write(packet)
    for i in range(10):
        r = spi_write_read(b'\xff')[0]
        if r != 0xFF:
            rest = spi_write_read(b'\xff\xff\xff\xff')
            cs_high()
            return r, rest
    cs_high()
    return 0xFF, b'\xff\xff\xff\xff'

def init_card():
    """Initialize SD/MMC card in SPI mode"""
    # Send 80+ clock pulses with CS high (card init)
    cs_high()
    spi.write(b'\xff' * 10)

    # CMD0 - GO_IDLE_STATE (reset, enter SPI mode)
    for attempt in range(5):
        r = send_cmd(0, 0, 0x95)  # CRC must be correct for CMD0
        cs_high()
        spi.write(b'\xff')
        if r == 0x01:
            break
    else:
        print("ERR:CMD0 failed, r=" + hex(r))
        return False
    print("OK:CMD0 idle")

    # CMD8 - SEND_IF_COND (check voltage, required for SDHC/eMMC)
    r, extra = send_cmd_r7(8, 0x1AA, 0x87)
    cs_high()
    spi.write(b'\xff')
    if r == 0x01:
        print("OK:CMD8 r=" + hex(r) + " echo=" + ubinascii.hexlify(extra).decode())
    else:
        print("WARN:CMD8 r=" + hex(r) + " (may be MMCv3)")

    # CMD1 or ACMD41 - init loop
    # For eMMC, CMD1 (SEND_OP_COND) is the standard init
    # For SD, it's ACMD41 (CMD55+CMD41)
    # Try CMD1 first (eMMC), fall back to ACMD41 (SD)

    initialized = False
    for i in range(200):
        # Try CMD1 (eMMC)
        r = send_cmd(1, 0x40000000)  # HCS bit set
        cs_high()
        spi.write(b'\xff')
        if r == 0x00:
            print("OK:CMD1 init complete (eMMC)")
            initialized = True
            break
        time.sleep_ms(10)

    if not initialized:
        # Try ACMD41 (SD card)
        for i in range(200):
            send_cmd(55, 0)  # CMD55 (APP_CMD prefix)
            cs_high()
            spi.write(b'\xff')
            r = send_cmd(41, 0x40000000)  # ACMD41
            cs_high()
            spi.write(b'\xff')
            if r == 0x00:
                print("OK:ACMD41 init complete (SD)")
                initialized = True
                break
            time.sleep_ms(10)

    if not initialized:
        print("ERR:init failed after 200 attempts")
        return False

    # CMD16 - SET_BLOCKLEN to 512
    r = send_cmd(16, 512)
    cs_high()
    spi.write(b'\xff')
    if r != 0x00:
        print("WARN:CMD16 r=" + hex(r))
    else:
        print("OK:CMD16 blocklen=512")

    # Speed up SPI now that card is initialized
    spi.deinit()
    spi.__init__(0, baudrate=4000000, polarity=0, phase=0,
                 sck=machine.Pin(SCK_PIN),
                 mosi=machine.Pin(MOSI_PIN),
                 miso=machine.Pin(MISO_PIN))
    print("OK:SPI speed 4MHz")

    return True

def read_block(block_num):
    """Read a 512-byte block. For non-SDHC, address is byte-based."""
    # eMMC in SPI mode uses byte addressing unless switched to block addressing
    # Try byte address first (block_num * 512)
    addr = block_num * 512

    r = send_cmd(17, addr)  # CMD17 - READ_SINGLE_BLOCK
    if r != 0x00:
        cs_high()
        return None

    # Wait for data token (0xFE)
    for i in range(2000):
        token = spi_write_read(b'\xff')[0]
        if token == 0xFE:
            break
        if token != 0xFF:
            cs_high()
            return None
    else:
        cs_high()
        return None

    # Read 512 bytes + 2 CRC bytes
    data = spi_write_read(bytes(514))
    cs_high()
    spi.write(b'\xff')
    return bytes(data[:512])

def dump_block_hex(block_num):
    """Read and print a block as hex over serial"""
    data = read_block(block_num)
    if data is None:
        print("ERR:read_block " + str(block_num))
        return
    # Print as hex lines (32 bytes per line)
    print("BLK:" + str(block_num))
    for i in range(0, 512, 32):
        print("D:" + ubinascii.hexlify(data[i:i+32]).decode())
    print("END:" + str(block_num))

def dump_blocks(start, count):
    """Dump multiple blocks"""
    for i in range(count):
        dump_block_hex(start + i)

# Main
print("PICO:eMMC reader starting")
if init_card():
    print("READY")
else:
    print("FAIL:card init")
'''


def upload_and_run(ser, script):
    """Upload script to Pico REPL and execute it"""
    # Ctrl+C to interrupt anything running
    ser.write(b'\x03\x03')
    time.sleep(0.5)
    ser.reset_input_buffer()

    # Enter raw REPL mode (Ctrl+A)
    ser.write(b'\x01')
    time.sleep(0.3)
    resp = ser.read(ser.in_waiting or 256)

    # Send the script
    # Raw REPL accepts code terminated by Ctrl+D
    for line in script.split('\n'):
        ser.write((line + '\n').encode())
        time.sleep(0.01)  # Small delay between lines

    # Ctrl+D to execute
    ser.write(b'\x04')
    time.sleep(0.5)


def read_until(ser, marker, timeout=30):
    """Read serial until marker string found"""
    buf = b""
    start = time.time()
    while time.time() - start < timeout:
        data = ser.read(ser.in_waiting or 1)
        if data:
            buf += data
            if marker.encode() in buf:
                return buf.decode('utf-8', errors='replace')
    return buf.decode('utf-8', errors='replace')


def read_blocks_from_pico(ser, start_block, count):
    """Command the Pico to read blocks and collect the hex data"""
    cmd = f"dump_blocks({start_block}, {count})\r\n"
    ser.write(cmd.encode())

    blocks = {}
    current_block = None
    current_data = b""

    timeout = time.time() + (count * 2 + 10)  # ~2 sec per block
    buf = b""

    while time.time() < timeout:
        data = ser.read(ser.in_waiting or 1)
        if not data:
            time.sleep(0.01)
            continue
        buf += data

        while b'\n' in buf:
            line, buf = buf.split(b'\n', 1)
            line = line.decode('utf-8', errors='replace').strip()

            if line.startswith("BLK:"):
                current_block = int(line[4:])
                current_data = b""
            elif line.startswith("D:"):
                current_data += bytes.fromhex(line[2:])
            elif line.startswith("END:"):
                blk = int(line[4:])
                if len(current_data) == 512:
                    blocks[blk] = current_data
                    sys.stdout.write(f"\r  Block {blk} OK ({len(blocks)}/{count})")
                    sys.stdout.flush()
                else:
                    print(f"\n  Block {blk} bad size: {len(current_data)}")
                if len(blocks) >= count:
                    print()
                    return blocks
            elif line.startswith("ERR:"):
                print(f"\n  Error: {line}")

    print()
    return blocks


def parse_mbr(block0):
    """Parse MBR/GPT partition table from block 0"""
    # Check for MBR signature
    if block0[510:512] != b'\x55\xAA':
        print("No MBR signature found")
        # Might be GPT — check block 1
        return None

    print("MBR partition table:")
    partitions = []
    for i in range(4):
        off = 446 + i * 16
        entry = block0[off:off+16]
        status, chs_start, ptype = entry[0], entry[1:4], entry[4]
        lba_start = struct.unpack('<I', entry[8:12])[0]
        lba_size = struct.unpack('<I', entry[12:16])[0]
        if ptype != 0:
            print(f"  P{i+1}: type=0x{ptype:02x} start={lba_start} size={lba_size} ({lba_size*512//1024//1024}MB)")
            partitions.append((i+1, ptype, lba_start, lba_size))

    # Check if this is a protective MBR (GPT)
    if partitions and partitions[0][1] == 0xEE:
        print("  → Protective MBR (GPT partitioned)")
        return "GPT"

    return partitions


def main():
    print(f"Opening Pico on {PICO_PORT}")
    ser = serial.Serial(PICO_PORT, 115200, timeout=1)

    print("Uploading eMMC reader to Pico...")
    upload_and_run(ser, PICO_SCRIPT)

    # Wait for init
    print("Waiting for card init...")
    output = read_until(ser, "READY", timeout=15)
    print(output)

    if "FAIL" in output:
        print("\neMMC init failed. Check wiring and power.")
        print("Make sure SYSBOOT2 is grounded and board is powered.")
        ser.close()
        return

    if "READY" not in output:
        print("\nNo READY response. Check wiring.")
        ser.close()
        return

    # Step 1: Read block 0 (MBR/GPT)
    print("\n=== Reading partition table (block 0) ===")
    blocks = read_blocks_from_pico(ser, 0, 2)

    if 0 not in blocks:
        print("Failed to read block 0")
        ser.close()
        return

    result = parse_mbr(blocks[0])

    if result == "GPT":
        # Read GPT header (block 1) and partition entries (blocks 2-33)
        print("\n=== Reading GPT header ===")
        gpt_blocks = read_blocks_from_pico(ser, 1, 33)
        if 1 in gpt_blocks:
            # Parse GPT header
            hdr = gpt_blocks[1]
            sig = hdr[0:8]
            if sig == b'EFI PART':
                num_entries = struct.unpack('<I', hdr[80:84])[0]
                entry_size = struct.unpack('<I', hdr[84:88])[0]
                entry_start_lba = struct.unpack('<Q', hdr[72:80])[0]
                print(f"  GPT: {num_entries} entries, size={entry_size}, start LBA={entry_start_lba}")

                # Parse partition entries
                print("\n  GPT Partitions:")
                for i in range(min(num_entries, 128)):
                    blk_idx = 2 + (i * entry_size) // 512
                    entry_off = (i * entry_size) % 512
                    if blk_idx in gpt_blocks:
                        entry = gpt_blocks[blk_idx][entry_off:entry_off+entry_size]
                        type_guid = entry[0:16]
                        if type_guid == b'\x00' * 16:
                            continue
                        first_lba = struct.unpack('<Q', entry[32:40])[0]
                        last_lba = struct.unpack('<Q', entry[40:48])[0]
                        name = entry[56:128].decode('utf-16-le', errors='replace').rstrip('\x00')
                        size_mb = (last_lba - first_lba + 1) * 512 // 1024 // 1024
                        print(f"  P{i+1}: LBA {first_lba}-{last_lba} ({size_mb}MB) \"{name}\"")
            else:
                print(f"  Not a valid GPT header: {sig}")

    print("\n=== Done reading partition table ===")
    print("Use the interactive REPL to read specific blocks:")
    print("  dump_blocks(start_block, count)")
    print("  read_block(block_num)")

    # Drop to interactive mode
    print("\nEntering interactive mode (type commands, Ctrl+C to exit)...")
    import select, tty, termios
    old = termios.tcgetattr(sys.stdin)
    try:
        tty.setraw(sys.stdin)
        ser.timeout = 0.1
        while True:
            data = ser.read(256)
            if data:
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()
            if select.select([sys.stdin], [], [], 0)[0]:
                ch = sys.stdin.buffer.read(1)
                if ch == b'\x03':
                    break
                ser.write(ch)
    except KeyboardInterrupt:
        pass
    finally:
        termios.tcsetattr(sys.stdin, termios.TCSADRAIN, old)

    ser.close()
    print("\nDone.")


if __name__ == "__main__":
    main()
