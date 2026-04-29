/**
 * Pure-TS LDF container helper. Mirrors tools/firmware/ldf-extract.py.
 *
 * LDF format (per docs/firmware-re/powpak.md):
 *
 *   0x00-0x3F : ASCII filename, NUL-padded (64 bytes)
 *   0x40-0x7F : metadata (16 BE32 fields including file_size, format_version,
 *               header_trailer_len, product_class_marker, hash1, size_a,
 *               record_count, size_b, hash2)
 *   0x80+     : plaintext compiled HCS08 image
 */

export const LDF_HEADER_LEN = 0x80;

/**
 * Returns a zero-copy view of the LDF body (everything past the 0x80-byte
 * header). Throws on files shorter than the header.
 */
export function stripLdfHeader(file: Uint8Array): Uint8Array {
  if (file.length < LDF_HEADER_LEN) {
    throw new Error(
      `LDF file too short: ${file.length} bytes < ${LDF_HEADER_LEN}-byte header`,
    );
  }
  return file.subarray(LDF_HEADER_LEN);
}
