#!/usr/bin/env bun
/**
 * LEAP Event Subscriber — subscribe to live events and log them
 * Usage: bun run tools/leap-subscribe.ts [--host 10.0.0.2] [--cert caseta]
 */

import * as tls from "tls";
import * as fs from "fs";
import { resolveCerts } from "./leap-client";
import { parseArgs } from "util";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    host: { type: "string", default: "10.0.0.2" },
    cert: { type: "string", default: "caseta" },
  },
});

const certs = resolveCerts(values.cert!);
const socket = tls.connect(
  {
    host: values.host!,
    port: 8081,
    ca: fs.readFileSync(certs.ca),
    cert: fs.readFileSync(certs.cert),
    key: fs.readFileSync(certs.key),
    rejectUnauthorized: false,
  },
  () => {
    console.log(`Connected to ${values.host}:8081\n`);

    // Subscribe to event streams
    const subs = [
      "/zone/status",
      "/operation/status",
      "/device/status/deviceheard",
    ];

    for (const url of subs) {
      const req = JSON.stringify({
        CommuniqueType: "SubscribeRequest",
        Header: { Url: url },
      });
      socket.write(req + "\n");
      console.log(`Subscribed: ${url}`);
    }

    console.log("\nListening for events... (Ctrl+C to stop)\n");
  },
);

let buffer = "";
socket.on("data", (data) => {
  buffer += data.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop()!;

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      const type = msg.CommuniqueType ?? "???";
      const url = msg.Header?.Url ?? "???";
      const status = msg.Header?.StatusCode ?? "";
      const ts = new Date().toISOString().slice(11, 23);

      if (type === "SubscribeResponse") {
        // Initial subscription response — summarize
        const bodyType = msg.Header?.MessageBodyType ?? "";
        console.log(`[${ts}] ${type} ${url} ${status} (${bodyType})`);

        // For zone/status, show initial levels
        if (msg.Body?.ZoneStatuses) {
          for (const zs of msg.Body.ZoneStatuses) {
            const zid = zs.Zone?.href?.replace("/zone/", "") ?? "?";
            const sw = zs.SwitchedLevel ? ` ${zs.SwitchedLevel}` : "";
            console.log(
              `         zone ${zid}: ${zs.Level}%${sw} (${zs.StatusAccuracy})`,
            );
          }
        }
      } else {
        // Event — print full details
        console.log(`\n[${ts}] === ${type} ${url} ${status} ===`);
        if (msg.Body) {
          console.log(JSON.stringify(msg.Body, null, 2));
        }
      }
    } catch {
      console.log(`[raw] ${line.slice(0, 200)}`);
    }
  }
});

socket.on("error", (err) => console.error("Error:", err.message));
socket.on("close", () => {
  console.log("\nConnection closed.");
  process.exit(0);
});
