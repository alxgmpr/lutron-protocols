#!/usr/bin/env bun

/**
 * Enumerate Lutron application notes by probing assets.lutron.com
 *
 * Usage:
 *   bun run tools/appnotes/enumerate.ts                   # scan 040000-049999 (resumes automatically)
 *   bun run tools/appnotes/enumerate.ts --start 046000    # resume from 046000
 *   bun run tools/appnotes/enumerate.ts --concurrency 20
 *   bun run tools/appnotes/enumerate.ts --fresh           # ignore existing CSV, start over
 *
 * Results are written incrementally to tools/appnotes/results.csv
 * Safe to Ctrl-C at any time — progress is preserved.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { parseArgs } from "util";

const BASE_URL = "https://assets.lutron.com/a/documents";
const TITLE_MAX_LEN = 120;
const SCRIPT_DIR = dirname(resolve(import.meta.filename));
const CSV_PATH = resolve(SCRIPT_DIR, "results.csv");
const CURSOR_PATH = resolve(SCRIPT_DIR, ".cursor");
const CSV_HEADER = "id,url,title,size_kb\n";

// Rate limiting: random delay between batches
const BATCH_DELAY_MIN_MS = 500;
const BATCH_DELAY_MAX_MS = 2000;
// Per-request jitter within a batch
const REQUEST_JITTER_MS = 100;

const { values: args } = parseArgs({
  options: {
    start: { type: "string", default: "040000" },
    end: { type: "string", default: "049999" },
    concurrency: { type: "string", default: "20" },
    fresh: { type: "boolean", default: false },
  },
});

const END = parseInt(args.end!, 10);
const CONCURRENCY = parseInt(args.concurrency!, 10);

function csvEscape(s: string): string {
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "\u2026" : s;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function jitteredDelay(min: number, max: number): Promise<void> {
  return sleep(min + Math.random() * (max - min));
}

function countCsvEntries(): number {
  if (!existsSync(CSV_PATH)) return 0;
  const lines = readFileSync(CSV_PATH, "utf-8").split("\n");
  // subtract header + trailing empty line
  return lines.filter((l, i) => i > 0 && l.trim()).length;
}

function getLastCsvId(): number | null {
  if (!existsSync(CSV_PATH)) return null;
  const content = readFileSync(CSV_PATH, "utf-8").trimEnd();
  const lines = content.split("\n");
  for (let i = lines.length - 1; i > 0; i--) {
    const id = lines[i].split(",")[0];
    if (id && /^\d{6}$/.test(id)) return parseInt(id, 10);
  }
  return null;
}

function readCursor(): number | null {
  if (!existsSync(CURSOR_PATH)) return null;
  const val = parseInt(readFileSync(CURSOR_PATH, "utf-8").trim(), 10);
  return Number.isNaN(val) ? null : val;
}

function writeCursor(id: number) {
  writeFileSync(CURSOR_PATH, id.toString() + "\n");
}

function appendCsvRow(
  id: string,
  url: string,
  title: string,
  sizeKB: number | null,
) {
  const line = [id, url, csvEscape(title), sizeKB ?? ""].join(",") + "\n";
  appendFileSync(CSV_PATH, line);
}

/** Extract PDF /Title from raw bytes */
function extractPdfTitle(buf: ArrayBuffer): string | null {
  const slice = new Uint8Array(buf, 0, Math.min(buf.byteLength, 65536));
  const text = new TextDecoder("latin1").decode(slice);

  // Match /Title (literal string) — handles nested parens
  const literalMatch = text.match(/\/Title\s*\(([^)]*(?:\)[^)]*)*)\)/);
  if (literalMatch) return cleanPdfString(literalMatch[1]);

  // Match /Title <hex string>
  const hexMatch = text.match(/\/Title\s*<([0-9A-Fa-f]+)>/);
  if (hexMatch) return decodeHexString(hexMatch[1]);

  // Try XMP metadata
  const xmpMatch = text.match(
    /<dc:title>[\s\S]*?<rdf:li[^>]*>([^<]+)<\/rdf:li>/,
  );
  if (xmpMatch) return xmpMatch[1].trim();

  return null;
}

function cleanPdfString(s: string): string {
  return s
    .replace(/\\n/g, " ")
    .replace(/\\r/g, "")
    .replace(/\\([()])/g, "$1")
    .replace(/\\\\/g, "\\")
    .trim();
}

function decodeHexString(hex: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.slice(i, i + 2), 16));
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    let result = "";
    for (let i = 2; i < bytes.length; i += 2) {
      result += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    }
    return result.trim();
  }
  return String.fromCharCode(...bytes).trim();
}

