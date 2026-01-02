#!/usr/bin/env python3
"""
Lutron Project File Tool
A comprehensive CLI tool for working with Lutron project files (.ra3, .hw, .lut)

Supports:
- RadioRA3 (.ra3) and Homeworks QS (.hw) project files
- Lutron backup (.lut) files
- SQL Server database (.mdf/.ldf) extraction and packing

Usage:
  lutron-tool.py extract <input_file> [output_dir]
  lutron-tool.py pack <input> <output_file>
  lutron-tool.py info <file>
"""

import os
import sys
import struct
import zipfile
import argparse
from pathlib import Path
from typing import Optional, Tuple

# ============================================================================
# EXTRACTION FUNCTIONS
# ============================================================================

def extract_project_file(input_file: str, output_dir: str) -> None:
    """Extract .ra3 or .hw file to get .lut file"""
    print(f"Extracting Lutron project file: {input_file}")
    print(f"Output directory: {output_dir}")

    os.makedirs(output_dir, exist_ok=True)

    # Remember the original file extension for later packing
    original_ext = Path(input_file).suffix.lower()
    project_type = 'ra3' if original_ext == '.ra3' else 'hw'

    with zipfile.ZipFile(input_file, 'r') as zf:
        file_list = zf.namelist()
        print(f"Found {len(file_list)} file(s) in archive:")

        for filename in file_list:
            print(f"  - {filename}")
            zf.extract(filename, output_dir)

        print(f"\n✓ Extracted to: {output_dir}")

        # Save metadata about original project type
        lut_files = [f for f in file_list if f.endswith('.lut')]
        if lut_files:
            lut_path = os.path.join(output_dir, lut_files[0])

            # Write metadata file
            metadata = {
                'original_file': os.path.basename(input_file),
                'project_type': project_type,
                'lut_file': lut_files[0]
            }

            metadata_path = os.path.join(output_dir, '.lutron-metadata.json')
            import json
            with open(metadata_path, 'w') as f:
                json.dump(metadata, f, indent=2)

            print(f"\n💡 Next step: Extract database from .lut file:")
            print(f"   python lutron-tool.py extract \"{lut_path}\"")

def find_sql_server_start(f, search_start: int, max_search: int = 100000) -> Optional[int]:
    """Find the start of SQL Server database by looking for page signature"""
    f.seek(search_start)
    chunk = f.read(max_search)

    # SQL Server pages start with 0x01 0x0f signature
    for i in range(0, len(chunk), 512):
        if chunk[i:i+2] == b'\x01\x0f':
            return search_start + i

    return None

def extract_database_file(f_in, output_file: str, start_offset: int,
                         max_size: int, expected_size: Optional[int] = None) -> int:
    """Extract a database file from the backup and optionally pad to expected size"""
    print(f"  Start offset: 0x{start_offset:08x}")
    print(f"  Max size: {max_size:,} bytes ({max_size / 1024 / 1024:.2f} MB)")

    with open(output_file, 'wb') as f_out:
        f_in.seek(start_offset)

        # Read and write in chunks
        total_written = 0
        chunk_size = 1024 * 1024  # 1MB chunks

        while total_written < max_size:
            to_read = min(chunk_size, max_size - total_written)
            chunk = f_in.read(to_read)

            if not chunk:
                break

            f_out.write(chunk)
            total_written += len(chunk)

            if total_written % (10 * 1024 * 1024) == 0:  # Progress every 10MB
                print(f"  Progress: {total_written / 1024 / 1024:.1f} MB / {max_size / 1024 / 1024:.1f} MB")

        print(f"  Extracted: {total_written:,} bytes ({total_written / 1024 / 1024:.2f} MB)")

    # Pad to expected size if needed (for sparse backups)
    if expected_size and total_written < expected_size:
        padding_needed = expected_size - total_written
        print(f"  Padding with {padding_needed:,} zero bytes...")

        with open(output_file, 'ab') as f_out:
            f_out.write(b'\x00' * padding_needed)

        final_size = os.path.getsize(output_file)
        print(f"  Final size: {final_size:,} bytes ({final_size / 1024:.1f} KB)")

    return total_written

