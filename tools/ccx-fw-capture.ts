#!/usr/bin/env -S npx tsx

/**
 * CCX Firmware Update Capture Tool
 *
 * Captures ALL Thread traffic during a firmware update to intercept
 * the firmware image being pushed from the processor to a CCX device.
 *
 * Unlike ccx-sniffer.ts (which filters to UDP 9190 only), this captures
 * everything on the Thread PAN and saves a raw pcapng for post-processing.
 *
 * Firmware OTA likely uses:
 *   - CoAP (UDP 5683) for SMP/DFU image transfer
 *   - UDP 9190 for status/control messages during update
 *   - MLE (UDP 19788) for network maintenance
 *
 * Usage:
 *   npx tsx tools/ccx-fw-capture.ts --live
 *   npx tsx tools/ccx-fw-capture.ts --live --duration 900
 *   npx tsx tools/ccx-fw-capture.ts --live --target <eui64>
 *   npx tsx tools/ccx-fw-capture.ts --file <capture.pcapng>
 *   npx tsx tools/ccx-fw-capture.ts --file <capture.pcapng> --extract
 */

import { Decoder } from "cbor-x";
import { execSync, spawn } from "child_process";
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from "fs";
import { CCX_CONFIG } from "../ccx/config";
import { buildPacket, formatMessage, getMessageTypeName } from "../ccx/decoder";

const cborDecoder = new Decoder({ mapsAsObjects: false });

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
const duration = getArg("--duration") ?? "900"; // 15 min default (fw update ~604s)
const targetEui64 = getArg("--target");
const ifaceName = getArg("--iface");
const extractMode = hasFlag("--extract");
const outDir = getArg("--out") ?? "/tmp/ccx-fw-capture";
const channel = getArg("--channel") ?? String(CCX_CONFIG.channel);
const masterKey = getArg("--key") ?? CCX_CONFIG.masterKey;

if (!fileMode && !liveMode) {
  console.log(`
CCX Firmware Update Capture Tool

Captures all Thread traffic during firmware updates to intercept OTA images.
Decodes MCUboot SMP image upload frames (CBOR offset+data chunks) and
reconstructs the firmware image ordered by offset.

Usage:
  npx tsx tools/ccx-fw-capture.ts --live                    Live capture (all traffic)
  npx tsx tools/ccx-fw-capture.ts --live --duration 1200    Capture for 20 minutes
  npx tsx tools/ccx-fw-capture.ts --live --target <eui64>   Filter display to target device
  npx tsx tools/ccx-fw-capture.ts --file <pcapng>           Analyze existing capture
  npx tsx tools/ccx-fw-capture.ts --file <pcapng> --extract Extract firmware via SMP decode

Options:
  --channel <n>       802.15.4 channel (default: ${CCX_CONFIG.channel})
  --duration <secs>   Stop capture after N seconds (default: 900)
  --target <eui64>    Target device EUI-64 (for display filtering)
  --iface <name>      tshark interface (auto-detected)
  --out <dir>         Output directory (default: /tmp/ccx-fw-capture)
  --key <hex>         Thread master key (default: from config)
  --extract           Extract firmware payload from capture file

Requirements:
  - tshark (Wireshark CLI)
  - nRF 802.15.4 sniffer extcap plugin (for live capture)
  - Thread master key configured in Wireshark preferences
`);
  process.exit(0);
}

// Ensure output directory exists
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

/** Per-device traffic stats */
interface DeviceStats {
  eui64: string;
  totalBytes: number;
  packetCount: number;
  coapPackets: number;
  coapBytes: number;
  runtimePackets: number;
  mlePackets: number;
  firstSeen: number;
  lastSeen: number;
  coapPaths: Map<string, number>;
  largestPayload: number;
}

const deviceStats = new Map<string, DeviceStats>();

function getOrCreateStats(eui64: string): DeviceStats {
  let stats = deviceStats.get(eui64);
  if (!stats) {
    stats = {
      eui64,
      totalBytes: 0,
      packetCount: 0,
      coapPackets: 0,
      coapBytes: 0,
      runtimePackets: 0,
      mlePackets: 0,
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      coapPaths: new Map(),
      largestPayload: 0,
    };
    deviceStats.set(eui64, stats);
  }
  return stats;
}

// ── SMP/MCUboot Frame Decoder ────────────────────────────────

/** Parsed SMP image upload chunk */
interface SmpChunk {
  offset: number;
  data: Buffer;
  totalSize?: number; // present in first chunk (len field)
}

/**
 * Try to decode an SMP image upload frame from a CoAP payload.
 *
 * MCUboot SMP over CoAP: the CoAP payload is either:
 *   1. Raw CBOR map: {0: offset, 1: data, 2?: totalLen} (integer keys)
 *      or {"off": offset, "data": data, "len"?: totalLen} (string keys)
 *   2. SMP header (8 bytes) + CBOR map (raw SMP framing)
 *
 * Returns null if the payload is not an SMP upload frame.
 */
