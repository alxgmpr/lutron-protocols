#!/usr/bin/env npx tsx

/**
 * Reflash the nRF52840 NCP over SWD from the Nucleo — no USB, no nrfutil, no
 * unplugging the dongle.
 *
 * The Nucleo cannot hold the image: ot-ncp-ftd.hex is 633 KB of text against
 * roughly 76 KB of free RAM. So it goes over in windows. Each window is
 * uploaded through the existing OTA upload commands (STREAM_CMD_OTA_UPLOAD_*,
 * the same path tools/cca/ota-upload.ts uses), checksummed, and then fed
 * straight through the firmware's Intel HEX parser into flash a page at a time
 * before the next window is sent.
 *
 * The upload is unacknowledged UDP, so a dropped chunk is expected rather than
 * exceptional. That is what the per-window CRC-32 is for: the firmware checks
 * it *before* parsing a single byte, so a rejected window can simply be sent
 * again. Once a window has been fed there is no going back — the pages behind
 * it are erased and written.
 *
 * You need an Intel HEX, not firmware/ncp/ot-ncp-ftd-dfu.zip (that is a DFU
 * package). If you only have an .elf:
 *   arm-none-eabi-objcopy -O ihex ot-ncp-ftd.elf ot-ncp-ftd.hex
 *
 * Usage:
 *   npx tsx tools/swd/ncp-flash.ts --hex firmware/ncp/ot-ncp-ftd.hex
 *   npx tsx tools/swd/ncp-flash.ts --hex <path> [--host <ip>] [--window 61440]
 *                                  [--retries 3] [--dry-run] [--no-wait-thread]
 */

import { createSocket, type Socket } from "node:dgram";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { crc32 } from "node:zlib";
import { config } from "../../lib/config";

const PORT = 9433;
const STREAM_CMD_KEEPALIVE = 0x00;
const STREAM_CMD_OTA_UPLOAD_START = 0x18;
const STREAM_CMD_OTA_UPLOAD_CHUNK = 0x19;
const STREAM_CMD_OTA_UPLOAD_END = 0x1a;
const STREAM_CMD_TEXT = 0x20;
const STREAM_RESP_TEXT = 0xfd;

const CHUNK_BYTES = 240;

/** Chunks per burst, and the breather after each. See upload() for why. */
const CHUNKS_PER_BATCH = 8;
const BATCH_PAUSE_MS = 2;

/** Default window: comfortably inside the firmware's 110 KB upload buffer. */
const DEFAULT_WINDOW = 60 * 1024;

/** nRF52840 has 1 MB of flash. UICR lives at 0x10001000, well past it. */
const NRF52840_FLASH_END = 0x100000;

/** `swd flash begin` can spend 10 s waiting for AP0 after a CTRL-AP reset, and
 *  a window's worth of erase/program/verify is seconds of bit-banging. */
const CMD_TIMEOUT_MS = 45_000;

/** A reflashed NCP gets several probe-and-join rounds, each of which can wait
 *  30 s for attachment. */
const THREAD_WAIT_MS = 180_000;

const args = process.argv.slice(2);
const getArg = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};
const hasFlag = (name: string): boolean => args.includes(name);

class Nucleo {
  private pending: ((text: string) => void) | null = null;
  private buffer = "";

  constructor(
    private sock: Socket,
    private host: string,
  ) {
    sock.on("message", (msg) => {
      if (msg.length < 1 || msg[0] !== STREAM_RESP_TEXT) return;
      this.buffer += msg.subarray(1).toString("utf-8");
      // Shell output arrives as one or more datagrams; a short quiet period
      // after the first is the only end-of-response marker there is.
      if (this.pending) {
        const done = this.pending;
        this.pending = null;
        const text = this.buffer;
        this.buffer = "";
        done(text);
      }
    });
  }

  send(cmd: number, data: Uint8Array): void {
    const frame = Buffer.alloc(2 + data.length);
    frame[0] = cmd;
    frame[1] = data.length;
    if (data.length > 0) Buffer.from(data).copy(frame, 2);
    this.sock.send(frame, 0, frame.length, PORT, this.host);
  }

