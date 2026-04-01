#!/usr/bin/env python3
"""
Phoenix eMMC ext4 file extractor — runs on Raspberry Pi.

Boots the emmc-read ARM stub, then navigates ext4 filesystem
to extract files from a specific path.

Usage: python3 emmc-extract.py /etc/ssl/firmwareupgrade
"""

import sys
import os
import time
import struct
import subprocess

import serial
import xmodem

BIN_PATH = os.path.expanduser("~/emmc-read.bin")
SERIAL_PORT = "/dev/ttyAMA0"
BAUD = 115200
GPIO_POWER = 17

# Partition layout (from GPT)
ROOTFS_START_LBA = 77824

# ext4 superblock values (pre-parsed)
BLOCK_SIZE = 1024
INODE_SIZE = 128
INODES_PER_GROUP = 2032
FIRST_DATA_BLOCK = 1
BG_DESC_SIZE = 32

def gpio_set(pin, value):
    level = "dh" if value else "dl"
    subprocess.run(["pinctrl", "set", str(pin), "op", level],
                   check=True, capture_output=True)

def power_cycle(off_time=0.5):
    gpio_set(GPIO_POWER, 1)
    time.sleep(off_time)
    gpio_set(GPIO_POWER, 0)

def wait_for_cccc(ser, timeout=15):
    buf = b""
    start = time.time()
    while time.time() - start < timeout:
        data = ser.read(ser.in_waiting or 1)
        if data:
            buf += data
            if b"CCC" in buf[-10:]:
                time.sleep(0.3)
                ser.reset_input_buffer()
                return True
    return False

def send_xmodem(ser, filepath):
    def getc(size, timeout=1):
        ser.timeout = timeout
        return ser.read(size) or None
    def putc(data, timeout=1):
        ser.write_timeout = timeout
        return ser.write(data)
    modem = xmodem.XMODEM(getc, putc)
    with open(filepath, "rb") as f:
        return modem.send(f, retry=10)

def boot_reader(ser):
    """Boot the eMMC reader and wait for prompt."""
    print("Power cycling...")
    power_cycle(0.5)
    time.sleep(0.2)
    ser.reset_input_buffer()

    print("Waiting for CCCC...", end="", flush=True)
    if not wait_for_cccc(ser):
        power_cycle(1.0)
        time.sleep(0.2)
        ser.reset_input_buffer()
        if not wait_for_cccc(ser):
            print(" FAILED")
            return False
    print(" OK")

    size = os.path.getsize(BIN_PATH)
    print(f"XMODEM {size} bytes...", end="", flush=True)
    if not send_xmodem(ser, BIN_PATH):
        print(" FAILED")
        return False
    print(" OK")

    # Wait for prompt
    buf = b""
    start = time.time()
    ser.timeout = 0.5
    while time.time() - start < 30:
        data = ser.read(ser.in_waiting or 1)
        if data:
            buf += data
            if b"> " in buf:
                print("eMMC reader ready!")
                return True
    print(f"Timeout waiting for prompt. Got: {buf[-100:]}")
    return False

def read_sectors(ser, start_lba, count):
    """Read sectors from the eMMC reader (must already be booted)."""
    result = bytearray()
    for i in range(count):
        sector = start_lba + i
        # Send read command
        ser.reset_input_buffer()
        cmd = f"R {sector:08X}\r"
        ser.write(cmd.encode())
        time.sleep(0.02)

        # Read response
        buf = b""
        start = time.time()
        ser.timeout = 5
        while time.time() - start < 10:
            data = ser.read(ser.in_waiting or 1)
            if data:
                buf += data
                if b"> " in buf:
                    break

        # Parse hex dump
        in_sector = False
        sector_data = bytearray()
        for line in buf.decode('ascii', errors='replace').split('\n'):
            line = line.strip()
            if line.startswith('S '):
                in_sector = True
                continue
            if line == 'E':
                in_sector = False
                continue
            if in_sector and line:
                for h in line.split():
                    if len(h) == 2:
                        try:
                            sector_data.append(int(h, 16))
                        except ValueError:
                            pass

        if len(sector_data) >= 512:
            result += sector_data[:512]
        else:
            print(f"  WARNING: sector {sector:#x} got {len(sector_data)} bytes")
            result += sector_data.ljust(512, b'\x00')

    return bytes(result)

