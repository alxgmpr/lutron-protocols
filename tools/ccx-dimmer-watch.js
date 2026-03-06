#!/usr/bin/env node
/**
 * Real-time Thread dimmer level monitor — direct serial, no Python extcap.
 *
 * Reads the nRF 802.15.4 sniffer dongle serial port directly via Node.js,
 * eliminating the Python extcap + multiprocessing + pcap pipeline.
 *
 * Serial protocol: text lines like:
 *   received: <hex_frame_with_fcs> power: <rssi> lqi: <lqi> time: <timestamp>
 * (last 2 bytes of hex are FCS, must be stripped before decryption)
 *
 * Usage: node tools/ccx-dimmer-watch.js [channel]
 */

const { createHmac, createDecipheriv } = require("crypto");
const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");

const MASTER_KEY = Buffer.from("00000000000000000000000000000000", "hex");
const CHANNEL = parseInt(process.argv[2] || "25", 10);
const SERIAL_DEV = "/dev/cu.usbmodem201401";

const SHORT_TO_EUI64 = {};
const entries = [
  [0x6c06, "220efb79b4cef76f"],
  [0x6c00, "ea47c02e16ac97ac"],
  [0x0000, "fa47364552542001"],
  [0x0800, "52c069cf46c49446"],
  [0x1400, "567d3a4b287e1fb1"],
  [0x2c00, "523327e503f00c38"],
  [0x3400, "32a289bd7bfa56fb"],
  [0x5c00, "3a9629dafa091750"],
  [0x6000, "5e710ec4a30442bf"],
  [0x6400, "b2a2c73b39594ab4"],
  [0x7c00, "365253947450f54d"],
  [0x8000, "c281b912ff1eb461"],
  [0x8001, "4287c3545eb00ad6"],
  [0x8800, "fefd123d27773382"],
  [0x9000, "467fc7beeaa19387"],
  [0xa800, "a693dc9268fc755f"],
  [0xa801, "e25e5238a07745de"],
  [0xac00, "36794b5c586e5c58"],
  [0xac01, "5e9b59a37a37f45e"],
  [0xd400, "f2c91ed959d10f43"],
];
for (const [short, hex] of entries) SHORT_TO_EUI64[short] = Buffer.from(hex, "hex");

const MAC_KEYS = {};
for (let seq = 0; seq <= 10; seq++) {
  const data = Buffer.alloc(10);
  data.writeUInt32BE(seq, 0);
  Buffer.from("Thread").copy(data, 4);
  MAC_KEYS[seq] = createHmac("sha256", MASTER_KEY).update(data).digest().subarray(16, 32);
}

function tryDecrypt(wpanFrame) {
  if (wpanFrame.length < 20) return null;
  const fc = wpanFrame.readUInt16LE(0);
  if (!(fc & 0x08)) return null;
  if (((fc >> 10) & 3) !== 2 || ((fc >> 14) & 3) !== 2) return null;

  const dstShort = wpanFrame.readUInt16LE(5);
  const srcShort = wpanFrame.readUInt16LE(7);
  const secLevel = wpanFrame[9] & 0x07;
  if (secLevel !== 5) return null;
  const keyIdMode = (wpanFrame[9] >> 3) & 0x03;
  if (keyIdMode !== 1) return null;

  const frameCounter = wpanFrame.readUInt32LE(10);
  const keyIndex = wpanFrame[14];
  const headerEnd = 15;
  const micLen = 4;
  if (wpanFrame.length <= headerEnd + micLen) return null;

  const eui64 = SHORT_TO_EUI64[srcShort];
  if (!eui64) return null;

  const seq = keyIndex > 0 ? keyIndex - 1 : 0;
  const macKey = MAC_KEYS[seq];
  if (!macKey) return null;

  const nonce = Buffer.alloc(13);
  eui64.copy(nonce, 0);
  nonce.writeUInt32BE(frameCounter, 8);
  nonce[12] = secLevel;

  try {
    const d = createDecipheriv("aes-128-ccm", macKey, nonce, { authTagLength: micLen });
    d.setAuthTag(wpanFrame.subarray(wpanFrame.length - micLen));
    d.setAAD(wpanFrame.subarray(0, headerEnd), {
      plaintextLength: wpanFrame.length - headerEnd - micLen,
    });
    const pt = d.update(wpanFrame.subarray(headerEnd, wpanFrame.length - micLen));
    d.final();
    return { plaintext: pt, srcShort, dstShort };
  } catch {
    return null;
  }
}