async function checkExists(
  id: string,
): Promise<{ exists: boolean; contentLength: number | null }> {
  // Small per-request jitter to avoid burst patterns
  await sleep(Math.random() * REQUEST_JITTER_MS);
  const url = `${BASE_URL}/${id}.pdf`;
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "follow" });
    if (res.ok) {
      const cl = res.headers.get("content-length");
      return { exists: true, contentLength: cl ? parseInt(cl, 10) : null };
    }
    return { exists: false, contentLength: null };
  } catch {
    return { exists: false, contentLength: null };
  }
}

async function fetchTitle(id: string): Promise<string | null> {
  await sleep(Math.random() * REQUEST_JITTER_MS);
  const url = `${BASE_URL}/${id}.pdf`;
  try {
    const res = await fetch(url, { headers: { Range: "bytes=0-65535" } });
    if (!res.ok && res.status !== 206) return null;
    const buf = await res.arrayBuffer();
    return extractPdfTitle(buf);
  } catch {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const buf = await res.arrayBuffer();
      return extractPdfTitle(buf);
    } catch {
      return null;
    }
  }
}

async function run() {
  const requestedStart = parseInt(args.start!, 10);

  // Resume logic
  let START: number;
  let existingCount: number;
  if (args.fresh) {
    writeFileSync(CSV_PATH, CSV_HEADER);
    writeCursor(requestedStart);
    existingCount = 0;
    START = requestedStart;
  } else {
    existingCount = countCsvEntries();
    if (existingCount === 0 && !existsSync(CSV_PATH)) {
      writeFileSync(CSV_PATH, CSV_HEADER);
    }
    const cursor = readCursor();
    const lastCsvId = getLastCsvId();
    // Use whichever is further: cursor file or last CSV entry + 1
    const resumeFrom = Math.max(
      cursor ?? 0,
      lastCsvId != null ? lastCsvId + 1 : 0,
    );
    START = Math.max(resumeFrom, requestedStart);
  }

  const fullRange = END - requestedStart + 1;
  const alreadyChecked = START - requestedStart;
  const remaining = END - START + 1;
  if (remaining <= 0) {
    console.log(`Already scanned up to ${END}. Use --fresh to rescan.`);
    return;
  }

  let found = existingCount;
  let checked = alreadyChecked;
  let lastPrint = 0;

  console.log(
    `Scanning ${START.toString().padStart(6, "0")} - ${END.toString().padStart(6, "0")} (${remaining} remaining of ${fullRange} total, concurrency=${CONCURRENCY})`,
  );
  console.log(`${existingCount} existing entries in CSV`);
  console.log(`Results → ${CSV_PATH} (incremental writes)`);
  console.log(
    `Rate limiting: ${BATCH_DELAY_MIN_MS}-${BATCH_DELAY_MAX_MS}ms between batches, ${REQUEST_JITTER_MS}ms per-request jitter`,
  );
  console.log();

  for (let batchStart = START; batchStart <= END; batchStart += CONCURRENCY) {
    const batchEnd = Math.min(batchStart + CONCURRENCY - 1, END);
    const ids = Array.from({ length: batchEnd - batchStart + 1 }, (_, i) =>
      (batchStart + i).toString().padStart(6, "0"),
    );

    const results = await Promise.all(
      ids.map((id) => checkExists(id).then((r) => ({ id, ...r }))),
    );

    const hits = results.filter((r) => r.exists);
    // Stagger title fetches too
    const notes = await Promise.all(
      hits.map(async (hit) => {
        const rawTitle = await fetchTitle(hit.id);
        const title = rawTitle ? truncate(rawTitle, TITLE_MAX_LEN) : "";
        const sizeKB = hit.contentLength
          ? Math.round(hit.contentLength / 1024)
          : null;
        return { id: hit.id, title, sizeKB };
      }),
    );

    for (const note of notes) {
      const url = `${BASE_URL}/${note.id}.pdf`;
      appendCsvRow(note.id, url, note.title, note.sizeKB);
      found++;
      const size = note.sizeKB ? `${note.sizeKB}KB` : "?";
      console.log(`  ${note.id}.pdf  [${size}]  ${note.title || "(no title)"}`);
    }

    checked += ids.length;
    const now = Date.now();
    if (now - lastPrint > 3000 || batchEnd >= END) {
      const pct = ((checked / fullRange) * 100).toFixed(1);
      process.stderr.write(
        `\r  Progress: ${checked}/${fullRange} (${pct}%) — ${found} total found`,
      );
      lastPrint = now;
    }

    // Save cursor so we can resume from here
    writeCursor(batchEnd + 1);

    // Random delay between batches to avoid rate limiting
    if (batchEnd < END) {
      await jitteredDelay(BATCH_DELAY_MIN_MS, BATCH_DELAY_MAX_MS);
    }
  }

  process.stderr.write("\n");
  console.log();
  console.log(`Done. ${found} total application notes in CSV.`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