def block_to_lba(block_num):
    """Convert ext4 block number to eMMC LBA."""
    return ROOTFS_START_LBA + (block_num * BLOCK_SIZE) // 512

def read_blocks(ser, block_num, count=1):
    """Read ext4 blocks."""
    lba = block_to_lba(block_num)
    sectors_per_block = BLOCK_SIZE // 512
    return read_sectors(ser, lba, count * sectors_per_block)

def get_bg_descriptor(ser, bg_num):
    """Read a block group descriptor."""
    # BG desc table starts at block (first_data_block + 1) = block 2
    desc_table_block = FIRST_DATA_BLOCK + 1
    desc_offset = bg_num * BG_DESC_SIZE
    block_offset = desc_offset // BLOCK_SIZE
    byte_offset = desc_offset % BLOCK_SIZE

    data = read_blocks(ser, desc_table_block + block_offset)
    desc = data[byte_offset:byte_offset + BG_DESC_SIZE]

    return {
        'block_bitmap': struct.unpack_from('<I', desc, 0)[0],
        'inode_bitmap': struct.unpack_from('<I', desc, 4)[0],
        'inode_table': struct.unpack_from('<I', desc, 8)[0],
    }

def read_inode(ser, inode_num):
    """Read an inode by number."""
    bg_num = (inode_num - 1) // INODES_PER_GROUP
    local_idx = (inode_num - 1) % INODES_PER_GROUP

    bg = get_bg_descriptor(ser, bg_num)
    inode_table_block = bg['inode_table']

    # Calculate byte offset within inode table
    byte_offset = local_idx * INODE_SIZE
    block_offset = byte_offset // BLOCK_SIZE
    within_block = byte_offset % BLOCK_SIZE

    data = read_blocks(ser, inode_table_block + block_offset)
    raw = data[within_block:within_block + INODE_SIZE]

    mode = struct.unpack_from('<H', raw, 0)[0]
    size_lo = struct.unpack_from('<I', raw, 4)[0]
    size_hi = struct.unpack_from('<I', raw, 108)[0] if len(raw) > 108 else 0
    size = size_lo | (size_hi << 32)
    flags = struct.unpack_from('<I', raw, 32)[0]
    i_block = raw[40:100]

    return {
        'mode': mode,
        'size': size,
        'flags': flags,
        'i_block': i_block,
        'is_dir': bool(mode & 0x4000),
        'is_file': bool(mode & 0x8000),
        'is_link': bool(mode & 0xA000 == 0xA000),
    }

def get_data_blocks(ser, inode):
    """Get list of (physical_block, length) from inode's extent tree."""
    i_block = inode['i_block']
    flags = inode['flags']

    if flags & 0x80000:  # EXT4_EXTENTS_FL
        return _walk_extents(ser, i_block)
    else:
        # Direct blocks (legacy)
        blocks = []
        for i in range(12):
            blk = struct.unpack_from('<I', i_block, i*4)[0]
            if blk:
                blocks.append((blk, 1))
        return blocks

def _walk_extents(ser, data):
    """Walk an extent tree node."""
    eh_magic = struct.unpack_from('<H', data, 0)[0]
    eh_entries = struct.unpack_from('<H', data, 2)[0]
    eh_depth = struct.unpack_from('<H', data, 6)[0]

    if eh_magic != 0xF30A:
        print(f"  WARNING: bad extent magic 0x{eh_magic:04X}")
        return []

    extents = []
    if eh_depth == 0:
        # Leaf extents
        for i in range(eh_entries):
            off = 12 + i * 12
            ee_len = struct.unpack_from('<H', data, off+4)[0]
            ee_start_hi = struct.unpack_from('<H', data, off+6)[0]
            ee_start_lo = struct.unpack_from('<I', data, off+8)[0]
            ee_start = (ee_start_hi << 32) | ee_start_lo
            extents.append((ee_start, ee_len))
    else:
        # Index nodes - need to read child blocks
        for i in range(eh_entries):
            off = 12 + i * 12
            ei_leaf_lo = struct.unpack_from('<I', data, off+4)[0]
            ei_leaf_hi = struct.unpack_from('<H', data, off+8)[0]
            ei_leaf = (ei_leaf_hi << 32) | ei_leaf_lo
            child_data = read_blocks(ser, ei_leaf)
            extents.extend(_walk_extents(ser, child_data))

    return extents