function decodeSmpChunk(payload: Buffer): SmpChunk | null {
  // Try raw CBOR first, then with 8-byte SMP header skip
  for (const skip of [0, 8]) {
    if (payload.length <= skip) continue;
    const buf = skip > 0 ? payload.subarray(skip) : payload;
    try {
      const decoded = cborDecoder.decode(buf);
      if (!(decoded instanceof Map)) continue;

      // Extract offset — integer key 0 or string key "off"
      const offset = decoded.get(0) ?? decoded.get("off");
      if (typeof offset !== "number") continue;

      // Extract data — integer key 1 or string key "data"
      let data = decoded.get(1) ?? decoded.get("data");
      if (!data) continue;
      if (data instanceof Uint8Array) data = Buffer.from(data);
      if (!Buffer.isBuffer(data)) continue;

      // Extract optional total size — integer key 2 or string key "len"
      const totalSize = decoded.get(2) ?? decoded.get("len");

      return {
        offset,
        data,
        totalSize: typeof totalSize === "number" ? totalSize : undefined,
      };
    } catch {
      // Not valid CBOR at this offset
    }
  }
  return null;
}

// ── Live Firmware Transfer Tracking ──────────────────────────

interface FirmwareTransfer {
  targetEui64: string;
  totalSize: number | undefined;
  bytesReceived: number;
  chunkCount: number;
  highestOffset: number;
  startTime: number;
  lastProgressTime: number;
  phase: "programming" | "uploading" | "unknown";
  programmingPaths: Set<string>;
}

const activeTransfers = new Map<string, FirmwareTransfer>();

function getOrCreateTransfer(eui64: string): FirmwareTransfer {
  let transfer = activeTransfers.get(eui64);
  if (!transfer) {
    transfer = {
      targetEui64: eui64,
      totalSize: undefined,
      bytesReceived: 0,
      chunkCount: 0,
      highestOffset: 0,
      startTime: Date.now(),
      lastProgressTime: 0,
      phase: "unknown",
      programmingPaths: new Set(),
    };
    activeTransfers.set(eui64, transfer);
  }
  return transfer;
}

function printTransferProgress(transfer: FirmwareTransfer) {
  const elapsed = (Date.now() - transfer.startTime) / 1000;
  const speed = transfer.bytesReceived / elapsed;
  const pct = transfer.totalSize
    ? ((transfer.bytesReceived / transfer.totalSize) * 100).toFixed(1)
    : "?";
  const eta = transfer.totalSize
    ? ((transfer.totalSize - transfer.bytesReceived) / speed).toFixed(0)
    : "?";

  console.log(
    `  [FW] ${transfer.targetEui64.slice(-5)}: ${formatBytes(transfer.bytesReceived)}` +
      (transfer.totalSize ? `/${formatBytes(transfer.totalSize)}` : "") +
      ` (${pct}%) ${transfer.chunkCount} chunks` +
      ` ${formatBytes(speed)}/s ETA ${eta}s`,
  );
}

