#!/usr/bin/env -S npx tsx

/**
 * CCX Sniffer - tshark-based capture and decode pipeline
 *
 * Bridges tshark's Thread/802.15.4 decryption with our CCX CBOR decoder.
 *
 * Usage:
 *   npx tsx tools/ccx-sniffer.ts --file capture.pcapng
 *   npx tsx tools/ccx-sniffer.ts --live [--channel 25] [--duration 60]
 *   npx tsx tools/ccx-sniffer.ts --file capture.pcapng --json
 *   npx tsx tools/ccx-sniffer.ts --live --relay
 *   npx tsx tools/ccx-sniffer.ts --file capture.pcapng --decrypt
 *
 * Options:
 *   --file <path>       Process a pcapng capture file
 *   --live              Live capture from nRF 802.15.4 sniffer
 *   --channel <n>       802.15.4 channel (default: from config)
 *   --duration <secs>   Stop live capture after N seconds
 *   --key <hex>         Thread master key (default: from config)
 *   --json              Output JSON (one object per line)
 *   --relay             Forward decoded packets to backend via UDP
 *   --decrypt           Native decrypt MAC-encrypted frames tshark can't handle
 *   --iface <name>      nRF sniffer interface name for tshark (auto-detected)
 */

import { Decoder } from "cbor-x";
import { execSync, spawn } from "child_process";
import { createSocket } from "dgram";
import { existsSync } from "fs";
import {
  CCX_CONFIG,
  getAllDevices,
  getDeviceName,
  getPresetInfo,
  getSceneName,
  getZoneName,
} from "../ccx/config";
import {
  buildPacket,
  formatMessage,
  formatRawBody,
  getMessageTypeName,
} from "../ccx/decoder";
import type { CCXPacket } from "../ccx/types";
import { formatAddr, parseFrame } from "../lib/ieee802154";
import { decryptMacFrame, deriveThreadKeys } from "../lib/thread-crypto";

// Parse CLI arguments
const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : undefined;
}
function hasFlag(name: string): boolean {
  return args.includes(name);
}

const fileMode = getArg("--file");
const liveMode = hasFlag("--live");
const channel = getArg("--channel") ?? String(CCX_CONFIG.channel);
const duration = getArg("--duration");
const masterKey = getArg("--key") ?? CCX_CONFIG.masterKey;
const jsonOutput = hasFlag("--json");
const relayMode = hasFlag("--relay");
const decryptMode = hasFlag("--decrypt");
const verboseMode = hasFlag("--verbose") || hasFlag("-v");
const coapMode = hasFlag("--coap");
const ifaceName = getArg("--iface");

if (!fileMode && !liveMode) {
  console.log(`
CCX Sniffer - tshark-based Thread/802.15.4 capture & decode

Usage:
  npx tsx tools/ccx-sniffer.ts --file <capture.pcapng>   Process a capture file
  npx tsx tools/ccx-sniffer.ts --live                     Live capture from nRF sniffer

Options:
  --channel <n>       802.15.4 channel (default: ${CCX_CONFIG.channel})
  --duration <secs>   Stop live capture after N seconds
  --key <hex>         Thread master key (default: from config)
  --json              Output JSON (one object per line)
  --relay             Forward decoded packets to backend UDP
  --decrypt           Native decrypt MAC-encrypted frames (--file only)
  --verbose / -v      Show raw CBOR body + unknown keys alongside decoded text
  --coap              Also capture CoAP programming traffic (port 5683)
  --iface <name>      tshark interface name (auto-detected from nRF sniffer)

Requirements:
  - tshark (Wireshark CLI) must be installed
  - For live capture: nRF 802.15.4 sniffer extcap plugin installed in Wireshark
  - Thread master key must be configured (config or --key flag)
`);
  process.exit(0);
}

/** Relay socket for forwarding to backend */
const relaySocket = relayMode ? createSocket("udp4") : null;
const RELAY_PORT = 9435; // Dedicated CCX relay port