def extract_lut_file(input_file: str, output_dir: str) -> None:
    """Extract SQL Server database files from .lut file"""
    print(f"Extracting Lutron backup file: {input_file}")
    print(f"Output directory: {output_dir}")
    print()

    os.makedirs(output_dir, exist_ok=True)

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

        # Find the SQL Server signature
        mdf_start = find_sql_server_start(f, 0x3000, 10000)

        if mdf_start:
            print(f"Found SQL Server database signature at 0x{mdf_start:08x}")
        else:
            print("Warning: Could not find SQL Server signature, using default offset 0x4000")
            mdf_start = 0x4000

        print()

        # Extract .mdf file
        print("Extracting Project.mdf...")
        mdf_max_size = 0x02284000 - mdf_start

        # SQL Server expects 35,840 KB (36,700,160 bytes) for typical Lutron database
        # The backup is sparse (unallocated pages not backed up), so we pad to expected size
        mdf_expected_size = 36700160  # 35,840 KB

        mdf_output = os.path.join(output_dir, "Project.mdf")
        extract_database_file(f, mdf_output, mdf_start, mdf_max_size, mdf_expected_size)

        print()

        # Extract .ldf file (transaction log)
        print("Extracting Project_log.ldf...")
        ldf_start = find_sql_server_start(f, 0x02284000, 10000)

        if ldf_start:
            print(f"  Found log file at 0x{ldf_start:08x}")
            ldf_max_size = 0x022a5000 - ldf_start

            ldf_output = os.path.join(output_dir, "Project_log.ldf")
            extract_database_file(f, ldf_output, ldf_start, ldf_max_size)
        else:
            print("  Note: Could not locate log file (.ldf)")

        print()
        print("=" * 70)
        print("✓ Extraction complete!")

        # Show final sizes
        final_mdf_size = os.path.getsize(mdf_output)
        print(f"  Project.mdf: {final_mdf_size:,} bytes ({final_mdf_size / 1024:.1f} KB)")

        if ldf_start:
            final_ldf_size = os.path.getsize(ldf_output)
            print(f"  Project_log.ldf: {final_ldf_size:,} bytes ({final_ldf_size / 1024:.1f} KB)")

        print()
        print("💡 Next steps:")
        print("   1. Copy files to Windows SQL Server machine")
        print("   2. Delete any old Project_log.ldf in the same directory")
        print("   3. Attach the database in SQL Server:")
        print()
        print("      CREATE DATABASE [Project] ON")
        print("        (FILENAME = 'C:\\path\\to\\Project.mdf')")
        print("        FOR ATTACH_FORCE_REBUILD_LOG;")
        print("      GO")

# ============================================================================
# PACKING FUNCTIONS
# ============================================================================

