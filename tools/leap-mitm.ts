/**
 * LEAP MITM Proxy — intercepts TLS traffic between the Lutron app and processor.
 *
 * Usage:
 *   1. Start the proxy:
 *      bun run tools/leap-mitm.ts
 *
 *   2. Redirect traffic (in another terminal):
 *      echo "rdr pass on lo0 proto tcp from any to $RA3_HOST port 8081 -> 127.0.0.1 port 8081" | sudo pfctl -ef -
 *
 *   3. Use the Lutron app — all LEAP JSON will be logged.
 *
 *   4. When done, disable the redirect:
 *      sudo pfctl -d
 */

import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import * as tls from "tls";
import { RA3_HOST } from "../lib/env";
import { resolveCerts } from "./leap-client";

const PROCESSOR_HOST = process.argv[2] ?? RA3_HOST;
const PROCESSOR_PORT = 8081;
const LISTEN_PORT = 8081;
const LISTEN_HOST = "127.0.0.1";

// Our client certs for upstream connection to the processor
const certPaths = resolveCerts("ra3", path.resolve(import.meta.dir, ".."));

// Self-signed server cert for downstream (app-facing) side
const MITM_CERT = "/tmp/mitm-cert.pem";
const MITM_KEY = "/tmp/mitm-key.pem";

let connId = 0;

function timestamp(): string {
  return new Date().toISOString().slice(11, 23);
}

function logData(id: number, direction: string, data: Buffer) {
  const text = data.toString("utf-8");
  // LEAP uses newline-delimited JSON
  const lines = text.split("\r\n").filter((l) => l.trim());
  for (const line of lines) {
    try {
      const json = JSON.parse(line);
      console.log(
        `\x1b[90m[${timestamp()}]\x1b[0m \x1b[${direction === ">>>" ? "33" : "36"}m${direction}\x1b[0m`,
        JSON.stringify(json, null, 2),
      );
    } catch {
      // Not JSON, print raw
      console.log(
        `\x1b[90m[${timestamp()}]\x1b[0m \x1b[${direction === ">>>" ? "33" : "36"}m${direction}\x1b[0m`,
        text.trimEnd(),
      );
    }
  }
}

const server = tls.createServer(
  {
    cert: fs.readFileSync(MITM_CERT),
    key: fs.readFileSync(MITM_KEY),
    // Don't require client cert from the app (we don't have the CA that signed theirs)
    requestCert: false,
    rejectUnauthorized: false,
  },
  (appSocket) => {
    const id = ++connId;
    console.log(`\x1b[32m[${timestamp()}] Connection #${id} from app\x1b[0m`);

    // Connect upstream to the real processor using our certs
    const upstream = tls.connect(
      {
        host: PROCESSOR_HOST,
        port: PROCESSOR_PORT,
        cert: fs.readFileSync(certPaths.cert),
        key: fs.readFileSync(certPaths.key),
        ca: fs.readFileSync(certPaths.ca),
        rejectUnauthorized: false,
      },
      () => {
        console.log(
          `\x1b[32m[${timestamp()}] Upstream connected to ${PROCESSOR_HOST}:${PROCESSOR_PORT}\x1b[0m`,
        );
      },
    );

    // App -> Processor
    appSocket.on("data", (data: Buffer) => {
      logData(id, ">>>", data);
      upstream.write(data);
    });

    // Processor -> App
    upstream.on("data", (data: Buffer) => {
      logData(id, "<<<", data);
      appSocket.write(data);
    });

    appSocket.on("close", () => {
      console.log(`\x1b[31m[${timestamp()}] App disconnected #${id}\x1b[0m`);
      upstream.destroy();
    });

    upstream.on("close", () => {
      console.log(
        `\x1b[31m[${timestamp()}] Upstream disconnected #${id}\x1b[0m`,
      );
      appSocket.destroy();
    });

    appSocket.on("error", (err) => {
      console.error(`App socket error #${id}:`, err.message);
      upstream.destroy();
    });

    upstream.on("error", (err) => {
      console.error(`Upstream error #${id}:`, err.message);
      appSocket.destroy();
    });
  },
);

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`LEAP MITM proxy listening on ${LISTEN_HOST}:${LISTEN_PORT}`);
  console.log(`Upstream: ${PROCESSOR_HOST}:${PROCESSOR_PORT}`);
  console.log(`\nTo redirect app traffic, run:`);
  console.log(
    `  echo "rdr pass on lo0 proto tcp from any to ${PROCESSOR_HOST} port ${PROCESSOR_PORT} -> ${LISTEN_HOST} port ${LISTEN_PORT}" | sudo pfctl -ef -`,
  );
  console.log(`\nTo stop redirect:`);
  console.log(`  sudo pfctl -d`);
});

server.on("tlsClientError", (err) => {
  console.error("TLS client error:", err.message);
});
