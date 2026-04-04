#!/usr/bin/env npx tsx

/**
 * hex2dec — Convert between hex and decimal serial numbers.
 *
 * Usage:
 *   npx tsx tools/hex2dec.ts 021F93A0        # hex → decimal
 *   npx tsx tools/hex2dec.ts 0x021F93A0      # hex → decimal (with prefix)
 *   npx tsx tools/hex2dec.ts --dec 35623840  # decimal → hex
 *   npx tsx tools/hex2dec.ts 021F93A0 35623840  # verify roundtrip
 */

const args = process.argv.slice(2);

if (args.length === 0) {
  console.log(
    "Usage: npx tsx tools/hex2dec.ts <hex> | --dec <decimal> | <hex> <decimal>",
  );
  process.exit(1);
}

if (args[0] === "--dec") {
  const dec = BigInt(args[1]);
  const hex = dec.toString(16).toUpperCase().padStart(8, "0");
  console.log(`decimal ${dec} = 0x${hex}`);
  process.exit(0);
}

// If two args, verify roundtrip
if (args.length === 2) {
  const hex = args[0].replace(/^0x/i, "").toUpperCase();
  const dec = BigInt(args[1]);
  const fromHex = BigInt("0x" + hex);
  const fromDec = dec;
  if (fromHex === fromDec) {
    console.log(`MATCH: 0x${hex} = ${dec}`);
  } else {
    console.error(`MISMATCH: 0x${hex} = ${fromHex}, but you said ${dec}`);
    console.error(`Correct: 0x${hex} = ${fromHex}`);
    process.exit(1);
  }
  process.exit(0);
}

// Single arg: hex → decimal
const input = args[0].replace(/^0x/i, "");
const val = BigInt("0x" + input);
const hex = input.toUpperCase().padStart(8, "0");
console.log(`0x${hex} = ${val}`);
