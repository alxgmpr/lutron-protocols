#!/usr/bin/env npx tsx
/**
 * cca-loopback — closed-loop RF check between the Flipper CCA app and openlutron.
 *
 *   rx: openlutron transmits N tagged packets (`tx <hex>`), Flipper must log them (USB `log`).
 *   tx: Flipper transmits N tagged packets (via /ext/cca_tx.txt), openlutron must stream them
 *       back byte-for-byte, CRC included.
 *
 * Packets use a fake device ID (CA FE ..) so no paired device reacts.
 *
 * Usage:
 *   npx tsx tools/flipper/cca-loopback.ts [--dir rx|tx|both] [--n 10] [--gap ms] [--no-launch] [--trim N] [--verbose]
 *       [--port /dev/cu.usbmodemflip_X]
 *
 *   --trim N  sets the Flipper's CC1101 FSCTRL0 (freq offset, N * 1587 Hz) before testing.
 */

import { execSync } from "child_process";
import { readdirSync } from "fs";
import { SerialPort } from "serialport";
import { fileURLToPath } from "url";
import { config } from "../../lib/config";
import { OpenlutronStream } from "../../lib/openlutron-stream";

const args = process.argv.slice(2);
const getArg = (name: string) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};
const hasFlag = (name: string) => args.includes(name);

