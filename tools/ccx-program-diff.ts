#!/usr/bin/env npx tsx

import { Decoder } from "cbor-x";
import { spawn } from "child_process";

type Row = {
  frame: number;
  relTime: number;
  src: string;
  dst: string;
  code: number;
  path: string;
  payloadHex: string;
  decoded: unknown | null;
};

const decoder = new Decoder({ mapsAsObjects: false });
const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return args.includes(name);
}

function usage() {
  console.log(`
CCX Programming Diff (compare two captures)

Usage:
  bun run tools/ccx-program-diff.ts --base <a.pcapng> --new <b.pcapng>

Options:
  --base <file>         Baseline capture
  --new <file>          Changed capture
  --dst <ipv6>          Filter destination device (full or suffix match)
  --path-prefix <path>  Default: /cg/db/ct/c
  --top <n>             Max rows to print (default: 80)
  --json                JSON output

Example:
  bun run tools/ccx-program-diff.ts \
    --base /tmp/lutron-sniff/live/before.pcapng \
    --new /tmp/lutron-sniff/live/after.pcapng \
    --dst ::3c2e:f5ff:fef9:73f9
`);
}

function normalizeDecoded(x: unknown): unknown {
  if (x instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of x.entries()) {
      out[String(k)] = normalizeDecoded(v);
    }
    return out;
  }
  if (Array.isArray(x)) return x.map(normalizeDecoded);
  if (x instanceof Uint8Array) return Buffer.from(x).toString("hex");
  return x;
}

function decodeCbor(hex: string): unknown | null {
  if (!hex) return null;
  try {
    return normalizeDecoded(decoder.decode(Buffer.from(hex, "hex")));
  } catch {
    return null;
  }
}

async function loadRows(file: string): Promise<Row[]> {
  return await new Promise((resolve, reject) => {
    const tshark = spawn(
      "tshark",
      [
        "-r",
        file,
        "-d",
        "udp.port==5683,coap",
        "-Y",
        "udp.port==5683 && coap && coap.opt.uri_path_recon",
        "-T",
        "fields",
        "-e",
        "frame.number",
        "-e",
        "frame.time_relative",
        "-e",
        "ipv6.src",
        "-e",
        "ipv6.dst",
        "-e",
        "coap.code",
        "-e",
        "coap.opt.uri_path_recon",
        "-e",
        "data",
        "-E",
        "separator=\t",
        "-E",
        "occurrence=f",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let out = "";
    let err = "";

    tshark.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    tshark.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
    tshark.on("error", reject);

    tshark.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`tshark failed (${code}): ${err.trim()}`));
        return;
      }
      const rows: Row[] = [];
      for (const line of out.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const [frameStr, relStr, src, dst, codeStr, path, data] =
          line.split("\t");
        if (!path) continue;
        const code = Number.parseInt(codeStr || "", 10);
        if (!Number.isFinite(code)) continue;
        if (code < 1 || code > 4) continue; // request methods only
        const payloadHex = (data ?? "").replace(/[:\s]/g, "").toLowerCase();
        rows.push({
          frame: Number.parseInt(frameStr || "0", 10),
          relTime: Number.parseFloat(relStr || "0"),
          src: src ?? "",
          dst: dst ?? "",
          code,
          path,
          payloadHex,
          decoded: decodeCbor(payloadHex),
        });
      }
      resolve(rows);
    });
  });
}

function method(code: number): string {
  if (code === 1) return "GET";
  if (code === 2) return "POST";
  if (code === 3) return "PUT";
  if (code === 4) return "DELETE";
  return String(code);
}

function pct(v: number): string {
  return `${((v / 65279) * 100).toFixed(1)}%`;
}

function note(path: string, decoded: unknown): string {
  if (!Array.isArray(decoded) || decoded.length < 2) return "";
  const op = decoded[0];
  const body = decoded[1];
  if (typeof op !== "number" || typeof body !== "object" || body == null) {
    return "";
  }
  const m = body as Record<string, unknown>;
  if (path === "/cg/db/ct/c/AHA" && op === 108) {
    const k4 = typeof m["4"] === "number" ? (m["4"] as number) : undefined;
    const k5 = typeof m["5"] === "number" ? (m["5"] as number) : undefined;
    return `status-led on=${k4 ?? "?"} off=${k5 ?? "?"}`;
  }
  if (path === "/cg/db/ct/c/AAI" && op === 3) {
    const h = typeof m["2"] === "number" ? (m["2"] as number) : undefined;
    const l = typeof m["3"] === "number" ? (m["3"] as number) : undefined;
    const k8 = typeof m["8"] === "number" ? (m["8"] as number) : undefined;
    const chunks: string[] = [];
    if (h != null) chunks.push(`high=${h} (${pct(h)})`);
    if (l != null) chunks.push(`low=${l} (${pct(l)})`);
    if (k8 != null) chunks.push(`k8=${k8}`);
    return chunks.join(" ");
  }
  if (
    path.startsWith("/cg/db/ct/c/AF") &&
    op === 107 &&
    typeof m["0"] === "number"
  ) {
    return `led-index=${m["0"] as number}`;
  }
  return "";
}