  /** Run a shell command and return everything it printed. */
  async cmd(line: string, timeoutMs = CMD_TIMEOUT_MS): Promise<string> {
    this.buffer = "";
    const reply = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(
          new Error(`timed out after ${timeoutMs} ms waiting for: ${line}`),
        );
      }, timeoutMs);
      this.pending = (text) => {
        clearTimeout(timer);
        resolve(text);
      };
    });
    this.send(STREAM_CMD_TEXT, Buffer.from(line, "utf-8"));
    return reply;
  }

  /** Push one window into the Nucleo's upload buffer. */
  async upload(window: Uint8Array): Promise<void> {
    const start = new Uint8Array(4);
    new DataView(start.buffer).setUint32(0, window.length, true);
    this.send(STREAM_CMD_OTA_UPLOAD_START, start);
    await sleep(50);

    const numChunks = Math.ceil(window.length / CHUNK_BYTES);
    for (let i = 0; i < numChunks; i++) {
      const off = i * CHUNK_BYTES;
      const slice = window.subarray(
        off,
        Math.min(off + CHUNK_BYTES, window.length),
      );
      const data = new Uint8Array(2 + slice.length);
      data[0] = (i >> 8) & 0xff;
      data[1] = i & 0xff;
      data.set(slice, 2);
      this.send(STREAM_CMD_OTA_UPLOAD_CHUNK, data);
      // Pace to something the receiver can actually absorb. The stream task
      // drains its UDP mailbox once per loop pass, and that loop blocks a tick
      // on the TX queue when idle, so sustained throughput is bounded by the
      // tick rate however deep the mailbox is. Bursting past it drops the
      // overflow silently — the firmware learns nothing, and only the window
      // CRC downstream notices. A batch per millisecond leaves margin without
      // making an 11-window image take noticeably longer.
      if (i % CHUNKS_PER_BATCH === CHUNKS_PER_BATCH - 1)
        await sleep(BATCH_PAUSE_MS);
    }
    await sleep(100);
    this.send(STREAM_CMD_OTA_UPLOAD_END, new Uint8Array(0));
    await sleep(50);
  }
}

/** Split on line boundaries so a window never ends mid-record. The firmware
 *  carries partial lines anyway; this just keeps the logs readable. */
function splitWindows(text: string, maxBytes: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  const enc = new TextEncoder();
  let cur = "";
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    const next = `${line}\n`;
    if (cur.length + next.length > maxBytes && cur.length > 0) {
      out.push(enc.encode(cur));
      cur = "";
    }
    cur += next;
  }
  if (cur.length > 0) out.push(enc.encode(cur));
  return out;
}

/** What the image covers, so the operator can sanity-check it before it lands. */
function describe(text: string): { min: number; max: number; bytes: number } {
  let base = 0;
  let min = 0xffffffff;
  let max = 0;
  let bytes = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith(":")) continue;
    const len = parseInt(line.substr(1, 2), 16);
    const off = parseInt(line.substr(3, 4), 16);
    const type = parseInt(line.substr(7, 2), 16);
    if (type === 0x00) {
      const addr = base + off;
      if (addr < min) min = addr;
      if (addr + len > max) max = addr + len;
      bytes += len;
    } else if (type === 0x04) {
      base = parseInt(line.substr(9, 4), 16) << 16;
    } else if (type === 0x02) {
      base = parseInt(line.substr(9, 4), 16) << 4;
    }
  }
  return { min: bytes > 0 ? min : 0, max, bytes };
}

const hex = (n: number) => n.toString(16).padStart(8, "0");