/** Auto-detect nRF sniffer serial device */
function detectSnifferInterface(): string {
  // Check common macOS paths for nRF52840 dongle
  const candidates = [
    "/dev/cu.usbmodem201401",
    "/dev/cu.usbmodem0004401800001",
  ];
  for (const path of candidates) {
    try {
      if (existsSync(path)) return path;
    } catch {
      /* skip */
    }
  }
  return "/dev/cu.usbmodem201401";
}

/** Build tshark command arguments */
function buildTsharkArgs(): string[] {
  const tsharkArgs: string[] = [];

  if (fileMode) {
    tsharkArgs.push("-r", fileMode);
  } else {
    // Live capture — interface is the serial device path
    const iface = ifaceName ?? detectSnifferInterface();
    tsharkArgs.push("-i", iface);
    // Pass channel to nRF extcap plugin via preference override
    // The preference key encodes the interface path with underscores
    const prefIface = iface.replace(/\//g, "_").replace(/\./g, "_");
    tsharkArgs.push("-o", `extcap.${prefIface}.channel:${channel}`);
    if (duration) {
      tsharkArgs.push("-a", `duration:${duration}`);
    }
  }

  // Line-buffered output so packets appear in real-time (not buffered until exit)
  tsharkArgs.push("-l");

  if (coapMode) {
    // Capture both CCX control (9190) and CoAP programming (5683)
    tsharkArgs.push("-d", "udp.port==5683,coap");
    tsharkArgs.push(
      "-Y",
      `udp.port == ${CCX_CONFIG.udpPort} || (udp.port == 5683 && coap)`,
    );
  } else {
    // Thread key is read from Wireshark's ieee802154_keys UAT file automatically
    tsharkArgs.push("-Y", `udp.port == ${CCX_CONFIG.udpPort}`);
  }

  // Output fields as tab-separated values
  // When --coap, include udp.dstport to distinguish CCX vs CoAP,
  // plus CoAP-specific fields
  tsharkArgs.push(
    "-T",
    "fields",
    "-e",
    "frame.time_epoch",
    "-e",
    "ipv6.src",
    "-e",
    "ipv6.dst",
    "-e",
    "wpan.src64",
    "-e",
    "wpan.dst64",
    "-e",
    "udp.payload",
  );

  if (coapMode) {
    tsharkArgs.push(
      "-e",
      "udp.dstport",
      "-e",
      "coap.code",
      "-e",
      "coap.opt.uri_path_recon",
      "-e",
      "data",
    );
  }

  tsharkArgs.push("-E", "separator=\t");

  return tsharkArgs;
}

// ── CoAP helpers (for --coap mode) ──────────────────────────────────

const cborDecoder = new Decoder({ mapsAsObjects: false });

function normalizeCbor(x: unknown): unknown {
  if (x instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of x.entries()) out[String(k)] = normalizeCbor(v);
    return out;
  }
  if (Array.isArray(x)) return x.map(normalizeCbor);
  if (x instanceof Uint8Array) return Buffer.from(x).toString("hex");
  return x;
}

function decodeCoapCbor(hex: string): unknown | null {
  const clean = hex.replace(/[:\s]/g, "");
  if (!clean) return null;
  try {
    return normalizeCbor(cborDecoder.decode(Buffer.from(clean, "hex")));
  } catch {
    return null;
  }
}

function coapCodeStr(code: number): string {
  if (code === 1) return "GET";
  if (code === 2) return "POST";
  if (code === 3) return "PUT";
  if (code === 4) return "DELETE";
  if (code > 31)
    return `${code >> 5}.${(code & 0x1f).toString().padStart(2, "0")}`;
  return String(code);
}

function pctStr(v: number): string {
  return `${((v / 65279) * 100).toFixed(1)}%`;
}