const dir = getArg("--dir") ?? "both";
const N = Number(getArg("--n") ?? 10);
// openlutron sends each `tx` as a burst of ~11 copies, one per 75 ms TDMA frame (~825 ms).
// Bursts that overlap share a slot and go out back to back, which the Flipper cannot separate,
// so the default gap keeps them apart. Use --gap 400 to exercise the overlapping case.
const GAP_MS = Number(getArg("--gap") ?? 1000);
const APP_DIR = fileURLToPath(
  new URL("../../apps/flipper/lutron_cca", import.meta.url),
);
const portPath =
  getArg("--port") ??
  `/dev/${readdirSync("/dev").find((f) => f.startsWith("cu.usbmodemflip_"))}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 22-byte payload: [type][seq][CA FE][dir][i][pattern...]. Byte 1 (seq) is rewritten by openlutron. */
function testPacket(tag: number, i: number): Buffer {
  const p = Buffer.alloc(22);
  p[0] = 0x88;
  p[1] = 0x01;
  p[2] = 0xca;
  p[3] = 0xfe;
  p[4] = tag;
  p[5] = i;
  for (let k = 6; k < 22; k++) p[k] = (k * 17 + i) & 0xff;
  return p;
}
/** Identity of a test packet, ignoring the seq byte. */
const key = (b: Buffer) =>
  b[2] === 0xca && b[3] === 0xfe
    ? Buffer.concat([b.subarray(0, 1), b.subarray(2, 22)]).toString("hex")
    : null;

// --- Flipper USB CLI ------------------------------------------------------
class Flipper {
  private port!: SerialPort;
  private buf = "";
  readonly lines: string[] = [];
  async open() {
    this.port = new SerialPort({ path: portPath, baudRate: 230400 });
    await new Promise<void>((res, rej) =>
      this.port.once("open", res).once("error", rej),
    );
    this.port.on("data", (d: Buffer) => {
      this.buf += d.toString("latin1");
      const parts = this.buf.split("\n");
      this.buf = parts.pop()!;
      for (const p of parts) this.lines.push(p.replace(/\r$/, ""));
    });
    await this.cmd(""); // sync to prompt
  }
  write(s: string | Buffer) {
    this.port.write(s);
  }
  async waitFor(re: RegExp, ms = 3000): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (re.test(this.buf) || this.lines.some((l) => re.test(l))) return true;
      await sleep(20);
    }
    return false;
  }
  async cmd(c: string, ms = 1500) {
    this.lines.length = 0;
    this.buf = "";
    this.write(`${c}\r`);
    await this.waitFor(/>: $/, ms);
    return this.lines.slice();
  }
  async startLog() {
    this.write("log\r");
    await sleep(300);
  }
  async stopLog() {
    this.write("\x03");
    await this.waitFor(/>: $/, 2000);
  }
  async writeFile(path: string, data: string) {
    await this.cmd(`storage remove ${path}`);
    this.buf = "";
    this.write(`storage write_chunk ${path} ${data.length}\r`);
    if (!(await this.waitFor(/Ready/, 2000)))
      throw new Error("write_chunk: no Ready");
    this.write(data);
    await this.waitFor(/>: $/, 2000);
  }
  close() {
    return new Promise<void>((r) => this.port.close(() => r()));
  }
}

function launchApp() {
  execSync("ufbt launch", { cwd: APP_DIR, stdio: "inherit" });
}

async function main() {
  if (!hasFlag("--no-launch")) {
    // ufbt launch fails if the app is already open; Back closes it.
    const f = new Flipper();
    await f.open();
    if ((await f.cmd("loader info")).some((l) => /Lutron CCA/i.test(l))) {
      for (const t of ["press", "short", "release"])
        await f.cmd(`input send back ${t}`);
      await sleep(500);
    }
    await f.close();
    launchApp();
    await sleep(1500);
  }

  const fz = new Flipper();
  await fz.open();
  const trim = getArg("--trim"); // Flipper FSCTRL0 offset, units of 1587 Hz
  if (trim !== undefined) {
    await fz.writeFile("/ext/cca_tx.txt", `T${trim}\n`);
    await sleep(500);
  }
  const ol = new OpenlutronStream({ host: config.openBridge });
  const olRx: Buffer[] = [];
  let olTx = 0;
  const olOther: Buffer[] = []; // CCA frames that aren't test packets (shows mangled ones)
  ol.on("frame", (fr) => {
    if (fr.isCcx) return;
    if (!key(fr.data)) {
      if (!fr.isTx) olOther.push(Buffer.from(fr.data));
      return;
    }
    if (fr.isTx) olTx++;
    else olRx.push(Buffer.from(fr.data));
  });
  ol.on("error", () => {});
  await ol.connect();
  await sleep(500);

  let fail = false;

  if (dir === "rx" || dir === "both") {
    fz.lines.length = 0;
    await fz.startLog();
    const sent = Array.from({ length: N }, (_, i) => testPacket(0x01, i));
    for (const p of sent) {
      ol.sendText(`tx ${p.toString("hex")}`);
      await sleep(GAP_MS);
    }
    await sleep(1000);
    await fz.stopLog();
    const got = fz.lines
      .map((l) => /RX ([0-9A-F]+) crc=(\d) rssi=(-?\d+)/.exec(l))
      .filter((m) => m)
      .map((m) => ({
        b: Buffer.from(m![1], "hex"),
        crc: m![2] === "1",
        rssi: Number(m![3]),
      }));
    const mine = got.filter((g) => key(g.b)?.startsWith("88cafe01"));
    const hit = sent.filter((p) =>
      mine.some((g) => g.crc && key(g.b) === key(p)),
    ).length;
    const bad = mine.filter((g) => !g.crc).length;
    console.log(
      `RX openlutron->flipper: ${hit}/${N} packets heard (copies: ${mine.length} of ${olTx} sent, crc-fail ${bad}, rssi ${mine.map((g) => g.rssi).join(",")})`,
    );
    if (hasFlag("--verbose"))
      console.log(
        fz.lines
          .filter((l) => /RX [0-9A-F]/.test(l))
          .map((l) => `  fz ${l.slice(l.indexOf("RX "))}`)
          .join("\n"),
      );
    if (hit < N) fail = true;
  }

  if (dir === "tx" || dir === "both") {
    olRx.length = 0;
    olOther.length = 0;
    const sent = Array.from({ length: N }, (_, i) => testPacket(0x02, i));
    await fz.writeFile(
      "/ext/cca_tx.txt",
      sent.map((p) => p.toString("hex")).join("\n") + "\n",
    );
    fz.lines.length = 0;
    await fz.startLog();
    await sleep(1000 + N * 100);
    await fz.stopLog();
    const txLog = fz.lines
      .map((l) => /TX ([0-9A-F]+) ok=(\d)/.exec(l))
      .filter((m) => m)
      .map((m) => ({ b: Buffer.from(m![1], "hex"), ok: m![2] === "1" }));
    const mine = olRx.filter((b) => key(b)?.startsWith("88cafe02"));
    // Exact match against what the Flipper says it sent (payload + its CRC).
    const hit = txLog.filter((t) =>
      mine.some((b) => b.subarray(0, 24).equals(t.b)),
    ).length;
    console.log(
      `TX flipper->openlutron: ${hit}/${N} exact (flipper logged ${txLog.length}, ok=${txLog.filter((t) => t.ok).length}; openlutron heard ${mine.length})`,
    );
    console.log(`  heard idx: ${mine.map((b) => b[5]).join(",")}`);
    for (const b of mine)
      if (!txLog.some((t) => b.subarray(0, 24).equals(t.b)))
        console.log(`  inexact ${b.toString("hex")}`);
    for (const t of txLog.slice(0, 3))
      console.log(`  sent  ${t.b.toString("hex")}`);
    if (hasFlag("--verbose"))
      for (const l of fz.lines)
        if (/tx:|pre-tx/.test(l)) console.log(`  fz ${l}`);
    for (const b of olOther) console.log(`  other ${b.toString("hex")}`);
    if (hit < N) fail = true;
  }

  ol.close();
  await fz.close();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