def pack_to_lut(mdf_file: str, output_file: str, ldf_file: Optional[str] = None,
                template_lut: Optional[str] = None) -> None:
    """Pack SQL Server database files into a .lut file

    Args:
        mdf_file: Path to the .mdf file
        output_file: Path to output .lut file
        ldf_file: Optional path to .ldf file
        template_lut: Optional path to an existing .lut file to use as template
    """
    print(f"Packing database files to .lut format...")
    print(f"Input MDF: {mdf_file}")
    if ldf_file:
        print(f"Input LDF: {ldf_file}")
    if template_lut:
        print(f"Template: {template_lut}")
    print(f"Output: {output_file}")
    print()

    # Read the .mdf file
    with open(mdf_file, 'rb') as f:
        mdf_data = f.read()

    print(f"Read .mdf file: {len(mdf_data):,} bytes")

    if template_lut and os.path.exists(template_lut):
        # Use template-based packing (recommended - preserves all MTF headers)
        print("Using template-based packing...")

        with open(template_lut, 'rb') as f_template:
            # Read the template header (everything before database data)
            header_data = f_template.read(0x4000)  # Header up to 0x4000

        with open(output_file, 'wb') as f_out:
            # Write template header
            f_out.write(header_data)

            # Write new database data
            f_out.write(mdf_data)

            # Write .ldf if provided
            if ldf_file and os.path.exists(ldf_file):
                with open(ldf_file, 'rb') as f_ldf:
                    ldf_data = f_ldf.read()

                # Align to block boundary (0x02284000 in original)
                current_pos = f_out.tell()
                next_block = 0x02284000  # Standard offset for log file

                # Pad with zeros if needed
                if current_pos < next_block:
                    padding = next_block - current_pos
                    f_out.write(b'\x00' * padding)
                    f_out.seek(next_block)

                f_out.write(ldf_data)

    else:
        # Generate MTF structure from scratch (fallback)
        print("Warning: No template provided - generating MTF structure...")
        print("Note: It's recommended to use --template with an existing .lut file")

        with open(output_file, 'wb') as f_out:
            # Write MTF headers
            tape_header = create_tape_header()
            f_out.write(tape_header)

            # SFMB block at 0x1000
            f_out.seek(0x1000)
            f_out.write(create_sfmb_block())

            # SSET block at 0x2000
            f_out.seek(0x2000)
            f_out.write(create_sset_block())

            # VOLB block at 0x2400
            f_out.seek(0x2400)
            f_out.write(create_volb_block())

            # MSCI block at 0x2800
            f_out.seek(0x2800)
            f_out.write(create_msci_block())

            # MSDA header at 0x3800
            f_out.seek(0x3800)
            f_out.write(create_msda_block())

            # Database data at 0x4000
            f_out.seek(0x4000)
            f_out.write(mdf_data)

            # Write .ldf if provided
            if ldf_file and os.path.exists(ldf_file):
                with open(ldf_file, 'rb') as f_ldf:
                    ldf_data = f_ldf.read()

                f_out.seek(0x02284000)
                f_out.write(ldf_data)

    final_size = os.path.getsize(output_file)
    print(f"\n✓ Created .lut file: {final_size:,} bytes ({final_size / 1024 / 1024:.2f} MB)")