function extractLevel(pt) {
  for (let i = 0; i < pt.length - 6; i++) {
    if (pt[i] !== 0x82) continue;

    let msgType = -1;
    let mapStart = -1;

    if (pt[i + 1] === 0x00) {
      msgType = 0;
      mapStart = i + 2;
    } else if (pt[i + 1] === 0x18 && i + 2 < pt.length && pt[i + 2] === 0x1B) {
      msgType = 0x1B;
      mapStart = i + 3;
    } else continue;

    for (let j = mapStart; j < pt.length - 2; j++) {
      if (pt[j] === 0x42) {
        const level16 = pt.readUInt16BE(j + 1);
        if (level16 <= 0xFEFF) {
          return { pct: level16 / 0xFEFF * 100, msgType };
        }
      }
    }
  }
  return null;
}

// --- Direct serial connection ---

const FRAME_RE = /received:\s+([0-9a-fA-F]+)\s+power:\s+(-?\d+)\s+lqi:\s+(\d+)\s+time:\s+(-?\d+)/;

console.log(`Live Thread dimmer monitor — channel ${CHANNEL}`);
console.log(`Direct serial: ${SERIAL_DEV} (no Python extcap)`);
console.log("Waiting for level changes...\n");

// Phase 1: Open port, send init commands, close.
// (Matches the Python extcap behavior — init and capture are separate opens)
const initPort = new SerialPort({
  path: SERIAL_DEV,
  baudRate: 9600,  // USB CDC ignores baud rate, but must provide one
  autoOpen: false,
});

initPort.open((err) => {
  if (err) {
    console.error("Failed to open serial port:", err.message);
    process.exit(1);
  }

  // Send init commands with small delays between them
  const cmds = ["sleep\r\n", "shell echo off\r\n"];
  let idx = 0;

  function sendInit() {
    if (idx < cmds.length) {
      initPort.write(cmds[idx++], () => setTimeout(sendInit, 50));
    } else {
      // Drain any buffered responses, then send channel + receive
      initPort.flush(() => {
        setTimeout(() => {
          initPort.write(`channel ${CHANNEL}\r\n`, () => {
            initPort.write("receive\r\n", () => {
              initPort.flush(() => {
                // Close init port, then reopen for capture
                initPort.close((closeErr) => {
                  if (closeErr) console.error("Close error:", closeErr.message);
                  setTimeout(startCapture, 200);
                });
              });
            });
          });
        }, 100);
      });
    }
  }

  sendInit();
});

function startCapture() {
  const port = new SerialPort({
    path: SERIAL_DEV,
    baudRate: 9600,
    autoOpen: false,
  });

  const parser = port.pipe(new ReadlineParser({ delimiter: "\r\n" }));

  port.open((err) => {
    if (err) {
      console.error("Failed to reopen serial port for capture:", err.message);
      process.exit(1);
    }
    console.log("Capturing...\n");
  });

  parser.on("data", (line) => {
    const m = line.match(FRAME_RE);
    if (!m) return;

    const frameHex = m[1];
    // Strip last 4 hex chars (2-byte FCS) — same as Python: a2b_hex(m.group(1)[:-4])
    const wpanFrame = Buffer.from(frameHex.slice(0, -4), "hex");

    const decrypted = tryDecrypt(wpanFrame);
    if (!decrypted) return;

    const result = extractLevel(decrypted.plaintext);
    if (!result) return;

    const { pct, msgType } = result;
    const time = new Date().toISOString().slice(11, 23);
    const src = decrypted.srcShort;
    const isDimmer = src === 0x6c06;
    const srcLabel = isDimmer ? "DIMMER" : `0x${src.toString(16).padStart(4, "0")}`;
    const typeLabel = msgType === 0 ? "LEVEL" : "REPORT";
    const filled = Math.round(pct / 2);
    const bar = "\x1b[33m" + "█".repeat(filled) + "\x1b[90m" + "░".repeat(50 - filled) + "\x1b[0m";
    const srcColor = isDimmer ? "\x1b[1;33m" : "\x1b[36m";
    console.log(`${time}  ${srcColor}${srcLabel}\x1b[0m  ${typeLabel}  ${bar}  ${pct.toFixed(1)}%`);
  });

  port.on("error", (err) => {
    console.error("Serial error:", err.message);
    process.exit(1);
  });

  process.on("SIGINT", () => {
    port.write("sleep\r\n", () => {
      port.close(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 500);
  });
}