function dstMatches(dst: string, filter: string): boolean {
  const a = dst.toLowerCase();
  const b = filter.toLowerCase();
  return a === b || a.endsWith(b);
}

const baseFile = getArg("--base");
const newFile = getArg("--new");
const dstFilter = getArg("--dst");
const pathPrefix = getArg("--path-prefix") ?? "/cg/db/ct/c";
const topN = Number.parseInt(getArg("--top") ?? "80", 10);
const asJson = hasFlag("--json");

if (!baseFile || !newFile || hasFlag("--help") || hasFlag("-h")) {
  usage();
  process.exit(baseFile && newFile ? 0 : 1);
}

const [baseRowsAll, newRowsAll] = await Promise.all([
  loadRows(baseFile),
  loadRows(newFile),
]);

const rowFilter = (r: Row) => {
  if (pathPrefix && !r.path.startsWith(pathPrefix)) return false;
  if (dstFilter && !dstMatches(r.dst, dstFilter)) return false;
  return true;
};

const baseRows = baseRowsAll.filter(rowFilter);
const newRows = newRowsAll.filter(rowFilter);

type Agg = {
  key: string;
  dst: string;
  path: string;
  code: number;
  payloadHex: string;
  decoded: unknown | null;
  note: string;
  baseCount: number;
  newCount: number;
};

const agg = new Map<string, Agg>();

function add(rows: Row[], side: "base" | "new") {
  for (const r of rows) {
    const key = `${r.dst}\t${r.code}\t${r.path}\t${r.payloadHex}`;
    const existing = agg.get(key) ?? {
      key,
      dst: r.dst,
      path: r.path,
      code: r.code,
      payloadHex: r.payloadHex,
      decoded: r.decoded,
      note: note(r.path, r.decoded),
      baseCount: 0,
      newCount: 0,
    };
    if (side === "base") existing.baseCount++;
    else existing.newCount++;
    agg.set(key, existing);
  }
}

add(baseRows, "base");
add(newRows, "new");

const changed = [...agg.values()]
  .filter((x) => x.baseCount !== x.newCount)
  .sort((a, b) => {
    const da = Math.abs(a.newCount - a.baseCount);
    const db = Math.abs(b.newCount - b.baseCount);
    if (db !== da) return db - da;
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    return a.dst.localeCompare(b.dst);
  });

if (asJson) {
  console.log(
    JSON.stringify(
      {
        baseFile,
        newFile,
        dstFilter: dstFilter ?? null,
        pathPrefix,
        baseRows: baseRows.length,
        newRows: newRows.length,
        changed: changed.slice(0, topN).map((x) => ({
          dst: x.dst,
          method: method(x.code),
          path: x.path,
          baseCount: x.baseCount,
          newCount: x.newCount,
          delta: x.newCount - x.baseCount,
          payload: x.payloadHex,
          decoded: x.decoded,
          note: x.note || undefined,
        })),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

console.log(`base=${baseFile}`);
console.log(`new=${newFile}`);
if (dstFilter) console.log(`dst filter=${dstFilter}`);
console.log(`path prefix=${pathPrefix}`);
console.log(`rows: base=${baseRows.length} new=${newRows.length}`);
console.log(`changed signatures=${changed.length}`);
console.log("");

for (const x of changed.slice(0, topN)) {
  const delta = x.newCount - x.baseCount;
  console.log(
    `${x.dst} ${method(x.code)} ${x.path} base=${x.baseCount} new=${x.newCount} delta=${delta > 0 ? "+" : ""}${delta}`,
  );
  if (x.note) console.log(`  note=${x.note}`);
  if (x.decoded != null) {
    console.log(`  cbor=${JSON.stringify(x.decoded)}`);
  } else if (x.payloadHex) {
    console.log(`  payload=${x.payloadHex}`);
  }
}