function annotateCoapPayload(
  path: string,
  code: number,
  decoded: unknown,
  dst: string,
): string {
  const devName = getDeviceName(dst);
  const target = devName ? ` → ${devName}` : "";

  // DELETE /cg/db
  if (path === "/cg/db" && code === 4) {
    return `DB_CLEAR${target}`;
  }

  // Preset: /cg/db/pr/c/AAI POST
  if (
    path === "/cg/db/pr/c/AAI" &&
    code === 2 &&
    decoded &&
    typeof decoded === "object"
  ) {
    const m = decoded as Record<string, unknown>;
    for (const [keyHex, value] of Object.entries(m)) {
      if (typeof keyHex !== "string" || keyHex.length < 8) continue;
      const presetId = parseInt(keyHex.slice(0, 4), 16);
      if (!Array.isArray(value) || value[0] !== 72) continue;
      const body = value[1] as Record<string, unknown> | undefined;
      const level16 = typeof body?.["0"] === "number" ? body["0"] : undefined;
      const fadeQs = typeof body?.["3"] === "number" ? body["3"] : undefined;
      const info = getPresetInfo(presetId) ?? getSceneName(presetId);
      const name =
        typeof info === "object"
          ? `"${info.name}"`
          : typeof info === "string"
            ? `"${info}"`
            : `preset=${presetId}`;
      const lvl = level16 !== undefined ? ` ${pctStr(level16 as number)}` : "";
      const fade =
        fadeQs !== undefined ? ` fade=${(fadeQs as number) / 4}s` : "";
      return `PRESET ${name}${lvl}${fade}${target}`;
    }
  }

  // Zone membership: /cg/db/mc/c/AAI POST
  if (path === "/cg/db/mc/c/AAI" && code === 2 && Array.isArray(decoded)) {
    for (const item of decoded) {
      if (typeof item !== "string" || item.length < 10) continue;
      const zoneId = parseInt(item.slice(4, 8), 16);
      const zoneName = getZoneName(zoneId);
      return `ZONE_MAP zone=${zoneId}${zoneName ? ` "${zoneName}"` : ""}${target}`;
    }
  }

  // Config tables: /cg/db/ct/c/<bucket> PUT
  if (
    path.startsWith("/cg/db/ct/c/") &&
    code === 3 &&
    Array.isArray(decoded) &&
    decoded.length >= 2
  ) {
    const bucket = path.slice("/cg/db/ct/c/".length);
    const op = decoded[0];
    const body = decoded[1] as Record<string, unknown> | undefined;
    if (typeof op === "number" && body) {
      if (bucket === "AAI" && op === 3) {
        const hi = typeof body["2"] === "number" ? body["2"] : null;
        const lo = typeof body["3"] === "number" ? body["3"] : null;
        const parts: string[] = [];
        if (hi != null) parts.push(`high=${pctStr(hi as number)}`);
        if (lo != null) parts.push(`low=${pctStr(lo as number)}`);
        return `TRIM ${parts.join(", ")}${target}`;
      }
      if (bucket === "AHA" && op === 108) {
        const k4 = body["4"];
        const k5 = body["5"];
        return `STATUS_LED active=${k4 ?? "?"}/255 inactive=${k5 ?? "?"}/255${target}`;
      }
      if (bucket.startsWith("AF") && op === 107) {
        return `LED_LINK ${bucket} button=${body["0"] ?? "?"}${target}`;
      }
      return `CONFIG ${bucket} op=${op}${target}`;
    }
  }

  return target.slice(3) || ""; // strip " → " prefix
}

/** Process a CoAP line from tshark (--coap mode) */
function processCoapLine(
  epochStr: string,
  srcAddr: string,
  dstAddr: string,
  code: number,
  path: string,
  dataHex: string,
): void {
  const epoch = parseFloat(epochStr);
  const time = new Date(epoch * 1000).toISOString().slice(11, 23);
  const src = getDeviceName(srcAddr) ?? srcAddr;
  const codeLabel = coapCodeStr(code);
  const decoded = dataHex ? decodeCoapCbor(dataHex) : null;
  const note = annotateCoapPayload(path, code, decoded, dstAddr);

  let line = `${time} ${"COAP".padEnd(14)} ${src} → ${codeLabel} ${path}`;
  if (note) line += ` [${note}]`;

  if (verboseMode && dataHex) {
    line += `\n${"".padEnd(13)}payload: ${dataHex}`;
    if (decoded != null) {
      line += `\n${"".padEnd(13)}cbor: ${JSON.stringify(decoded)}`;
    }
  }

  if (jsonOutput) {
    console.log(
      JSON.stringify({
        timestamp: new Date(epoch * 1000).toISOString(),
        type: "COAP",
        srcAddr,
        dstAddr,
        code: codeLabel,
        path,
        payload: dataHex || undefined,
        note: note || undefined,
      }),
    );
  } else {
    console.log(line);
  }
}