def pack_to_project(lut_file: str, output_file: str, project_type: Optional[str] = None) -> None:
    """Pack .lut file into .ra3 or .hw project file

    Args:
        lut_file: Path to .lut file
        output_file: Output file path (extension determines type if project_type not specified)
        project_type: 'ra3' or 'hw' (auto-detected if not specified)
    """
    # Auto-detect project type from metadata or output filename
    if project_type is None:
        # First, check if there's a metadata file nearby
        lut_dir = os.path.dirname(lut_file) if os.path.dirname(lut_file) else '.'
        metadata_path = os.path.join(lut_dir, '.lutron-metadata.json')

        if os.path.exists(metadata_path):
            import json
            with open(metadata_path, 'r') as f:
                metadata = json.load(f)
                project_type = metadata.get('project_type', 'hw')
                print(f"Detected project type from metadata: .{project_type}")

                # Auto-add extension if not present
                output_ext = Path(output_file).suffix.lower()
                if not output_ext:
                    output_file += f'.{project_type}'
        else:
            # Fall back to output file extension
            output_ext = Path(output_file).suffix.lower()
            if output_ext == '.ra3':
                project_type = 'ra3'
            elif output_ext == '.hw':
                project_type = 'hw'
            else:
                # Default to .hw if no extension or unknown
                project_type = 'hw'
                # Auto-add extension if missing
                if not output_ext:
                    output_file += '.hw'
                print(f"No project type specified, defaulting to .{project_type}")

    print(f"Packing .lut file to .{project_type} format...")
    print(f"Input: {lut_file}")
    print(f"Output: {output_file}")

    # Ensure output file has correct extension
    output_ext = Path(output_file).suffix.lower()
    expected_ext = f'.{project_type}'
    if output_ext != expected_ext:
        print(f"⚠️  Warning: Output file has extension '{output_ext}' but packing as '{expected_ext}'")

    # Get the original filename from the .lut file
    lut_filename = os.path.basename(lut_file)

    # Create ZIP file
    with zipfile.ZipFile(output_file, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
        zf.write(lut_file, lut_filename)

    final_size = os.path.getsize(output_file)
    print(f"\n✓ Created .{project_type} file: {final_size:,} bytes ({final_size / 1024 / 1024:.2f} MB)")

# ============================================================================
# MTF BLOCK CREATION FUNCTIONS
# ============================================================================

def create_mtf_block_header(block_type: bytes, attrs: int = 0, stream_offset: int = 0) -> bytes:
    """Create a standard MTF block header (52 bytes)"""
    header = bytearray(512)

    # Block type (4 bytes)
    header[0:4] = block_type

    # Attributes (4 bytes)
    struct.pack_into('<I', header, 4, attrs)

    # Stream offset (2 bytes)
    struct.pack_into('<H', header, 8, stream_offset)

    # OS ID and version (2 bytes)
    header[10] = 0x0e  # Windows
    header[11] = 0x01

    return bytes(header)

def create_tape_header() -> bytes:
    """Create TAPE header block"""
    header = create_mtf_block_header(b'TAPE', stream_offset=140)
    return header

def create_sfmb_block() -> bytes:
    """Create SFMB (Soft File Mark) block"""
    return create_mtf_block_header(b'SFMB', stream_offset=4096)

def create_sset_block() -> bytes:
    """Create SSET (Start of Set) block"""
    return create_mtf_block_header(b'SSET', stream_offset=164)

def create_volb_block() -> bytes:
    """Create VOLB (Volume) block"""
    return create_mtf_block_header(b'VOLB', stream_offset=108)

def create_msci_block() -> bytes:
    """Create MSCI (Media Catalog Info) block"""
    return create_mtf_block_header(b'MSCI', stream_offset=56)

def create_sfin_block(filename: str) -> bytes:
    """Create SFIN (Start of File) block"""
    block = bytearray(512)

    # Basic header
    header = create_mtf_block_header(b'SFIN', stream_offset=0)
    block[0:len(header)] = header

    # Add filename in UTF-16LE at appropriate offset
    filename_utf16 = filename.encode('utf-16le')
    # Store filename somewhere in the block (simplified)

    return bytes(block)

def create_msda_block() -> bytes:
    """Create MSDA (Microsoft Data) block"""
    return create_mtf_block_header(b'MSDA', stream_offset=60)

# ============================================================================
# INFO FUNCTION
# ============================================================================

def show_file_info(input_file: str) -> None:
    """Show information about a Lutron file"""
    ext = Path(input_file).suffix.lower()

    print(f"File: {input_file}")
    print(f"Size: {os.path.getsize(input_file):,} bytes ({os.path.getsize(input_file) / 1024 / 1024:.2f} MB)")
    print()

    if ext in ['.ra3', '.hw']:
        print(f"Type: Lutron {'RadioRA3' if ext == '.ra3' else 'Homeworks QS'} Project File")
        print("Format: ZIP archive")
        print()

        with zipfile.ZipFile(input_file, 'r') as zf:
            print("Contents:")
            for info in zf.infolist():
                print(f"  {info.filename}")
                print(f"    Compressed: {info.compress_size:,} bytes")
                print(f"    Uncompressed: {info.file_size:,} bytes")
                print(f"    Modified: {info.date_time}")

    elif ext == '.lut':
        print("Type: Lutron Backup File (MTF format)")
        print("Format: Microsoft Tape Format")
        print()

        with open(input_file, 'rb') as f:
            # Check for SQL Server signature
            f.seek(0x4000)
            sig = f.read(2)

            if sig == b'\x01\x0f':
                print("✓ Contains SQL Server database")
                print(f"  Database starts at: 0x4000")

    elif ext == '.mdf':
        print("Type: SQL Server Database File")

        with open(input_file, 'rb') as f:
            sig = f.read(2)
            if sig == b'\x01\x0f':
                print("✓ Valid SQL Server file header")

# ============================================================================
# MAIN CLI
# ============================================================================

def main():
    parser = argparse.ArgumentParser(
        description='Lutron Project File Tool - Extract and pack Lutron project files',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''
Examples:
  # Extract .ra3 or .hw to get .lut file
  %(prog)s extract "project.ra3" output/

  # Extract .lut to get .mdf and .ldf files
  %(prog)s extract "backup.lut" database/

  # Pack .mdf back to .lut (TODO)
  %(prog)s pack database/Project.mdf output.lut

  # Pack .lut back to .ra3 or .hw
  %(prog)s pack backup.lut output.ra3

  # Show file information
  %(prog)s info project.ra3
        '''
    )

    subparsers = parser.add_subparsers(dest='command', help='Command to execute')

    # Extract command
    extract_parser = subparsers.add_parser('extract', help='Extract files')
    extract_parser.add_argument('input', help='Input file (.ra3, .hw, or .lut)')
    extract_parser.add_argument('output', nargs='?', default=None, help='Output directory')

    # Pack command
    pack_parser = subparsers.add_parser('pack', help='Pack files')
    pack_parser.add_argument('input', help='Input file or directory')
    pack_parser.add_argument('output', help='Output file')
    pack_parser.add_argument('--template', '-t', help='Template .lut file (recommended for .lut packing)')

    # Info command
    info_parser = subparsers.add_parser('info', help='Show file information')
    info_parser.add_argument('file', help='File to inspect')

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    # Execute command
    if args.command == 'extract':
        input_path = args.input
        ext = Path(input_path).suffix.lower()

        # Auto-generate output directory if not specified
        if args.output is None:
            base_name = Path(input_path).stem
            output_dir = f"{base_name}_extracted"
        else:
            output_dir = args.output

        if ext in ['.ra3', '.hw']:
            extract_project_file(input_path, output_dir)
        elif ext == '.lut':
            extract_lut_file(input_path, output_dir)
        else:
            print(f"Error: Unsupported file type: {ext}")
            print("Supported: .ra3, .hw, .lut")
            sys.exit(1)

    elif args.command == 'pack':
        input_path = args.input
        output_path = args.output
        output_ext = Path(output_path).suffix.lower()

        # Auto-detect what we're packing based on input file
        input_ext = Path(input_path).suffix.lower()

        if input_ext == '.lut':
            # Packing .lut to .ra3/.hw
            # If no extension provided, auto-detect from metadata
            if not output_ext:
                # Will be auto-detected by pack_to_project
                pass
            elif output_ext not in ['.ra3', '.hw']:
                # User provided extension but it's not .ra3 or .hw, assume they want .hw
                output_path += '.hw'

            pack_to_project(input_path, output_path)

        elif input_ext == '.mdf':
            # Packing .mdf/.ldf to .lut
            # Ensure output is .lut
            if output_ext and output_ext != '.lut':
                print(f"Error: When packing .mdf files, output must be .lut (got {output_ext})")
                sys.exit(1)

            if not output_ext:
                output_path += '.lut'

            # Look for .ldf in same directory
            ldf_path = input_path.replace('.mdf', '_log.ldf')
            if not os.path.exists(ldf_path):
                ldf_path = input_path.replace('.mdf', '.ldf')
            if not os.path.exists(ldf_path):
                ldf_path = None

            template_lut = args.template if hasattr(args, 'template') else None
            pack_to_lut(input_path, output_path, ldf_path, template_lut)

        else:
            print(f"Error: Unsupported input file type: {input_ext}")
            print("Supported inputs: .mdf (to create .lut), .lut (to create .ra3/.hw)")
            sys.exit(1)

    elif args.command == 'info':
        show_file_info(args.file)

if __name__ == '__main__':
    main()
