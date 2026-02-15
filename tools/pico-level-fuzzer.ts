#!/usr/bin/env bun
/**
 * Pico set-level byte fuzzer.
 *
 * Sends different byte permutations at positions 17-21 of a pico long-format
 * packet to find the correct encoding for arbitrary level control.
 *
 * Usage: bun run tools/pico-level-fuzzer.ts [device_id] [delay_seconds]
 *   device_id: hex pico ID (default: 08692D70)
 *   delay_seconds: pause between attempts (default: 8)
 */

const API = "http://localhost:5001/api/pico-level-raw";
const device = process.argv[2] || "0x08692D70";
const delaySec = parseInt(process.argv[3] || "8", 10);

// Target: 75% level
// 16-bit encoding: 0xBF3F (level_percent * 0xFEFF / 100)
// 8-bit high byte: 0xBF
// 8-bit simple: 0xC0 (192/255 ≈ 75%)
const LVL16_HI = 0xbf;
const LVL16_LO = 0x3f;
const LVL8 = 0xbf;

// Permutations to try for bytes 17-21
// Each entry: [description, b17, b18, b19, b20, b21]
const permutations: [string, number, number, number, number, number][] = [
  // --- Group 1: Standard 40 02 with different level/fade layouts ---
  ["40 02 level16 fade=1", 0x40, 0x02, LVL16_HI, LVL16_LO, 0x01],
  ["40 02 level16 fade=4(1s)", 0x40, 0x02, LVL16_HI, LVL16_LO, 0x04],
  ["40 02 level16 fade=0", 0x40, 0x02, LVL16_HI, LVL16_LO, 0x00],

  // --- Group 2: Swap level bytes to different positions ---
  ["40 02 00 level8 fade=1", 0x40, 0x02, 0x00, LVL8, 0x01],
  ["40 02 fade=1 level16", 0x40, 0x02, 0x01, LVL16_HI, LVL16_LO],
  ["40 02 fade=4 level16", 0x40, 0x02, 0x04, LVL16_HI, LVL16_LO],
  ["40 02 level8 fade=1 00", 0x40, 0x02, LVL8, 0x01, 0x00],
  ["40 02 level8 00 fade=1", 0x40, 0x02, LVL8, 0x00, 0x01],
  ["40 02 00 level8 00", 0x40, 0x02, 0x00, LVL8, 0x00],

  // --- Group 3: Little-endian level ---
  ["40 02 level16LE fade=1", 0x40, 0x02, LVL16_LO, LVL16_HI, 0x01],

  // --- Group 4: Different subcommands ---
  ["40 00 level8 00 00 (btn-style)", 0x40, 0x00, LVL8, 0x00, 0x00],
  ["40 01 level16 fade=1", 0x40, 0x01, LVL16_HI, LVL16_LO, 0x01],
  ["40 03 level16 fade=1", 0x40, 0x03, LVL16_HI, LVL16_LO, 0x01],
  ["40 04 level16 fade=1", 0x40, 0x04, LVL16_HI, LVL16_LO, 0x01],

  // --- Group 5: Match bridge layout (truncated) ---
  // Bridge: 40 02 level_hi level_lo 00 fade 00 00
  // Pico can fit: 40 02 level_hi level_lo 00 (missing fade)
  ["40 02 level16 00 (bridge trunc)", 0x40, 0x02, LVL16_HI, LVL16_LO, 0x00],

  // --- Group 6: Level as preset byte (like button ON=0x20, OFF=0x00) ---
  ["40 00 BF(preset) 00 00", 0x40, 0x00, 0xbf, 0x00, 0x00],
  ["40 00 4B(75%of0x64) 00 00", 0x40, 0x00, 0x4b, 0x00, 0x00],

  // --- Group 7: Try with different command classes ---
  ["42 02 level16 fade=1 (cls42)", 0x42, 0x02, LVL16_HI, LVL16_LO, 0x01],

  // --- Group 8: ON cmd first then check if level changes ---
  // Just an ON button press for comparison (should turn on to 100%)
  ["40 00 20 00 00 (ON button)", 0x40, 0x00, 0x20, 0x00, 0x00],
  // OFF button for comparison
  ["40 00 00 00 00 (OFF button)", 0x40, 0x00, 0x00, 0x00, 0x00],
];

async function sendRaw(
  desc: string,
  b17: number,
  b18: number,
  b19: number,
  b20: number,
  b21: number,
) {
  const hex = [b17, b18, b19, b20, b21]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
  console.log(`\n>>> [${new Date().toLocaleTimeString()}] ${desc}`);
  console.log(`    Bytes 17-21: ${hex}`);

  const resp = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device, b17, b18, b19, b20, b21 }),
  });

  if (!resp.ok) {
    console.log(`    ERROR: ${resp.status} ${await resp.text()}`);
  } else {
    console.log(`    Sent OK`);
  }
}

async function main() {
  console.log("=".repeat(70));
  console.log("PICO SET-LEVEL BYTE FUZZER");
  console.log(`Device: ${device}`);
  console.log(`Delay between attempts: ${delaySec}s`);
  console.log(`Target level: 75% (0xBF3F / 0xBF)`);
  console.log(`Total permutations: ${permutations.length}`);
  console.log("=".repeat(70));
  console.log(
    "\nWatch the dimmer! Note which attempt number causes a level change.",
  );
  console.log("Press Ctrl+C to stop at any time.\n");

  // First, send an ON command to make sure light is on at 100%
  console.log("--- SETUP: Turning light ON first ---");
  await sendRaw("SETUP: ON button", 0x40, 0x00, 0x20, 0x00, 0x00);
  console.log(`    Waiting ${delaySec}s for light to turn on...`);
  await Bun.sleep(delaySec * 1000);

  for (let i = 0; i < permutations.length; i++) {
    const [desc, ...bytes] = permutations[i];
    await sendRaw(
      `[${i + 1}/${permutations.length}] ${desc}`,
      ...(bytes as [number, number, number, number, number]),
    );
    console.log(`    Waiting ${delaySec}s... (watch for dimmer change)`);
    await Bun.sleep(delaySec * 1000);
  }

  console.log("\n" + "=".repeat(70));
  console.log("FUZZING COMPLETE");
  console.log("=".repeat(70));
}

main().catch(console.error);
