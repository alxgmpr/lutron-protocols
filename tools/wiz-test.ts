#!/usr/bin/env bun

/**
 * Wiz bulb test — quick control from CLI
 *
 * Usage:
 *   bun run tools/wiz-test.ts              # getPilot (show current state)
 *   bun run tools/wiz-test.ts 50           # set to 50%
 *   bun run tools/wiz-test.ts off          # turn off
 *   bun run tools/wiz-test.ts on           # turn on (last brightness)
 *   bun run tools/wiz-test.ts --ip 10.0.0.51 75   # different bulb
 */

import { createSocket } from "dgram";

const args = process.argv.slice(2);
const ipIdx = args.indexOf("--ip");
const ip = ipIdx !== -1 ? args.splice(ipIdx, 2)[1] : "10.0.0.50";
const cmd = args[0];

const sock = createSocket("udp4");

function send(payload: object): Promise<any> {
  return new Promise((resolve) => {
    sock.send(Buffer.from(JSON.stringify(payload)), 38899, ip, () => {});
    const handler = (msg: Buffer) => {
      sock.off("message", handler);
      resolve(JSON.parse(msg.toString()));
    };
    sock.on("message", handler);
    setTimeout(() => {
      resolve(null);
      sock.off("message", handler);
    }, 3000);
  });
}

async function main() {
  let params: Record<string, any>;

  if (!cmd) {
    const r = await send({ method: "getPilot", params: {} });
    if (!r) {
      console.log(`No response from ${ip}`);
    } else {
      const s = r.result;
      console.log(
        `${ip} (mac ${s.mac}): ${s.state ? "ON" : "OFF"} ${s.dimming ?? "?"}% ${s.temp ?? "?"}K rssi=${s.rssi}`,
      );
    }
    sock.close();
    return;
  }

  if (cmd === "off") {
    params = { state: false };
  } else if (cmd === "on") {
    params = { state: true };
  } else {
    const pct = Number.parseInt(cmd, 10);
    if (Number.isNaN(pct) || pct < 0 || pct > 100) {
      console.error("Usage: wiz-test.ts [off | on | 0-100]");
      process.exit(1);
    }
    params = pct === 0 ? { state: false } : { state: true, dimming: pct };
  }

  const r = await send({ method: "setPilot", params });
  console.log(
    r?.result?.success ? `${ip} → ${cmd}` : `Failed: ${JSON.stringify(r)}`,
  );
  sock.close();
}

main();