/** Process a single tshark output line */
function processLine(line: string): CCXPacket | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const fields = trimmed.split("\t");
  if (fields.length < 6) return null;

  const [epochStr, srcAddr, dstAddr, srcEui64, dstEui64, udpPayload] = fields;

  // In --coap mode, extra fields: [6]=udp.dstport, [7]=coap.code, [8]=coap.opt.uri_path_recon, [9]=data
  if (coapMode && fields.length >= 7) {
    const dstPort = parseInt(fields[6] ?? "", 10);
    if (dstPort === 5683) {
      // This is a CoAP packet on port 5683
      const coapCode = parseInt(fields[7] ?? "", 10);
      const coapPath = fields[8] ?? "";
      const coapData = (fields[9] ?? "").replace(/[:\s]/g, "");
      if (coapPath || coapData) {
        processCoapLine(
          epochStr,
          srcAddr ?? "",
          dstAddr ?? "",
          coapCode,
          coapPath,
          coapData,
        );
      }
      return null; // Not a CCXPacket
    }
  }

  // Standard CCX packet on port 9190
  const dataHex = udpPayload;
  if (!dataHex) return null;

  // tshark outputs data.data as colon-separated hex
  const payloadHex = dataHex.replace(/:/g, "");
  if (!payloadHex) return null;

  try {
    const epoch = parseFloat(epochStr);
    const timestamp = new Date(epoch * 1000).toISOString();

    return buildPacket({
      timestamp,
      srcAddr: srcAddr ?? "",
      dstAddr: dstAddr ?? "",
      srcEui64: srcEui64 ?? "",
      dstEui64: dstEui64 ?? "",
      payloadHex,
    });
  } catch (err) {
    if (!jsonOutput) {
      console.error(
        `  [decode error] ${(err as Error).message}: ${payloadHex}`,
      );
    }
    return null;
  }
}

/** Format a packet for human-readable output */
function formatPacket(pkt: CCXPacket): string {
  const time = pkt.timestamp.slice(11, 23); // HH:MM:SS.mmm
  const typeName = getMessageTypeName(pkt.msgType).padEnd(14);
  const src = getDeviceName(pkt.srcAddr) ?? pkt.srcAddr;
  const msgStr = formatMessage(pkt.parsed);

  let line = `${time} ${typeName} ${src} → ${msgStr}`;

  // Verbose mode: show raw CBOR body and unknown keys
  if (verboseMode && pkt.parsed.rawBody) {
    line += `\n${"".padEnd(13)}cbor: ${formatRawBody(pkt.parsed.rawBody)}`;
    if (
      pkt.parsed.unknownKeys &&
      Object.keys(pkt.parsed.unknownKeys).length > 0
    ) {
      line += `\n${"".padEnd(13)}UNKNOWN: ${formatRawBody(pkt.parsed.unknownKeys as Record<number, unknown>)}`;
    }
  }

  return line;
}

/** Relay a packet to the backend */
function relayPacket(pkt: CCXPacket) {
  if (!relaySocket) return;
  const json = JSON.stringify(pkt);
  const buf = Buffer.from(json);
  relaySocket.send(buf, RELAY_PORT, "127.0.0.1", (err) => {
    if (err) console.error("Relay error:", err.message);
  });
}

/** Output a decoded packet via the appropriate channel */
function outputPacket(pkt: CCXPacket): void {
  if (relayMode) {
    relayPacket(pkt);
  } else if (jsonOutput) {
    console.log(JSON.stringify(pkt));
  } else {
    console.log(formatPacket(pkt));
  }
}

// ── Native decrypt post-pass (--file --decrypt) ───────────────────

