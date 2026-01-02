#!/usr/bin/env python3
"""
Lutron .lut/.bkf Database Extractor
Extracts SQL Server .mdf and .ldf files from Lutron backup files
"""

import struct
import os
import sys

def find_sql_server_start(f, search_start, max_search=100000):
    """Find the start of SQL Server database by looking for page signature"""
    f.seek(search_start)
    chunk = f.read(max_search)

    # SQL Server pages start with 0x01 0x0f signature
    for i in range(0, len(chunk), 512):
        if chunk[i:i+2] == b'\x01\x0f':
            return search_start + i

    return None

def extract_file(input_file, output_file, start_offset, max_size, expected_size=None):
    """Extract a file from the backup and optionally pad to expected size"""
    print(f"Extracting to: {output_file}")
    print(f"  Start offset: 0x{start_offset:08x}")
    print(f"  Max size: {max_size:,} bytes ({max_size / 1024 / 1024:.2f} MB)")

    with open(input_file, 'rb') as f_in:
        with open(output_file, 'wb') as f_out:
            f_in.seek(start_offset)

            # Read and write in chunks
            total_written = 0
            chunk_size = 1024 * 1024  # 1MB chunks for faster extraction

            while total_written < max_size:
                to_read = min(chunk_size, max_size - total_written)
                chunk = f_in.read(to_read)

                if not chunk:
                    break

                f_out.write(chunk)
                total_written += len(chunk)

                if total_written % (10 * 1024 * 1024) == 0:  # Progress every 10MB
                    print(f"  Progress: {total_written / 1024 / 1024:.1f} MB / {max_size / 1024 / 1024:.1f} MB")

            print(f"  Total extracted: {total_written:,} bytes ({total_written / 1024 / 1024:.2f} MB)")

    # Pad to expected size if needed (for sparse backups)
    if expected_size and total_written < expected_size:
        padding_needed = expected_size - total_written
        print(f"  Padding with {padding_needed:,} zero bytes to reach expected size...")

        with open(output_file, 'ab') as f_out:
            f_out.write(b'\x00' * padding_needed)

        final_size = os.path.getsize(output_file)
        print(f"  Final size: {final_size:,} bytes ({final_size / 1024:.1f} KB)")

    return total_written

def main():
    if len(sys.argv) < 2:
        print("Usage: python extract_lutron_db.py <input.bkf> [output_dir]")
        sys.exit(1)

    input_file = sys.argv[1]
    output_dir = sys.argv[2] if len(sys.argv) > 2 else 'extracted'

    if not os.path.exists(input_file):
        print(f"Error: File not found: {input_file}")
        sys.exit(1)

    os.makedirs(output_dir, exist_ok=True)

    print(f"Lutron Database Extractor")
    print(f"=" * 50)
    print(f"Input: {input_file}")
    print(f"Output directory: {output_dir}")
    print()

    with open(input_file, 'rb') as f:
        # Find the filenames
        f.seek(0)
        data = f.read(100000)

        # Find Project.mdf
        mdf_name_pos = data.find("Project.mdf".encode('utf-16le'))
        ldf_name_pos = data.find("Project_log".encode('utf-16le'))

        if mdf_name_pos < 0:
            print("Error: Could not find Project.mdf in backup")
            sys.exit(1)

        print(f"Found 'Project.mdf' reference at 0x{mdf_name_pos:08x}")
        if ldf_name_pos >= 0:
            print(f"Found 'Project_log.ldf' reference at 0x{ldf_name_pos:08x}")
        print()

        # The actual database data starts at 0x4000 based on analysis
        # Find the SQL Server signature to confirm
        mdf_start = find_sql_server_start(f, 0x3000, 10000)

        if mdf_start:
            print(f"Found SQL Server database signature at 0x{mdf_start:08x}")
        else:
            print("Warning: Could not find SQL Server signature, using default offset 0x4000")
            mdf_start = 0x4000

        print()

        # Extract .mdf file (first data block contains it)
        # Based on analysis, first data block goes until 0x02284000
        mdf_max_size = 0x02284000 - mdf_start

        # SQL Server expects 35,840 KB (36,700,160 bytes) for this database
        # The backup is sparse (unallocated pages not backed up), so we pad to expected size
        mdf_expected_size = 36700160  # 35,840 KB

        mdf_output = os.path.join(output_dir, "Project.mdf")
        mdf_size = extract_file(input_file, mdf_output, mdf_start, mdf_max_size, mdf_expected_size)

        print()

        # Extract .ldf file (in third data block)
        # Third block starts at 0x02284400, data at 0x0228443c
        # Look for SQL Server log file signature
        ldf_start = find_sql_server_start(f, 0x02284000, 10000)

        if ldf_start:
            print(f"Found potential log file at 0x{ldf_start:08x}")
            ldf_max_size = 0x022a5000 - ldf_start

            ldf_output = os.path.join(output_dir, "Project_log.ldf")
            ldf_size = extract_file(input_file, ldf_output, ldf_start, ldf_max_size)
        else:
            print("Note: Could not locate log file (.ldf)")
            ldf_size = 0

        print()
        print("=" * 50)
        print("Extraction complete!")

        # Show final .mdf file size
        final_mdf_size = os.path.getsize(mdf_output)
        print(f"  Project.mdf: {final_mdf_size:,} bytes ({final_mdf_size / 1024:.1f} KB)")
        if final_mdf_size == mdf_expected_size:
            print(f"    ✓ Padded to SQL Server expected size")

        if ldf_size > 0:
            print(f"  Project_log.ldf: {ldf_size:,} bytes ({ldf_size / 1024 / 1024:.2f} MB)")

        print()
        print("Next steps:")
        print("1. Copy files to your Windows SQL Server machine")
        print("2. Delete any old Project_log.ldf file in the same directory")
        print("3. Attach the database using SQL Server Management Studio (SSMS):")
        print()
        print("   -- Run this in SSMS:")
        print("   CREATE DATABASE [Project] ON")
        print("     (FILENAME = 'C:\\full\\path\\to\\Project.mdf')")
        print("     FOR ATTACH_FORCE_REBUILD_LOG;")
        print("   GO")
        print()
        print("Note: The backup was sparse (unallocated pages not backed up),")
        print("      so the .mdf file has been padded with zeros to the expected size.")

if __name__ == '__main__':
    main()
