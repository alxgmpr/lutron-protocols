#!/usr/bin/env bun
/**
 * QS Link RS-485 N81 Decoder
 *
 * Reads raw UART bytes captured at 44100 baud from a QS Link bus,
 * converts to bitstream, and N81-decodes to extract protocol packets.
 *
 * Usage:
 *   echo "06 00 e7 18 80 ..." | bun run tools/qslink-decode.ts
 *   bun run tools/qslink-decode.ts < capture.hex
 *   bun run tools/qslink-decode.ts --file capture.hex
 */

// N81 decode: start(0) + 8 data bits (LSB first) + stop(1)
function decodeN81Stream(bits: number[]): {
  bytes: number[];
  positions: number[];
} {
  const bytes: number[] = [];
  const positions: number[] = [];
  let pos = 0;

  while (pos + 10 <= bits.length) {
    // Find next start bit (0)
    if (bits[pos] !== 0) {
      pos++;
      continue;
    }

    // Check stop bit
    if (bits[pos + 9] !== 1) {
      pos++;
      continue;
    }

    // Extract 8 data bits LSB first
    let byte = 0;
    for (let i = 0; i < 8; i++) {
      byte |= (bits[pos + 1 + i] & 1) << i;
    }

    bytes.push(byte);
    positions.push(pos);
    pos += 10; // advance past this N81 symbol
  }

  return { bytes, positions };
}

// Convert hex string to UART bytes, then to bitstream
function hexToUartBitstream(hexStr: string): number[] {
  const uartBytes = hexStr
    .trim()
    .split(/\s+/)
    .map((h) => parseInt(h, 16));

  // Each UART byte is 8 bits, LSB first on the wire
  const bits: number[] = [];
  for (const b of uartBytes) {
    for (let i = 0; i < 8; i++) {
      bits.push((b >> i) & 1);
    }
  }
  return bits;
}

// Find packets by looking for non-idle bytes
// QS Link idle = 0xFF (all ones in N81 = mark/idle)
function extractPackets(
  bytes: number[],
  positions: number[],
): { packets: number[][]; gaps: number[] } {
  const packets: number[][] = [];
  const gaps: number[] = [];
  let current: number[] = [];
  let idleCount = 0;

  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0xff) {
      // Idle byte
      if (current.length > 0) {
        idleCount++;
        // After 3+ consecutive idle bytes, end the packet
        if (idleCount >= 3) {
          // Remove trailing 0xFF from packet
          while (current.length > 0 && current[current.length - 1] === 0xff) {
            current.pop();
          }
          if (current.length > 0) {
            packets.push(current);
            gaps.push(idleCount);
          }
          current = [];
          idleCount = 0;
        }
      }
    } else {
      if (current.length === 0 && idleCount > 0) {
        // Starting new packet after idle
        gaps.push(idleCount);
      }
      idleCount = 0;
      current.push(bytes[i]);
    }
  }

  // Don't forget the last packet
  while (current.length > 0 && current[current.length - 1] === 0xff) {
    current.pop();
  }
  if (current.length > 0) {
    packets.push(current);
  }

  return { packets, gaps };
}

// Format a packet for display
function formatPacket(pkt: number[]): string {
  return pkt.map((b) => b.toString(16).padStart(2, "0")).join(" ");
}

// Check if a packet contains a known pattern
function findSerial(pkt: number[], serial: number): boolean {
  const s = [
    (serial >> 24) & 0xff,
    (serial >> 16) & 0xff,
    (serial >> 8) & 0xff,
    serial & 0xff,
  ];
  const hex = pkt.map((b) => b.toString(16).padStart(2, "0")).join(" ");
  const serialHex = s.map((b) => b.toString(16).padStart(2, "0")).join(" ");
  return hex.includes(serialHex);
}

// Main
async function main() {
  let hexStr: string;

  const fileArg = process.argv.find((a) => a === "--file");
  if (fileArg) {
    const filePath = process.argv[process.argv.indexOf("--file") + 1];
    hexStr = await Bun.file(filePath).text();
  } else {
    // Read from stdin
    hexStr = await new Response(Bun.stdin.stream()).text();
  }

  // Clean up: extract just hex bytes
  hexStr = hexStr
    .replace(/[^0-9a-fA-F\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const bits = hexToUartBitstream(hexStr);
  console.log(`UART bytes: ${hexStr.split(/\s+/).length}`);
  console.log(`Bitstream: ${bits.length} bits`);

  const { bytes, positions } = decodeN81Stream(bits);
  console.log(`N81 decoded: ${bytes.length} bytes`);

  // Count idle vs data bytes
  const idleCount = bytes.filter((b) => b === 0xff).length;
  console.log(`Idle (0xFF): ${idleCount}, Data: ${bytes.length - idleCount}\n`);

  // Show all decoded bytes (non-idle) with position
  const { packets } = extractPackets(bytes, positions);

  console.log(`Found ${packets.length} packets:\n`);

  const serial = 0x03e63810;
  const serialBytes = [0x03, 0xe6, 0x38, 0x10];
  const serialHex = serialBytes
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");

  for (let i = 0; i < packets.length; i++) {
    const pkt = packets[i];
    const hex = formatPacket(pkt);
    const hasSerial = findSerial(pkt, serial);
    const marker = hasSerial ? " *** SERIAL FOUND ***" : "";

    // Try to identify packet structure
    let info = "";
    if (pkt.length >= 3 && pkt[1] === 0x21) {
      info = ` [0x21 proto, fmt=0x${pkt[2].toString(16).padStart(2, "0")}, ${pkt[2]}B payload]`;
    }

    console.log(`Pkt ${i + 1} [${pkt.length}B]: ${hex}${info}${marker}`);
  }

  // Also dump the first 200 non-idle N81 bytes for inspection
  console.log("\n--- First 200 non-idle N81 bytes ---");
  const nonIdle = bytes.filter((b) => b !== 0xff);
  console.log(formatPacket(nonIdle.slice(0, 200)));

  // Search for serial number
  const allHex = formatPacket(bytes);
  if (allHex.includes(serialHex)) {
    console.log(
      `\n*** Serial number ${serialHex} found in decoded stream! ***`,
    );
  } else {
    console.log(`\nSerial ${serialHex} not found. Trying reversed...`);
    const revHex = serialBytes
      .reverse()
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ");
    if (allHex.includes(revHex)) {
      console.log(`*** Serial number found REVERSED: ${revHex} ***`);
    } else {
      console.log(`Not found reversed either.`);
    }
  }
}

main().catch(console.error);