function runDecryptPass(file: string): number {
  const MASTER_KEY = Buffer.from(masterKey, "hex");
  let decryptedCount = 0;

  // Build short→EUI-64 address table from MLE exchanges
  const addrTable = new Map<number, Buffer>();
  const addrRaw = execSync(
    `tshark -r "${file}" -T fields -e wpan.src16 -e wpan.src64 -Y "wpan.src64" 2>/dev/null`,
  )
    .toString()
    .trim();

  if (addrRaw) {
    for (const line of addrRaw.split("\n")) {
      const [shortHex, eui64Str] = line.split("\t");
      if (!shortHex || !eui64Str?.includes(":")) continue;
      const shortAddr = parseInt(shortHex.replace("0x", ""), 16);
      if (Number.isNaN(shortAddr)) continue;
      const eui64 = Buffer.from(eui64Str.replace(/:/g, ""), "hex");
      if (eui64.length === 8) addrTable.set(shortAddr, eui64);
    }
  }

  // Add device map EUI-64s as brute-force fallback
  for (const dev of getAllDevices()) {
    if (dev.eui64) {
      const eui64 = Buffer.from(dev.eui64.replace(/:/g, ""), "hex");
      if (eui64.length === 8) addrTable.set(-dev.serial, eui64);
    }
  }

  // Get frame numbers of MAC-encrypted frames
  const filter = "wpan.security == 1 and not ipv6 and not mle";
  const fieldsRaw = execSync(
    `tshark -r "${file}" -T fields -e frame.number -e frame.time_epoch -e wpan.src64 -Y "${filter}" 2>/dev/null`,
  )
    .toString()
    .trim();

  if (!fieldsRaw) return 0;

  const metaMap = new Map<number, { epoch: number; srcEui64: string }>();
  for (const line of fieldsRaw.split("\n")) {
    const [numStr, epochStr, srcEui64] = line.split("\t");
    metaMap.set(parseInt(numStr, 10), {
      epoch: parseFloat(epochStr),
      srcEui64: srcEui64 || "",
    });
  }

  const frameNums = [...metaMap.keys()];
  if (frameNums.length === 0) return 0;

  // Get raw hex dumps for these frames
  const frameFilter = frameNums.map((n) => `frame.number == ${n}`).join(" or ");
  const hexRaw = execSync(
    `tshark -r "${file}" -x -Y "${frameFilter}" 2>/dev/null`,
  ).toString();

  const packetBlocks = hexRaw.split(/\n(?=Packet \()/);

  let blockIdx = 0;
  for (const block of packetBlocks) {
    if (!block.trim()) continue;
    if (blockIdx >= frameNums.length) break;

    const frameNum = frameNums[blockIdx];
    blockIdx++;
    const meta = metaMap.get(frameNum);
    if (!meta) continue;

    // Extract "IEEE 802.15.4 Data" hex section
    const dataMatch = block.match(
      /IEEE 802\.15\.4 Data \(\d+ bytes\):\n([\s\S]+?)(?:\n\n|\n$|$)/,
    );
    if (!dataMatch) continue;

    let hexStr = "";
    for (const line of dataMatch[1].split("\n")) {
      if (/^[0-9a-f]{4}\s/.test(line)) {
        hexStr += line.substring(6, 53).trim().replace(/\s+/g, "");
      }
    }
    if (!hexStr) continue;

    const rawBytes = Buffer.from(hexStr, "hex");
    const parsed = parseFrame(rawBytes);
    if (!parsed.securityEnabled) continue;

    const keySeq = parsed.keyIndex > 0 ? parsed.keyIndex - 1 : 0;
    const { macKey } = deriveThreadKeys(MASTER_KEY, keySeq);

    const tryWith = (eui64: Buffer) =>
      decryptMacFrame({
        frame: rawBytes,
        headerEnd: parsed.headerEnd,
        secLevel: parsed.secLevel,
        frameCounter: parsed.frameCounter,
        macKey,
        eui64,
      });

    // Try EUI-64 sources: tshark MLE > address table > brute-force
    let plaintext: Buffer<ArrayBufferLike> | null = null;
    let matchedEui64: Buffer<ArrayBufferLike> = Buffer.alloc(8);

    if (meta.srcEui64.includes(":")) {
      const eui64 = Buffer.from(meta.srcEui64.replace(/:/g, ""), "hex");
      if (eui64.length === 8) {
        plaintext = tryWith(eui64);
        if (plaintext) matchedEui64 = eui64;
      }
    }

    if (!plaintext && parsed.srcAddrMode === 2 && parsed.srcAddr.length === 2) {
      const srcShort = parsed.srcAddr.readUInt16LE(0);
      const eui64 = addrTable.get(srcShort);
      if (eui64) {
        plaintext = tryWith(eui64);
        if (plaintext) matchedEui64 = eui64;
      }
    }

    if (!plaintext) {
      for (const [, eui64] of addrTable) {
        plaintext = tryWith(eui64);
        if (plaintext) {
          matchedEui64 = eui64;
          break;
        }
      }
    }

    if (!plaintext) continue;

    // Scan for CBOR array marker
    for (let i = 0; i < plaintext.length - 2; i++) {
      if (plaintext[i] !== 0x82) continue;
      try {
        const eui64Hex = matchedEui64
          .toString("hex")
          .replace(/(.{2})/g, "$1:")
          .slice(0, -1);
        const pkt = buildPacket({
          timestamp: new Date(meta.epoch * 1000).toISOString(),
          srcAddr: formatAddr(parsed.srcAddr),
          dstAddr: formatAddr(parsed.dstAddr),
          srcEui64: eui64Hex,
          dstEui64: "",
          payloadHex: plaintext.subarray(i).toString("hex"),
        });
        outputPacket(pkt);
        decryptedCount++;
        break;
      } catch {}
    }
  }

  return decryptedCount;
}

/** Main: spawn tshark and process output */
async function main() {
  const tsharkArgs = buildTsharkArgs();

  if (!jsonOutput) {
    console.log(
      `CCX Sniffer - ${fileMode ? `Processing ${fileMode}` : "Live capture"}`,
    );
    console.log(`  Channel: ${channel}`);
    console.log(`  Master key: ${masterKey.slice(0, 8)}...`);
    if (decryptMode) console.log("  Native decrypt: enabled");
    if (verboseMode)
      console.log("  Verbose: enabled (raw CBOR + unknown keys)");
    if (coapMode)
      console.log("  CoAP: enabled (port 9190 + 5683 programming traffic)");
    if (relayMode) console.log(`  Relaying to localhost:${RELAY_PORT}`);
    console.log("");
  }

  const tshark = spawn("tshark", tsharkArgs, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let packetCount = 0;
  let buffer = "";

  tshark.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    // Keep the last incomplete line in the buffer
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const pkt = processLine(line);
      if (!pkt) continue;

      packetCount++;
      outputPacket(pkt);
    }
  });

  tshark.stderr.on("data", (chunk: Buffer) => {
    const msg = chunk.toString().trim();
    // Filter out tshark's informational messages
    if (msg.includes("Capturing on") || msg.includes("packets captured")) {
      if (!jsonOutput) console.error(`  [tshark] ${msg}`);
    } else if (msg) {
      console.error(`  [tshark error] ${msg}`);
    }
  });

  tshark.on("close", (code) => {
    // Process any remaining buffer
    if (buffer.trim()) {
      const pkt = processLine(buffer);
      if (pkt) {
        packetCount++;
        outputPacket(pkt);
      }
    }

    // Run decrypt post-pass for --file --decrypt mode
    let decryptedCount = 0;
    if (decryptMode && fileMode) {
      decryptedCount = runDecryptPass(fileMode);
    }

    if (!jsonOutput && !relayMode) {
      const extra =
        decryptedCount > 0 ? ` + ${decryptedCount} natively decrypted` : "";
      console.log(`\n${packetCount} CCX packets decoded${extra}.`);
    }

    if (relaySocket) relaySocket.close();

    if (code !== 0 && code !== null) {
      console.error(`tshark exited with code ${code}`);
      process.exit(1);
    }
  });

  tshark.on("error", (err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error("Error: tshark not found. Install Wireshark CLI tools.");
      console.error(
        "  macOS: brew install wireshark (or install Wireshark.app)",
      );
    } else {
      console.error("Error spawning tshark:", err.message);
    }
    process.exit(1);
  });

  // Handle Ctrl+C gracefully
  process.on("SIGINT", () => {
    if (!jsonOutput) console.log("\nStopping capture...");
    tshark.kill("SIGINT");
  });
}

main();
