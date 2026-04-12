#!/usr/bin/env node --import tsx

/**
 * nucleo-cmd — send shell commands to Nucleo and print responses.
 *
 * Usage:
 *   npx tsx tools/nucleo-cmd.ts "ccx peers"
 *   npx tsx tools/nucleo-cmd.ts --wait 5 "ccx log on" "ccx coap get serial:72200096 cg/nt/able"
 *   echo "ccx peers" | npx tsx tools/nucleo-cmd.ts --stdin
 *
 * Options:
 *   --wait <seconds>   Wait time for responses after last command (default: 3)
 *   --host <ip>        OpenBridge IP (default: openBridge from config.json)
 *   --stdin            Read commands from stdin (one per line)
 *   --raw              Also print non-text packets as hex
 */

import { createSocket } from "dgram";

const args = process.argv.slice(2);
const getArg = (name: string) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};
const hasFlag = (name: string) => args.includes(name);

import { config } from "../lib/config";
const host = getArg("--host") ?? config.openBridge;
const waitSec = Number(getArg("--wait") ?? "3");
const printRaw = hasFlag("--raw");
const useStdin = hasFlag("--stdin");

const PORT = 9433;
const CMD_TEXT = 0x20;
const CMD_KEEPALIVE = 0x00;
const RESP_TEXT = 0xfd;

const sock = createSocket("udp4");

function send(cmd: number, data?: Buffer) {
  const d = data ?? Buffer.alloc(0);
  const frame = Buffer.alloc(2 + d.length);
  frame[0] = cmd;
  frame[1] = d.length;
  d.copy(frame, 2);
  sock.send(frame, 0, frame.length, PORT, host);
}

function sendText(text: string) {
  send(CMD_TEXT, Buffer.from(text, "utf-8"));
}

// Collect commands from argv (skip flags)
const FLAG_WITH_VALUE = new Set(["--wait", "--host"]);
const commands: string[] = [];
for (let i = 0; i < args.length; ) {
  const a = args[i];
  if (FLAG_WITH_VALUE.has(a)) {
    i += 2;
    continue;
  }
  if (a.startsWith("--")) {
    i++;
    continue;
  }
  commands.push(a);
  i++;
}

let exitTimer: ReturnType<typeof setTimeout> | null = null;

function resetExit() {
  if (exitTimer) clearTimeout(exitTimer);
  exitTimer = setTimeout(() => {
    sock.close();
    process.exit(0);
  }, waitSec * 1000);
}

sock.on("message", (msg: Buffer) => {
  if (msg.length < 1) return;
  const flags = msg[0];

  if (flags === RESP_TEXT) {
    const text = msg.subarray(1).toString("utf-8").trim();
    if (text.length > 0) {
      process.stdout.write(text + "\n");
    }
    resetExit();
    return;
  }

  // Heartbeat
  if (flags === 0xff) return;

  // Non-text packet
  if (printRaw) {
    const hex = [...msg].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    process.stdout.write(`[pkt] ${hex}\n`);
    resetExit();
  }
});

sock.on("error", (err) => {
  console.error(`UDP error: ${err.message}`);
  process.exit(1);
});

// Bind to receive responses, then register with a keepalive
sock.bind(0, () => {
  // Send keepalive to register as a stream client
  send(CMD_KEEPALIVE);

  // Small delay to ensure registration, then send commands
  setTimeout(async () => {
    let cmds = commands;

    if (useStdin) {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
      }
      const input = Buffer.concat(chunks).toString("utf-8").trim();
      cmds = input
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    }

    if (cmds.length === 0) {
      console.error(
        "Usage: npx tsx tools/nucleo-cmd.ts [--wait N] [--host IP] <command> [command...]",
      );
      process.exit(1);
    }

    // Send commands with small spacing
    for (let i = 0; i < cmds.length; i++) {
      sendText(cmds[i]);
      if (i < cmds.length - 1) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    resetExit();
  }, 100);
});