async function main(): Promise<void> {
  const hexPath = getArg("--hex");
  const host = getArg("--host") ?? config.openBridge;
  const windowBytes = Number(getArg("--window") ?? DEFAULT_WINDOW);
  const retries = Number(getArg("--retries") ?? "3");
  const dryRun = hasFlag("--dry-run");
  const waitThread = !hasFlag("--no-wait-thread");

  if (!hexPath) {
    console.error(
      "Usage: npx tsx tools/swd/ncp-flash.ts --hex <path.hex> [--host <ip>]\n" +
        "       [--window <bytes>] [--retries <n>] [--dry-run] [--no-wait-thread]",
    );
    process.exit(1);
  }

  const text = readFileSync(hexPath, "utf-8");
  const info = describe(text);
  const windows = splitWindows(text, windowBytes);

  console.log(`[ncp-flash] ${hexPath}`);
  console.log(
    `[ncp-flash] image 0x${hex(info.min)}..0x${hex(info.max)}, ` +
      `${info.bytes} bytes in ${windows.length} windows of <=${windowBytes}`,
  );

  if (info.bytes === 0) {
    console.error(
      "[ncp-flash] no data records — is that actually an Intel HEX?",
    );
    process.exit(1);
  }
  if (info.min < 0x1000) {
    console.error(
      `[ncp-flash] image starts at 0x${hex(info.min)}, below the MBR boundary at 0x1000.\n` +
        "            The firmware will refuse it. This is not the NCP application image.",
    );
    process.exit(1);
  }
  if (info.max > NRF52840_FLASH_END) {
    // A type-04 record pointing at UICR (0x10001000) is the usual way this
    // happens — nrfutil-produced hex files carry one. The firmware rejects it
    // too, but only when the record arrives, by which time earlier windows
    // have already erased and programmed real pages.
    console.error(
      `[ncp-flash] image ends at 0x${hex(info.max)}, past the end of flash at ` +
        `0x${hex(NRF52840_FLASH_END)}.\n` +
        "            Records outside the application region (UICR?) cannot be written here.",
    );
    process.exit(1);
  }

  if (dryRun) {
    for (const [i, w] of windows.entries()) {
      console.log(
        `[dry] window ${i + 1}/${windows.length}: ${w.length} bytes, crc32=${hex(crc32(w))}`,
      );
    }
    return;
  }

  const sock = createSocket("udp4");
  await new Promise<void>((resolve, reject) => {
    sock.once("error", reject);
    sock.bind(0, () => resolve());
  });
  const nuc = new Nucleo(sock, host);

  // Register as a stream client so responses come back to this socket.
  nuc.send(STREAM_CMD_KEEPALIVE, new Uint8Array(0));
  await sleep(150);

  let opened = false;
  try {
    const begin = await nuc.cmd("swd flash begin");
    process.stdout.write(begin);
    if (!begin.includes("flash session open")) {
      throw new Error("could not open a flash session");
    }
    opened = true;

    // The real ceiling is the bootloader base, which the firmware reads out of
    // UICR and only knows once it is connected. Check it here, while the part
    // is still untouched — sink_record() would catch the same thing, but not
    // until mid-stream with earlier pages already erased and programmed.
    const region = begin.match(/region ([0-9a-fA-F]{8})\.\.([0-9a-fA-F]{8})/);
    if (region) {
      const regionEnd = parseInt(region[2], 16);
      if (info.max > regionEnd) {
        throw new Error(
          `image ends at 0x${hex(info.max)}, past the writable region ceiling ` +
            `0x${hex(regionEnd)} (the bootloader starts there) — refusing before anything is erased`,
        );
      }
    } else {
      console.warn(
        "[ncp-flash] could not parse the region from 'flash session open'; " +
          "relying on the firmware to reject out-of-range records mid-stream",
      );
    }

    for (const [i, w] of windows.entries()) {
      const want = hex(crc32(w));
      let ok = false;
      for (let attempt = 1; attempt <= retries; attempt++) {
        await nuc.upload(w);
        const reply = (await nuc.cmd(`swd flash window ${want}`)).trim();
        if (reply.includes(" ok:")) {
          console.log(
            `[ncp-flash] window ${i + 1}/${windows.length}: ${reply.split("\n")[0]}`,
          );
          ok = true;
          break;
        }
        if (reply.includes("REJECT")) {
          const short = reply.match(/short upload, (\d+)\/(\d+)/);
          const detail = short
            ? ` (~${Math.ceil((Number(short[2]) - Number(short[1])) / CHUNK_BYTES)} of ${Math.ceil(w.length / CHUNK_BYTES)} chunks lost)`
            : "";
          console.warn(
            `[ncp-flash] window ${i + 1} attempt ${attempt}/${retries}: ${reply}${detail}`,
          );
          continue;
        }
        // Anything else is a programming failure, and re-sending will not fix it.
        throw new Error(`window ${i + 1} failed: ${reply}`);
      }
      if (!ok)
        throw new Error(
          `window ${i + 1} never arrived intact after ${retries} attempts`,
        );
    }

    const end = await nuc.cmd("swd flash end");
    process.stdout.write(end);
    opened = false;
    if (!end.includes("flash OK")) {
      throw new Error("flash did not complete cleanly");
    }
  } catch (e) {
    if (opened) {
      console.error("[ncp-flash] aborting the session on the Nucleo");
      try {
        process.stdout.write(await nuc.cmd("swd flash abort"));
      } catch {
        console.error(
          "[ncp-flash] abort did not answer — run 'swd flash abort' by hand",
        );
      }
    }
    sock.close();
    throw e;
  }

  if (!waitThread) {
    sock.close();
    return;
  }

  // A reflash wipes the NCP's Thread dataset. The STM32 re-pushes credentials
  // by itself, but it takes a couple of probe-and-join rounds to get there —
  // and until it does the NCP looks exactly like a dead radio.
  console.log("[ncp-flash] waiting for the NCP to rejoin Thread...");
  const deadline = Date.now() + THREAD_WAIT_MS;
  let role = "DETACHED";
  while (Date.now() < deadline) {
    await sleep(5000);
    let status: string;
    try {
      status = await nuc.cmd("ccx", 10_000);
    } catch {
      continue; // the shell is busy inside thread_join; ask again
    }
    const m = status.match(/Thread role:\s*(\S+)/);
    if (m) {
      role = m[1];
      // Match the roles that mean "on the network", rather than anything that
      // is merely not DETACHED — UNKNOWN is not success.
      if (role === "CHILD" || role === "ROUTER" || role === "LEADER") break;
    }
  }
  sock.close();

  if (role === "DETACHED") {
    console.error(
      "[ncp-flash] still DETACHED. The image is on the part and verified, but it\n" +
        "            has not attached. Check 'ccx' and the Nucleo console.",
    );
    process.exit(1);
  }
  console.log(`[ncp-flash] rejoined Thread as ${role}`);
}

main().catch((e) => {
  console.error(`[ncp-flash] ${e.message ?? e}`);
  process.exit(1);
});
