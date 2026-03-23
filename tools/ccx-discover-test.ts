#!/usr/bin/env bun
/**
 * Interactive command sender to Nucleo via UDP.
 * Sends commands from argv or stdin, prints responses.
 *
 * Usage:
 *   bun run tools/ccx-discover-test.ts "cmd1" "cmd2" ...
 *   echo "status" | bun run tools/ccx-discover-test.ts
 */

import { createSocket } from "dgram";
import * as readline from "readline";

const NUCLEO_HOST = "10.0.0.3";
const UDP_PORT = 9433;
const CMD_TEXT = 0x20;
const CMD_KEEPALIVE = 0x00;

function buildCmd(cmd: number, data?: Uint8Array): Buffer {
  const d = data ?? new Uint8Array(0);
  const frame = Buffer.alloc(2 + d.length);
  frame[0] = cmd;
  frame[1] = d.length;
  frame.set(d, 2);
  return frame;
}

const sock = createSocket("udp4");

sock.on("message", (msg: Buffer) => {
  if (msg.length < 2) return;
  const flags = msg[0];
  const len = msg[1];

  // Heartbeat
  if (flags === 0xff && len === 0x00) return;

  // Text response
  if (flags === 0xfd) {
    const text = msg.subarray(1).toString("utf-8");
    if (text.length > 0) process.stdout.write(text);
    return;
  }

  // CCX packet or other
  if (flags & 0x40) {
    // CCX packet — skip for now
    return;
  }
});

function sendText(cmd: string) {
  const textBytes = new TextEncoder().encode(cmd);
  sock.send(buildCmd(CMD_TEXT, textBytes), UDP_PORT, NUCLEO_HOST);
}

// Keepalive every 10s
const keepalive = setInterval(() => {
  sock.send(buildCmd(CMD_KEEPALIVE), UDP_PORT, NUCLEO_HOST);
}, 10000);

sock.bind(() => {
  // Register with keepalive
  sock.send(buildCmd(CMD_KEEPALIVE), UDP_PORT, NUCLEO_HOST);

  const args = process.argv.slice(2);
  if (args.length > 0) {
    // Batch mode: send commands with delays, then exit
    let delay = 500;
    for (const cmd of args) {
      setTimeout(() => {
        console.log(`\n>>> ${cmd}`);
        sendText(cmd);
      }, delay);
      delay += 6000; // 6s between commands (enough for spinel timeouts)
    }
    setTimeout(() => {
      clearInterval(keepalive);
      sock.close();
      process.exit(0);
    }, delay + 3000);
  } else {
    // Interactive mode
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.setPrompt("nucleo> ");
    rl.prompt();
    rl.on("line", (line: string) => {
      const cmd = line.trim();
      if (cmd === "quit" || cmd === "exit") {
        clearInterval(keepalive);
        sock.close();
        process.exit(0);
      }
      if (cmd.length > 0) sendText(cmd);
      setTimeout(() => rl.prompt(), 500);
    });
    rl.on("close", () => {
      clearInterval(keepalive);
      sock.close();
      process.exit(0);
    });
  }
});
