#!/usr/bin/env npx tsx

/**
 * nRF NCP DFU flash wrapper.
 *
 * Usage:
 *   npx tsx tools/nrf-dfu-flash.ts --tmf         # flash the TMF-extension build
 *   npx tsx tools/nrf-dfu-flash.ts --rollback    # reflash the known-good baseline
 *
 * Prompts the user to press the reset button on the Nucleo-soldered nRF52840
 * dongle, detects the new DFU serial port, and runs nrfutil. See
 * docs/superpowers/specs/2026-04-22-ncp-tmf-extension-design.md.
 */

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

export type UsbmodemSnapshot = readonly string[];

const __dir = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dir, "..");

export function chooseArtifact(flags: {
  tmf: boolean;
  rollback: boolean;
}): string {
  if (flags.tmf === flags.rollback) {
    throw new Error("Specify exactly one of --tmf or --rollback");
  }
  const name = flags.tmf ? "ot-ncp-ftd-tmf-dfu.zip" : "ot-ncp-ftd-dfu.zip";
  return join(REPO_ROOT, "firmware", "ncp", name);
}

export function snapshotUsbmodem(): UsbmodemSnapshot {
  try {
    return readdirSync("/dev")
      .filter((n) => n.startsWith("tty.usbmodem"))
      .map((n) => `/dev/${n}`);
  } catch {
    return [];
  }
}

export function detectNewUsbmodem(
  before: UsbmodemSnapshot,
  after: UsbmodemSnapshot,
): string | undefined {
  const beforeSet = new Set(before);
  return after.find((p) => !beforeSet.has(p));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const artifact = chooseArtifact({
    tmf: args.includes("--tmf"),
    rollback: args.includes("--rollback"),
  });

  console.log(`Artifact: ${artifact}`);

  const before = snapshotUsbmodem();
  console.log(`Ports before: ${before.join(", ") || "(none)"}`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question(
    "Press the RESET button on the dongle (LED pulses red in DFU mode), then press ENTER here: ",
  );
  rl.close();

  // Give the kernel a moment to re-enumerate USB.
  await new Promise((r) => setTimeout(r, 1500));

  const after = snapshotUsbmodem();
  console.log(`Ports after:  ${after.join(", ") || "(none)"}`);

  const port = detectNewUsbmodem(before, after);
  if (!port) {
    throw new Error(
      "No new usbmodem port appeared. Dongle may not be in DFU mode — re-press reset and retry.",
    );
  }
  console.log(`Detected DFU port: ${port}`);

  console.log(`Invoking nrfutil...`);
  try {
    execFileSync(
      "nrfutil",
      ["nrf5sdk-tools", "dfu", "usb-serial", "-pkg", artifact, "-p", port],
      { stdio: "inherit" },
    );
  } catch (err) {
    throw new Error(
      `nrfutil DFU failed: ${(err as Error).message}. If this was --tmf, consider running --rollback.`,
    );
  }

  console.log(
    `Done. Dongle should re-enumerate as a normal CDC port within a few seconds.`,
  );
}

// Only run main() when invoked as a script, not when imported by tests.
const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  });
}
