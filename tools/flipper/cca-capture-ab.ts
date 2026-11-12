#!/usr/bin/env npx tsx
/**
 * cca-capture-ab — passive capture-rate check: openlutron vs. the Flipper CCA app as reference.
 *
 * Applies optional openlutron shell commands (e.g. a CC1101 reg change), resets stats, then
 * listens for --minutes. Reports, for real-device packets the Flipper decoded with a good CRC,
 * how many openlutron also streamed, plus openlutron's drops/s, syncs/s and freqest line.
 *
 * Usage:
 *   npx tsx tools/flipper/cca-capture-ab.ts [--minutes 10] [--label name]
 *       [--setup "cca tune reg set 0x12 0x05; cca tune reg set 0x1c 0x48"] [--port /dev/cu.usbmodemflip_X]
 *
 * The Flipper app must be running (launch with `ufbt launch` in apps/flipper/lutron_cca), and
 * /ext/cca_tx.txt must not exist so it stays passive.
 */

import { readdirSync } from "fs";
import { SerialPort } from "serialport";
import { config } from "../../lib/config";
import { OpenlutronStream } from "../../lib/openlutron-stream";

const args = process.argv.slice(2);
const getArg = (name: string) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};
const minutes = Number(getArg("--minutes") ?? 10);
const label = getArg("--label") ?? "run";
const setup = (getArg("--setup") ?? "")
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);
const portPath =
  getArg("--port") ??
  `/dev/${readdirSync("/dev").find((f) => f.startsWith("cu.usbmodemflip_"))}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One TDMA copy: payload without CRC (seq byte included, so copies stay distinct). */
const copyKey = (b: Buffer) => b.subarray(0, 22).toString("hex");
/** One transmission event: payload without seq byte or CRC. */
const eventKey = (b: Buffer) =>
  Buffer.concat([b.subarray(0, 1), b.subarray(2, 22)]).toString("hex");

interface Pkt {
  t: number;
  b: Buffer;
}

async function olText(ol: OpenlutronStream, cmd: string, ms = 1500) {
  let out = "";
  const on = (t: string) => {
    out += t;
  };
  ol.on("text", on);
  ol.sendText(cmd);
  await sleep(ms);
  ol.off("text", on);
  return out;
}

async function main() {
  const fz = new SerialPort({ path: portPath, baudRate: 230400 });
  await new Promise<void>((res, rej) =>
    fz.once("open", res).once("error", rej),
  );
  let fbuf = "";
  const fzPkts: Pkt[] = [];
  fz.on("data", (d: Buffer) => {
    fbuf += d.toString("latin1");
    const parts = fbuf.split("\n");
    fbuf = parts.pop()!;
    for (const l of parts) {
      const m = /RX ([0-9A-F]+) crc=1/.exec(l);
      if (m) fzPkts.push({ t: Date.now(), b: Buffer.from(m[1], "hex") });
    }
  });

  const ol = new OpenlutronStream({ host: config.openBridge });
  const olPkts: Pkt[] = [];
  ol.on("frame", (fr) => {
    if (!fr.isCcx && !fr.isTx)
      olPkts.push({ t: Date.now(), b: Buffer.from(fr.data) });
  });
  ol.on("error", () => {});
  await ol.connect();
  await sleep(500);

  for (const c of setup) process.stdout.write(`> ${c}\n${await olText(ol, c)}`);
  await olText(ol, "cca tune stats reset", 500);
  fz.write("\r");
  await sleep(300);
  fz.write("log\r");
  await sleep(500);
  fzPkts.length = 0;
  olPkts.length = 0;
  const t0 = Date.now();
  await sleep(minutes * 60_000);
  const secs = (Date.now() - t0) / 1000;
  fz.write("\x03");
  const status = await olText(ol, "status", 2000);

  // Copy level: each distinct packet the Flipper decoded.
  const olCopies = new Set(olPkts.map((p) => copyKey(p.b)));
  const fzCopies = new Set(fzPkts.map((p) => copyKey(p.b)));
  const copyHit = [...fzCopies].filter((k) => olCopies.has(k)).length;

  // Event level: same content (ignoring seq) within 2 s = one transmission.
  const events: { k: string; t0: number; t1: number }[] = [];
  const lastEvent = new Map<string, (typeof events)[number]>();
  for (const p of fzPkts) {
    const k = eventKey(p.b);
    const e = lastEvent.get(k);
    if (e && p.t - e.t1 < 2000) e.t1 = p.t;
    else {
      const ne = { k, t0: p.t, t1: p.t };
      events.push(ne);
      lastEvent.set(k, ne);
    }
  }
  const evHit = events.filter((e) =>
    olPkts.some(
      (p) => eventKey(p.b) === e.k && p.t > e.t0 - 2000 && p.t < e.t1 + 2000,
    ),
  ).length;
  const olOnly = [...olCopies].filter((k) => !fzCopies.has(k)).length;

  const num = (re: RegExp) => Number(re.exec(status)?.[1] ?? NaN);
  const drops = num(/drops=(\d+)/);
  const noise = num(/noise=(\d+)/);
  const syncs = num(/sync: hit=(\d+)/);
  const pct = (a: number, b: number) =>
    b ? ((100 * a) / b).toFixed(1) + "%" : "n/a";
  console.log(
    `\n== ${label}  (${secs.toFixed(0)} s)  setup: ${setup.join("; ") || "none"}`,
  );
  console.log(
    `copies: openlutron ${copyHit}/${fzCopies.size} of flipper's = ${pct(copyHit, fzCopies.size)}  (openlutron-only ${olOnly})`,
  );
  console.log(
    `events: openlutron ${evHit}/${events.length} = ${pct(evHit, events.length)}`,
  );
  console.log(
    `drops ${drops} = ${(drops / secs).toFixed(2)}/s   noise ${noise} = ${(noise / secs).toFixed(2)}/s   syncs ${syncs} = ${(syncs / secs).toFixed(2)}/s`,
  );
  console.log(
    status
      .split("\n")
      .find((l) => /freqest/.test(l))
      ?.trim() ?? "",
  );
  console.log(
    status
      .split("\n")
      .find((l) => /RX=/.test(l))
      ?.trim() ?? "",
  );

  ol.close();
  await new Promise<void>((r) => fz.close(() => r()));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