/** Auto-detect nRF sniffer interface */
function detectSnifferInterface(): string {
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

/** Format bytes as human-readable */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Print live stats summary */
function printStats() {
  if (deviceStats.size === 0) return;

  console.log("\n--- Device Traffic Summary ---");
  const sorted = [...deviceStats.values()].sort(
    (a, b) => b.totalBytes - a.totalBytes,
  );
  for (const s of sorted) {
    const dur = ((s.lastSeen - s.firstSeen) / 1000).toFixed(0);
    const eui =
      targetEui64 && s.eui64.includes(targetEui64)
        ? `${s.eui64} [TARGET]`
        : s.eui64;
    console.log(`  ${eui}`);
    console.log(
      `    Total: ${formatBytes(s.totalBytes)} in ${s.packetCount} pkts (${dur}s)`,
    );
    if (s.coapPackets > 0) {
      console.log(
        `    CoAP:  ${formatBytes(s.coapBytes)} in ${s.coapPackets} pkts (largest: ${formatBytes(s.largestPayload)})`,
      );
      for (const [path, count] of s.coapPaths) {
        console.log(`      ${path}: ${count} pkts`);
      }
    }
    if (s.runtimePackets > 0)
      console.log(`    Runtime (9190): ${s.runtimePackets} pkts`);
    if (s.mlePackets > 0) console.log(`    MLE (19788): ${s.mlePackets} pkts`);
  }
  console.log("---\n");
}

// ── Live Capture Mode ──────────────────────────────────────

async function runLiveCapture() {
  const iface = ifaceName ?? detectSnifferInterface();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const pcapFile = `${outDir}/ccx-fw-${timestamp}.pcapng`;

  console.log("CCX Firmware Update Capture");
  console.log("==========================");
  console.log(`  Interface: ${iface}`);
  console.log(`  Channel:   ${channel}`);
  console.log(`  Master key: ${masterKey.slice(0, 8)}...`);
  console.log(`  Duration:  ${duration}s`);
  console.log(`  Saving to: ${pcapFile}`);
  if (targetEui64) console.log(`  Target:    ${targetEui64}`);
  console.log();
  console.log("Trigger the firmware update now. Press Ctrl+C to stop.\n");

  // Architecture: single tshark captures raw pcapng to stdout. We pipe it to
  // both a file (for post-processing) and a decoder tshark (for live display).
  // This avoids opening the nRF sniffer interface twice (exclusive serial lock).

  // Decoder tshark reads pcapng from stdin — spawn first so it's ready
  const decoder = spawn(
    "tshark",
    [
      "-r",
      "-",
      "-l",
      // Decode CoAP on port 5683
      "-d",
      "udp.port==5683,coap",
      // Show all fields we care about
      "-T",
      "fields",
      "-e",
      "frame.time_epoch",
      "-e",
      "frame.len",
      "-e",
      "wpan.src64",
      "-e",
      "wpan.dst64",
      "-e",
      "ipv6.src",
      "-e",
      "ipv6.dst",
      "-e",
      "udp.srcport",
      "-e",
      "udp.dstport",
      "-e",
      "udp.payload",
      "-e",
      "coap.code",
      "-e",
      "coap.opt.uri_path_recon",
      "-e",
      "data.data",
      "-E",
      "separator=\t",
      // Only decode UDP packets
      "-Y",
      "udp",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );

  // Capture tshark writes raw pcapng to stdout
  const capture = spawn(
    "tshark",
    ["-i", iface, "-w", "-", "-l", "-a", `duration:${duration}`],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  // Tee capture stdout to both the pcapng file and the decoder stdin
  const fileStream = createWriteStream(pcapFile);
  capture.stdout.on("data", (chunk: Buffer) => {
    fileStream.write(chunk);
    if (decoder.stdin && !decoder.stdin.destroyed) {
      decoder.stdin.write(chunk);
    }
  });

  capture.stderr.on("data", (chunk: Buffer) => {
    const msg = chunk.toString().trim();
    if (msg.includes("Capturing on") || msg.includes("packets captured")) {
      console.log(`  [tshark] ${msg}`);
    }
  });

  let packetCount = 0;
  let decoderBuffer = "";

  decoder.stdout.on("data", (chunk: Buffer) => {
    decoderBuffer += chunk.toString();
    const lines = decoderBuffer.split("\n");
    decoderBuffer = lines.pop() ?? "";

    for (const line of lines) {
      processLiveLine(line);
      packetCount++;
    }
  });

  decoder.stderr.on("data", (chunk: Buffer) => {
    const msg = chunk.toString().trim();
    if (
      !msg.includes("Capturing on") &&
      !msg.includes("packets captured") &&
      msg
    ) {
      console.error(`  [decode] ${msg}`);
    }
  });

  // Print stats periodically
  const statsInterval = setInterval(() => {
    if (deviceStats.size > 0) printStats();
  }, 30000);

  // Graceful shutdown
  function shutdown() {
    console.log("\nStopping capture...");
    clearInterval(statsInterval);
    capture.kill("SIGINT");
  }

  process.on("SIGINT", shutdown);

  capture.on("close", () => {
    clearInterval(statsInterval);
    fileStream.end();
    if (decoder.stdin && !decoder.stdin.destroyed) {
      decoder.stdin.end();
    }
    console.log(`\nCapture saved to: ${pcapFile}`);
    console.log(`Total packets with UDP: ${packetCount}`);
    printStats();

    // Print firmware transfer summary
    if (activeTransfers.size > 0) {
      console.log("--- Firmware Transfer Summary ---");
      for (const transfer of activeTransfers.values()) {
        console.log(`  ${transfer.targetEui64}:`);
        console.log(`    Phase: ${transfer.phase}`);
        if (transfer.programmingPaths.size > 0) {
          console.log(
            `    Programming paths: ${[...transfer.programmingPaths].join(", ")}`,
          );
        }
        if (transfer.chunkCount > 0) {
          printTransferProgress(transfer);
        }
      }
      console.log("---\n");
    }
    console.log(`\nPost-process with:`);
    console.log(`  npx tsx tools/ccx-fw-capture.ts --file ${pcapFile}`);
    console.log(
      `  npx tsx tools/ccx-fw-capture.ts --file ${pcapFile} --extract`,
    );
  });
}

/** Process a single line from the live decode tshark */
function processLiveLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed) return;

  const fields = trimmed.split("\t");
  if (fields.length < 8) return;

  const [
    epochStr,
    frameLenStr,
    srcEui64,
    dstEui64,
    srcIpv6,
    dstIpv6,
    srcPortStr,
    dstPortStr,
    udpPayload,
    coapCode,
    coapPath,
    dataPayload,
  ] = fields;

  const epoch = parseFloat(epochStr);
  const frameLen = parseInt(frameLenStr, 10);
  const srcPort = parseInt(srcPortStr, 10);
  const dstPort = parseInt(dstPortStr, 10);
  const time = new Date(epoch * 1000).toISOString().slice(11, 23);
  const payloadHex = (udpPayload || dataPayload || "").replace(/:/g, "");
  const payloadBytes = payloadHex.length / 2;

  // Track stats for both src and dst
  for (const eui of [srcEui64, dstEui64]) {
    if (!eui) continue;
    const stats = getOrCreateStats(eui);
    stats.packetCount++;
    stats.totalBytes += frameLen;
    stats.lastSeen = Date.now();

    if (dstPort === 5683 || srcPort === 5683) {
      stats.coapPackets++;
      stats.coapBytes += payloadBytes;
      if (payloadBytes > stats.largestPayload)
        stats.largestPayload = payloadBytes;
      if (coapPath) {
        stats.coapPaths.set(coapPath, (stats.coapPaths.get(coapPath) ?? 0) + 1);
      }
    } else if (dstPort === 9190 || srcPort === 9190) {
      stats.runtimePackets++;
    } else if (dstPort === 19788 || srcPort === 19788) {
      stats.mlePackets++;
    }
  }

  // Display logic: show interesting packets
  const srcLabel = srcEui64 ? srcEui64.slice(-5) : (srcIpv6?.slice(-8) ?? "?");
  const dstLabel = dstEui64 ? dstEui64.slice(-5) : (dstIpv6?.slice(-8) ?? "?");

  if (dstPort === 5683 || srcPort === 5683) {
    // CoAP traffic — detect programming vs firmware upload
    const method = coapCode ?? "?";
    const path = coapPath ?? "";
    const sizeStr = payloadBytes > 0 ? ` (${formatBytes(payloadBytes)})` : "";

    // Try SMP decode on CoAP payloads
    let smpInfo = "";
    if (payloadHex && payloadBytes > 8) {
      const chunk = decodeSmpChunk(Buffer.from(payloadHex, "hex"));
      if (chunk) {
        const dstEui = dstEui64 || srcEui64 || "unknown";
        const transfer = getOrCreateTransfer(dstEui);
        transfer.phase = "uploading";
        transfer.chunkCount++;
        transfer.bytesReceived += chunk.data.length;
        if (chunk.offset + chunk.data.length > transfer.highestOffset) {
          transfer.highestOffset = chunk.offset + chunk.data.length;
        }
        if (chunk.totalSize !== undefined && !transfer.totalSize) {
          transfer.totalSize = chunk.totalSize;
          console.log(
            `  [FW] Upload started to ${dstEui.slice(-5)} — total image size: ${formatBytes(chunk.totalSize)}`,
          );
        }
        smpInfo = ` SMP[off=${chunk.offset} +${chunk.data.length}B]`;

        // Show progress every 5 seconds
        const now = Date.now();
        if (now - transfer.lastProgressTime > 5000) {
          transfer.lastProgressTime = now;
          printTransferProgress(transfer);
        }
      }
    }

    // Detect programming phase — CoAP to /cg/db paths
    let phaseMarker = "";
    if (path.startsWith("/cg/db")) {
      phaseMarker = " [PROGRAM]";
      const dstEui = dstEui64 || "unknown";
      const transfer = getOrCreateTransfer(dstEui);
      if (transfer.phase === "unknown") transfer.phase = "programming";
      transfer.programmingPaths.add(path);
    } else if (payloadBytes > 200 && !smpInfo) {
      phaseMarker = " **FW?**";
    }

    console.log(
      `${time} CoAP  ${srcLabel}→${dstLabel}  ${method} ${path}${sizeStr}${smpInfo}${phaseMarker}`,
    );
  } else if (dstPort === 9190 || srcPort === 9190) {
    // Runtime CCX — try to decode CBOR
    if (payloadHex) {
      try {
        const pkt = buildPacket({
          timestamp: new Date(epoch * 1000).toISOString(),
          srcAddr: srcIpv6 ?? "",
          dstAddr: dstIpv6 ?? "",
          srcEui64: srcEui64 ?? "",
          dstEui64: dstEui64 ?? "",
          payloadHex,
        });
        const typeName = getMessageTypeName(pkt.msgType).padEnd(14);
        console.log(
          `${time} 9190  ${srcLabel}→${dstLabel}  ${typeName} ${formatMessage(pkt.parsed)}`,
        );
      } catch {
        console.log(
          `${time} 9190  ${srcLabel}→${dstLabel}  raw=${payloadHex.slice(0, 40)}...`,
        );
      }
    }
  } else {
    // Other UDP (MLE, etc.) — show briefly
    if (dstPort === 19788 || srcPort === 19788) return; // skip MLE noise
    console.log(
      `${time} UDP:${dstPort} ${srcLabel}→${dstLabel} ${formatBytes(payloadBytes)}`,
    );
  }
}

// ── File Analysis Mode ─────────────────────────────────────

async function analyzeFile(pcapFile: string) {
  console.log(`CCX Firmware Capture Analysis: ${pcapFile}\n`);

  // Get basic capture stats
  const capinfo = execSync(
    `tshark -r "${pcapFile}" -q -z io,stat,0 2>/dev/null || true`,
  ).toString();
  console.log("Capture overview:");
  console.log(capinfo);

  // Port distribution
  console.log("UDP port distribution:");
  const ports = execSync(
    `tshark -r "${pcapFile}" -Y udp -T fields -e udp.dstport 2>/dev/null | sort | uniq -c | sort -nr | head -20`,
  )
    .toString()
    .trim();
  console.log(ports);
  console.log();

  // CoAP traffic breakdown
  console.log("CoAP traffic (port 5683):");
  try {
    const coap = execSync(
      `tshark -r "${pcapFile}" -d udp.port==5683,coap -Y "udp.port==5683 && coap.code" -T fields -e coap.code -e coap.opt.uri_path_recon 2>/dev/null | sort | uniq -c | sort -nr | head -30`,
    )
      .toString()
      .trim();
    console.log(coap || "  (no CoAP traffic found)");
  } catch {
    console.log("  (CoAP decode failed — may need manual port decode)");
  }
  console.log();

  // Per-device byte counts (useful to find the update target)
  console.log("Traffic by destination EUI-64:");
  const dstEuis = execSync(
    `tshark -r "${pcapFile}" -Y udp -T fields -e wpan.dst64 -e frame.len 2>/dev/null`,
  )
    .toString()
    .trim();

  const euiBytes = new Map<string, { bytes: number; pkts: number }>();
  for (const line of dstEuis.split("\n")) {
    const [eui, lenStr] = line.split("\t");
    if (!eui) continue;
    const entry = euiBytes.get(eui) ?? { bytes: 0, pkts: 0 };
    entry.bytes += parseInt(lenStr, 10) || 0;
    entry.pkts++;
    euiBytes.set(eui, entry);
  }

  const sortedEuis = [...euiBytes.entries()].sort(
    (a, b) => b[1].bytes - a[1].bytes,
  );
  for (const [eui, { bytes, pkts }] of sortedEuis.slice(0, 15)) {
    console.log(`  ${eui}: ${formatBytes(bytes)} in ${pkts} pkts`);
  }
  console.log();

  // Look for large CoAP payloads (firmware chunks)
  console.log("Largest CoAP payloads (potential firmware chunks):");
  try {
    const largeCoap = execSync(
      `tshark -r "${pcapFile}" -d udp.port==5683,coap ` +
        `-Y "udp.port==5683 && data" ` +
        `-T fields -e frame.time_relative -e wpan.src64 -e wpan.dst64 -e coap.code -e coap.opt.uri_path_recon -e data.len 2>/dev/null ` +
        `| sort -t'\t' -k6 -nr | head -20`,
    )
      .toString()
      .trim();
    console.log(largeCoap || "  (no large CoAP payloads found)");
  } catch {
    console.log("  (analysis failed)");
  }
  console.log();

  // Look for non-CoAP large UDP payloads (SMP might use a custom port)
  console.log("Large UDP payloads on non-standard ports:");
  try {
    const largeUdp = execSync(
      `tshark -r "${pcapFile}" ` +
        `-Y "udp && !udp.port==5683 && !udp.port==9190 && !udp.port==19788 && data" ` +
        `-T fields -e frame.time_relative -e udp.dstport -e wpan.src64 -e wpan.dst64 -e data.len 2>/dev/null ` +
        `| sort -t'\t' -k5 -nr | head -20`,
    )
      .toString()
      .trim();
    console.log(largeUdp || "  (none found — firmware likely on CoAP 5683)");
  } catch {
    console.log("  (analysis failed)");
  }

  if (extractMode) {
    await extractFirmware(pcapFile);
  } else {
    console.log(`\nTo extract firmware data, run:`);
    console.log(
      `  npx tsx tools/ccx-fw-capture.ts --file "${pcapFile}" --extract`,
    );
    if (sortedEuis.length > 0) {
      const topEui = sortedEuis[0][0];
      console.log(
        `  npx tsx tools/ccx-fw-capture.ts --file "${pcapFile}" --extract --target ${topEui}`,
      );
    }
  }
}

/** Extract firmware payload data from a capture file */
async function extractFirmware(pcapFile: string) {
  console.log("\n=== Firmware Extraction ===\n");

  // Determine target device — either specified or the one with most CoAP data
  let target = targetEui64;
  if (!target) {
    console.log(
      "No --target specified, finding device with most CoAP traffic...",
    );
    try {
      const coapDsts = execSync(
        `tshark -r "${pcapFile}" -d udp.port==5683,coap ` +
          `-Y "udp.port==5683 && coap.code==2" ` +
          `-T fields -e wpan.dst64 2>/dev/null`,
      )
        .toString()
        .trim();
      const counts = new Map<string, number>();
      for (const eui of coapDsts.split("\n")) {
        if (eui) counts.set(eui, (counts.get(eui) ?? 0) + 1);
      }
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      if (top) {
        target = top[0];
        console.log(
          `  Auto-selected target: ${target} (${top[1]} CoAP POST packets)\n`,
        );
      }
    } catch {
      /* fallthrough */
    }
  }

  if (!target) {
    console.error(
      "Could not determine target device. Specify with --target <eui64>",
    );
    return;
  }

  // Extract all CoAP payloads to the target device, ordered by time
  console.log(`Extracting CoAP payloads to ${target}...`);

  const filterTarget = target.includes(":")
    ? target
    : target.replace(/(.{2})(?!$)/g, "$1:");

  let rawLines: string;
  try {
    rawLines = execSync(
      `tshark -r "${pcapFile}" -d udp.port==5683,coap ` +
        `-Y "udp.port==5683 && wpan.dst64==${filterTarget}" ` +
        `-T fields -e frame.time_relative -e coap.code -e coap.opt.uri_path_recon -e data.data 2>/dev/null`,
    )
      .toString()
      .trim();
  } catch {
    console.error("Failed to extract CoAP payloads");
    return;
  }

  if (!rawLines) {
    console.log("No CoAP payloads found for target device.");

    // Try extracting raw UDP instead (firmware may not use CoAP)
    console.log("\nTrying raw UDP extraction...");
    try {
      rawLines = execSync(
        `tshark -r "${pcapFile}" ` +
          `-Y "udp && wpan.dst64==${filterTarget} && !udp.port==19788" ` +
          `-T fields -e frame.time_relative -e udp.dstport -e udp.payload 2>/dev/null`,
      )
        .toString()
        .trim();
      if (rawLines) {
        const lines = rawLines.split("\n");
        console.log(`Found ${lines.length} raw UDP packets to target.`);

        // Group by port
        const portGroups = new Map<
          string,
          { count: number; totalBytes: number }
        >();
        for (const line of lines) {
          const [, port, payload] = line.split("\t");
          const payloadClean = (payload ?? "").replace(/:/g, "");
          const entry = portGroups.get(port) ?? { count: 0, totalBytes: 0 };
          entry.count++;
          entry.totalBytes += payloadClean.length / 2;
          portGroups.set(port, entry);
        }

        console.log("\nUDP traffic to target by port:");
        for (const [port, { count, totalBytes }] of [
          ...portGroups.entries(),
        ].sort((a, b) => b[1].totalBytes - a[1].totalBytes)) {
          console.log(
            `  Port ${port}: ${count} pkts, ${formatBytes(totalBytes)}`,
          );
        }
      }
    } catch {
      /* skip */
    }
    return;
  }

  const lines = rawLines.split("\n");
  console.log(`Found ${lines.length} CoAP packets to target device.`);

  // Separate by CoAP path and track payloads
  const pathData = new Map<
    string,
    { payloads: Buffer[]; totalBytes: number }
  >();

  for (const line of lines) {
    const [, code, path, dataHex] = line.split("\t");
    if (!dataHex) continue;

    const cleanHex = dataHex.replace(/:/g, "");
    const buf = Buffer.from(cleanHex, "hex");
    const key = path || `code_${code}`;

    const entry = pathData.get(key) ?? { payloads: [], totalBytes: 0 };
    entry.payloads.push(buf);
    entry.totalBytes += buf.length;
    pathData.set(key, entry);
  }

  // Show programming phase commands (/cg/db paths)
  const programmingPaths = [...pathData.entries()].filter(([p]) =>
    p.startsWith("/cg/db"),
  );
  if (programmingPaths.length > 0) {
    console.log("\n  Programming phase (CoAP /cg/db commands):");
    for (const [path, { payloads, totalBytes }] of programmingPaths) {
      console.log(
        `    ${path}: ${payloads.length} pkts, ${formatBytes(totalBytes)}`,
      );
    }
  }

  console.log("\nPayload summary by CoAP path:");
  for (const [path, { payloads, totalBytes }] of [...pathData.entries()].sort(
    (a, b) => b[1].totalBytes - a[1].totalBytes,
  )) {
    console.log(
      `  ${path}: ${payloads.length} pkts, ${formatBytes(totalBytes)}`,
    );
    if (payloads.length > 0) {
      const first = payloads[0];
      console.log(
        `    First payload (${first.length} bytes): ${first.subarray(0, 32).toString("hex")}${first.length > 32 ? "..." : ""}`,
      );
    }
  }

  // ── SMP/MCUboot Frame Decoding ──────────────────────────────
  //
  // Try to decode all CoAP payloads as SMP image upload frames.
  // Each frame is a CBOR map: {off: <offset>, data: <bytes>, len?: <total>}
  // Reconstruct the firmware image ordered by offset.

  console.log("\n--- SMP Image Upload Decode ---\n");

  const smpChunks: { offset: number; data: Buffer; packetIndex: number }[] = [];
  let smpTotalSize: number | undefined;
  let nonSmpPayloads = 0;

  // Collect all payloads from all paths (firmware upload may use any path)
  const allPayloads: Buffer[] = [];
  for (const [, { payloads }] of [...pathData.entries()].sort(
    (a, b) => b[1].totalBytes - a[1].totalBytes,
  )) {
    allPayloads.push(...payloads);
  }

  for (let i = 0; i < allPayloads.length; i++) {
    const chunk = decodeSmpChunk(allPayloads[i]);
    if (chunk) {
      smpChunks.push({
        offset: chunk.offset,
        data: chunk.data,
        packetIndex: i,
      });
      if (chunk.totalSize !== undefined && smpTotalSize === undefined) {
        smpTotalSize = chunk.totalSize;
      }
    } else {
      nonSmpPayloads++;
    }
  }

  if (smpChunks.length === 0) {
    console.log("No SMP image upload frames found in CoAP payloads.");
    console.log("Falling back to raw concatenation...\n");

    // Fall back to raw concatenation of the largest stream
    const largestPath = [...pathData.entries()].sort(
      (a, b) => b[1].totalBytes - a[1].totalBytes,
    )[0];
    if (largestPath) {
      const [path, { payloads, totalBytes }] = largestPath;
      console.log(`Largest stream: ${path} (${formatBytes(totalBytes)})`);
      const combined = Buffer.concat(payloads);
      const outFile = `${outDir}/fw-extract-${target.replace(/:/g, "")}.bin`;
      writeFileSync(outFile, combined);
      console.log(`  Raw concatenated payloads saved to: ${outFile}`);
      console.log(`  Total size: ${formatBytes(combined.length)}`);
      identifyContent(combined);
    }
    return;
  }

  console.log(`SMP chunks decoded: ${smpChunks.length}`);
  console.log(`Non-SMP payloads: ${nonSmpPayloads}`);
  if (smpTotalSize !== undefined) {
    console.log(
      `Total image size (from SMP len field): ${formatBytes(smpTotalSize)}`,
    );
  }

  // Sort by offset and reconstruct
  smpChunks.sort((a, b) => a.offset - b.offset);

  const imageSize =
    smpTotalSize ??
    smpChunks.reduce((max, c) => Math.max(max, c.offset + c.data.length), 0);
  const image = Buffer.alloc(imageSize);
  const coverage = new Uint8Array(imageSize); // track which bytes are filled

  let overlaps = 0;
  let gapBytes = 0;

  for (const chunk of smpChunks) {
    const end = Math.min(chunk.offset + chunk.data.length, imageSize);
    // Check for overlaps
    for (let j = chunk.offset; j < end; j++) {
      if (coverage[j]) overlaps++;
      coverage[j] = 1;
    }
    chunk.data.copy(image, chunk.offset, 0, end - chunk.offset);
  }

  // Count gaps
  for (let j = 0; j < imageSize; j++) {
    if (!coverage[j]) gapBytes++;
  }

  const firstChunk = smpChunks[0];
  const lastChunk = smpChunks[smpChunks.length - 1];
  console.log(`\nReconstruction summary:`);
  console.log(`  Image size:    ${formatBytes(imageSize)}`);
  console.log(`  Chunks:        ${smpChunks.length}`);
  console.log(
    `  Offset range:  ${firstChunk.offset} — ${lastChunk.offset + lastChunk.data.length}`,
  );
  console.log(
    `  Avg chunk:     ${formatBytes(Math.floor(imageSize / smpChunks.length))}`,
  );
  if (overlaps > 0) {
    console.log(`  Overlaps:      ${formatBytes(overlaps)} (retransmissions)`);
  }
  if (gapBytes > 0) {
    console.log(
      `  GAPS:          ${formatBytes(gapBytes)} — image may be incomplete!`,
    );

    // Find gap ranges
    let inGap = false;
    let gapStart = 0;
    const gaps: { start: number; end: number }[] = [];
    for (let j = 0; j <= imageSize; j++) {
      if (j < imageSize && !coverage[j]) {
        if (!inGap) {
          gapStart = j;
          inGap = true;
        }
      } else if (inGap) {
        gaps.push({ start: gapStart, end: j });
        inGap = false;
      }
    }
    for (const g of gaps.slice(0, 10)) {
      console.log(
        `    Gap: 0x${g.start.toString(16)} — 0x${g.end.toString(16)} (${formatBytes(g.end - g.start)})`,
      );
    }
    if (gaps.length > 10)
      console.log(`    ... and ${gaps.length - 10} more gaps`);
  } else {
    console.log(`  Coverage:      100% — no gaps`);
  }

  // Save the reconstructed firmware image
  const outFile = `${outDir}/fw-smp-${target.replace(/:/g, "")}.bin`;
  writeFileSync(outFile, image);
  console.log(`\n  Reconstructed firmware saved to: ${outFile}`);

  // Identify content
  identifyContent(image);

  // Also save raw concatenated payloads for comparison
  const largestPath = [...pathData.entries()].sort(
    (a, b) => b[1].totalBytes - a[1].totalBytes,
  )[0];
  if (largestPath) {
    const [, { payloads, totalBytes }] = largestPath;
    const rawFile = `${outDir}/fw-raw-${target.replace(/:/g, "")}.bin`;
    writeFileSync(rawFile, Buffer.concat(payloads));
    console.log(
      `  Raw concatenated payloads saved to: ${rawFile} (${formatBytes(totalBytes)})`,
    );
  }
}

/** Try to identify the extracted content */
function identifyContent(data: Buffer) {
  console.log("\n  Content identification:");

  // MCUboot image header magic: 0x96f3b83d
  const MCUBOOT_MAGIC = 0x96f3b83d;
  for (let i = 0; i < Math.min(data.length, 1024); i++) {
    if (data.length - i >= 4) {
      const val = data.readUInt32LE(i);
      if (val === MCUBOOT_MAGIC) {
        console.log(`    MCUboot image header found at offset ${i}!`);
        if (data.length - i >= 32) {
          const imgSize = data.readUInt32LE(i + 12);
          const major = data[i + 20];
          const minor = data[i + 21];
          const rev = data.readUInt16LE(i + 22);
          console.log(`    Image size: ${formatBytes(imgSize)}`);
          console.log(`    Version: ${major}.${minor}.${rev}`);
        }
        return;
      }
    }
  }

  // ARM Cortex-M vector table: first word is initial SP (usually 0x20xxxxxx)
  if (data.length >= 8) {
    const sp = data.readUInt32LE(0);
    const resetVector = data.readUInt32LE(4);
    if (
      (sp & 0xff000000) === 0x20000000 &&
      (resetVector & 0xff000000) === 0x00000000
    ) {
      console.log(`    Looks like ARM Cortex-M vector table!`);
      console.log(`    Initial SP: 0x${sp.toString(16)}`);
      console.log(`    Reset vector: 0x${resetVector.toString(16)}`);
      return;
    }
  }

  // SMP/CBOR markers
  if (data[0] === 0x02 || data[0] === 0x03) {
    console.log(
      `    Starts with SMP-like op byte: 0x${data[0].toString(16).padStart(2, "0")}`,
    );
  }

  // CBOR map/array
  if ((data[0] & 0xe0) === 0xa0 || (data[0] & 0xe0) === 0x80) {
    console.log(
      `    Starts with CBOR ${(data[0] & 0xe0) === 0xa0 ? "map" : "array"}`,
    );
  }

  // Generic entropy check
  const byteFreq = new Uint32Array(256);
  const sample = data.subarray(0, Math.min(data.length, 4096));
  for (const b of sample) byteFreq[b]++;
  let entropy = 0;
  for (const count of byteFreq) {
    if (count === 0) continue;
    const p = count / sample.length;
    entropy -= p * Math.log2(p);
  }
  console.log(
    `    Entropy: ${entropy.toFixed(2)} bits/byte (${entropy > 7.5 ? "encrypted/compressed" : entropy > 6 ? "binary/code" : "structured data"})`,
  );
  console.log(`    First 64 bytes: ${data.subarray(0, 64).toString("hex")}`);
}

// ── Main ───────────────────────────────────────────────────

if (liveMode) {
  runLiveCapture();
} else if (fileMode) {
  analyzeFile(fileMode);
}