def read_file_data(ser, inode):
    """Read complete file data from inode."""
    extents = get_data_blocks(ser, inode)
    data = bytearray()
    for phys_block, length in extents:
        block_data = read_blocks(ser, phys_block, length)
        data += block_data
    return bytes(data[:inode['size']])

def list_directory(ser, inode):
    """List directory entries from inode."""
    extents = get_data_blocks(ser, inode)
    entries = []

    for phys_block, length in extents:
        data = read_blocks(ser, phys_block, length)
        offset = 0
        while offset < len(data):
            ino = struct.unpack_from('<I', data, offset)[0]
            rec_len = struct.unpack_from('<H', data, offset+4)[0]
            if rec_len == 0:
                break
            name_len = data[offset+6]
            file_type = data[offset+7]
            name = data[offset+8:offset+8+name_len].decode('ascii', errors='replace')
            if ino > 0:
                entries.append({
                    'inode': ino,
                    'name': name,
                    'type': file_type,  # 1=file, 2=dir, 7=symlink
                })
            offset += rec_len

    return entries

def resolve_path(ser, path):
    """Navigate ext4 path from root, return target inode number."""
    parts = [p for p in path.strip('/').split('/') if p]

    current_inode_num = 2  # root
    for part in parts:
        print(f"  Looking up '{part}' in inode {current_inode_num}...")
        inode = read_inode(ser, current_inode_num)
        if not inode['is_dir']:
            print(f"  ERROR: inode {current_inode_num} is not a directory")
            return None

        entries = list_directory(ser, inode)
        found = False
        for e in entries:
            if e['name'] == part:
                current_inode_num = e['inode']
                found = True
                break

        if not found:
            print(f"  ERROR: '{part}' not found in directory")
            print(f"  Available: {[e['name'] for e in entries]}")
            return None

    return current_inode_num

def main():
    if len(sys.argv) < 2:
        print("Usage: emmc-extract.py <path> [output_dir]")
        print("  e.g.: emmc-extract.py /etc/ssl/firmwareupgrade")
        sys.exit(1)

    target_path = sys.argv[1]
    output_dir = sys.argv[2] if len(sys.argv) > 2 else os.path.expanduser("~/extracted")

    os.makedirs(output_dir, exist_ok=True)

    ser = serial.Serial(SERIAL_PORT, BAUD, timeout=1)
    try:
        if not boot_reader(ser):
            return

        time.sleep(0.5)
        ser.reset_input_buffer()

        print(f"\nNavigating to {target_path}...")
        target_ino = resolve_path(ser, target_path)
        if target_ino is None:
            return

        print(f"\nTarget inode: {target_ino}")
        target = read_inode(ser, target_ino)

        if target['is_dir']:
            print(f"Directory listing:")
            entries = list_directory(ser, target)
            for e in entries:
                if e['name'] in ('.', '..'):
                    continue
                type_str = {1:'file', 2:'dir', 7:'link'}.get(e['type'], '?')
                print(f"  [{type_str}] {e['name']} (inode {e['inode']})")

            # Extract all files
            print(f"\nExtracting files to {output_dir}/...")
            for e in entries:
                if e['name'] in ('.', '..'):
                    continue
                if e['type'] == 1:  # regular file
                    print(f"  Extracting {e['name']}...", end="", flush=True)
                    file_inode = read_inode(ser, e['inode'])
                    data = read_file_data(ser, file_inode)
                    outpath = os.path.join(output_dir, e['name'])
                    with open(outpath, 'wb') as f:
                        f.write(data)
                    print(f" {len(data)} bytes")
                elif e['type'] == 7:  # symlink
                    file_inode = read_inode(ser, e['inode'])
                    if file_inode['size'] < 60:
                        # Inline symlink in i_block
                        link_target = file_inode['i_block'][:file_inode['size']].decode('ascii', errors='replace')
                    else:
                        link_data = read_file_data(ser, file_inode)
                        link_target = link_data.decode('ascii', errors='replace')
                    print(f"  {e['name']} -> {link_target}")

        elif target['is_file']:
            print(f"File: size={target['size']} bytes")
            data = read_file_data(ser, target)
            fname = os.path.basename(target_path)
            outpath = os.path.join(output_dir, fname)
            with open(outpath, 'wb') as f:
                f.write(data)
            print(f"Saved to {outpath} ({len(data)} bytes)")

    finally:
        ser.close()

if __name__ == "__main__":
    main()
