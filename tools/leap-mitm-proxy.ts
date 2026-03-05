#!/usr/bin/env bun

/**
 * LEAP MITM Proxy — intercept Lutron app ↔ processor LEAP traffic.
 *
 * Works by stealing the processor's IPv4 on loopback and connecting
 * upstream via the processor's IPv6 link-local address.
 *
 * Usage:
 *   bun run tools/leap-mitm-proxy.ts --gen-certs
 *   bun run tools/leap-mitm-proxy.ts --start
 *   bun run tools/leap-mitm-proxy.ts --stop
 */

import * as tls from "tls";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { resolveCerts } from "./leap-client";

const args = process.argv.slice(2);
const getArg = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};

const DATA = path.resolve(import.meta.dir, "..", "data");
const CA_CERT = path.join(DATA, "mitm-ca-cert.pem");
const CA_KEY = path.join(DATA, "mitm-ca-key.pem");
const SRV_CERT = path.join(DATA, "mitm-server-cert.pem");
const SRV_KEY = path.join(DATA, "mitm-server-key.pem");

const PROC_IPV4 = getArg("--host") ?? "10.0.0.1";
const PROC_MAC = getArg("--mac") ?? "00:00:00:00:00:00";
const CERT_NAME = getArg("--cert") ?? "ra3";
const LOG_FILE = getArg("--log");

// Derive IPv6 link-local from MAC address
function macToLinkLocal(mac: string): string {
  const bytes = mac.split(":").map((b) => parseInt(b, 16));
  bytes[0] ^= 0x02; // flip bit 7
  return (
    `fe80::${((bytes[0] << 8) | bytes[1]).toString(16)}:` +
    `${((bytes[2] << 8) | 0xff).toString(16)}:` +
    `fe${bytes[3].toString(16).padStart(2, "0")}:` +
    `${((bytes[4] << 8) | bytes[5]).toString(16)}`
  );
}

const PROC_IPV6 = macToLinkLocal(PROC_MAC);
// Node.js needs the scope ID as %interface for link-local
const PROC_UPSTREAM = `${PROC_IPV6}%en0`;

/* ── cert generation ────────────────────────────────────── */

function genCerts() {
  fs.mkdirSync(DATA, { recursive: true });
  const run = (cmd: string) => execSync(cmd, { stdio: "pipe" });

  run(`openssl ecparam -genkey -name prime256v1 -out "${CA_KEY}"`);
  run(
    `openssl req -new -x509 -key "${CA_KEY}" -out "${CA_CERT}" -days 3650 -subj "/CN=lutron-mitm-ca"`,
  );

  let cn = "radiora3-server";
  try {
    const ra3 = resolveCerts(CERT_NAME);
    const out = run(
      `echo | openssl s_client -connect ${PROC_IPV4}:8081 ` +
        `-cert "${ra3.cert}" -key "${ra3.key}" -CAfile "${ra3.ca}" 2>/dev/null | ` +
        `openssl x509 -noout -subject 2>/dev/null`,
    ).toString();
    const m = out.match(/CN\s*=\s*(\S+)/);
    if (m) cn = m[1];
  } catch {}

  const ext = path.join(DATA, "_ext.cnf");
  fs.writeFileSync(
    ext,
    `[v3]\nbasicConstraints=CA:FALSE\nsubjectAltName=IP:${PROC_IPV4},IP:127.0.0.1,DNS:${cn}\n`,
  );
  run(`openssl ecparam -genkey -name prime256v1 -out "${SRV_KEY}"`);
  run(
    `openssl req -new -key "${SRV_KEY}" -subj "/CN=${cn}" | ` +
      `openssl x509 -req -CA "${CA_CERT}" -CAkey "${CA_KEY}" -CAcreateserial ` +
      `-out "${SRV_CERT}" -days 3650 -extfile "${ext}" -extensions v3`,
  );
  try {
    fs.unlinkSync(ext);
    fs.unlinkSync(path.join(DATA, "mitm-ca-cert.srl"));
  } catch {}

  console.log(`Certs generated (CN: ${cn})`);
  console.log(`\nFirst time only — trust the CA:`);
  console.log(
    `  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${CA_CERT}"`,
  );
  console.log(`\nThen run: bun run tools/leap-mitm-proxy.ts --start`);
}

/* ── proxy ──────────────────────────────────────────────── */

function startProxy() {
  for (const f of [SRV_CERT, SRV_KEY, CA_CERT]) {
    if (!fs.existsSync(f)) {
      console.error(`Missing ${f}. Run --gen-certs first.`);
      process.exit(1);
    }
  }

  console.log(`LEAP MITM Proxy`);
  console.log(`================`);
  console.log(`Processor IPv4: ${PROC_IPV4} (will be aliased to lo0)`);
  console.log(`Processor IPv6: ${PROC_UPSTREAM} (upstream connection)`);
  console.log(`Log: ${LOG_FILE ?? "stdout"}`);
  console.log();

  // Step 1: Add lo0 alias to steal the processor's IPv4
  console.log(`Adding lo0 alias for ${PROC_IPV4}...`);
  try {
    execSync(`sudo ifconfig lo0 alias ${PROC_IPV4}/32`, { stdio: "inherit" });
  } catch (e) {
    console.error(`Failed to add lo0 alias. Run with sudo or enter password.`);
    process.exit(1);
  }

  // Step 2: Kill existing Lutron app connections
  console.log(`Killing Lutron app to force reconnect...`);
  try {
    execSync(`pkill -f "Lutron.app"`, { stdio: "pipe" });
  } catch {}

  const upstream = resolveCerts(CERT_NAME);
  const logFd = LOG_FILE
    ? fs.createWriteStream(LOG_FILE, { flags: "a" })
    : null;
  let clientN = 0;

  const now = () => new Date().toISOString();
  const emit = (id: number, dir: string, json: string) => {
    const arrow =
      dir === ">"
        ? "\x1b[36m→ APP→PROC\x1b[0m"
        : "\x1b[33m← PROC→APP\x1b[0m";
    try {
      const parsed = JSON.parse(json);
      const url = parsed.Header?.Url ?? "";
      const type = parsed.CommuniqueType ?? "";
      console.log(`\n[${now()}] #${id} ${arrow}  ${type} ${url}`);
      console.log(JSON.stringify(parsed, null, 2));
    } catch {
      console.log(
        `\n[${now()}] #${id} ${arrow}  (raw) ${json.slice(0, 500)}`,
      );
    }
    if (logFd)
      logFd.write(
        JSON.stringify({ ts: now(), client: id, dir, data: json }) + "\n",
      );
  };

  const server = tls.createServer(
    {
      cert: Buffer.concat([
        fs.readFileSync(SRV_CERT),
        fs.readFileSync(CA_CERT),
      ]),
      key: fs.readFileSync(SRV_KEY),
      requestCert: false,
      rejectUnauthorized: false,
    },
    (appSock) => {
      const id = ++clientN;
      console.log(`\n[${now()}] #${id} NEW CONNECTION from ${appSock.remoteAddress}`);

      // Connect upstream via IPv6 link-local
      const procSock = tls.connect(
        8081,
        PROC_UPSTREAM,
        {
          cert: fs.readFileSync(upstream.cert),
          key: fs.readFileSync(upstream.key),
          ca: fs.readFileSync(upstream.ca),
          rejectUnauthorized: false,
          servername: undefined, // Don't send SNI for IPv6
        },
        () => console.log(`[${now()}] #${id} upstream connected via ${PROC_UPSTREAM}`),
      );

      let aBuf = "",
        pBuf = "";

      appSock.on("data", (d) => {
        const s = d.toString();
        aBuf += s;
        const lines = aBuf.split("\n");
        aBuf = lines.pop()!;
        for (const l of lines) if (l.trim()) emit(id, ">", l);
        procSock.write(d);
      });

      procSock.on("data", (d) => {
        const s = d.toString();
        pBuf += s;
        const lines = pBuf.split("\n");
        pBuf = lines.pop()!;
        for (const l of lines) if (l.trim()) emit(id, "<", l);
        appSock.write(d);
      });

      appSock.on("error", (e) => {
        console.log(`[${now()}] #${id} app error: ${e.message}`);
        procSock.destroy();
      });
      procSock.on("error", (e) => {
        console.log(`[${now()}] #${id} upstream error: ${e.message}`);
        appSock.destroy();
      });
      appSock.on("close", () => {
        console.log(`[${now()}] #${id} closed`);
        procSock.destroy();
      });
      procSock.on("close", () => appSock.destroy());
    },
  );

  server.on("error", (e: any) => {
    if (e.code === "EADDRINUSE")
      console.error(`Port 8081 on ${PROC_IPV4} in use`);
    else console.error(e.message);
    cleanup();
    process.exit(1);
  });

  const cleanup = () => {
    console.log(`\nRemoving lo0 alias...`);
    try {
      execSync(`sudo ifconfig lo0 -alias ${PROC_IPV4}`, { stdio: "pipe" });
    } catch {}
    logFd?.end();
  };

  server.listen(8081, PROC_IPV4, () => {
    console.log(`\nListening on ${PROC_IPV4}:8081`);
    console.log(`Waiting for Lutron app connections...`);
    console.log(`\nOpen the Lutron app:  open -a Lutron`);
    console.log(`Press Ctrl+C to stop and cleanup.\n`);
  });

  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    server.close();
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    server.close();
    cleanup();
    process.exit(0);
  });
}

/* ── cleanup ────────────────────────────────────────────── */

function stopProxy() {
  console.log(`Removing lo0 alias for ${PROC_IPV4}...`);
  try {
    execSync(`sudo ifconfig lo0 -alias ${PROC_IPV4}`, { stdio: "inherit" });
    console.log("Done.");
  } catch {
    console.log("Alias not present or already removed.");
  }
}

/* ── main ───────────────────────────────────────────────── */

if (args.includes("--gen-certs")) genCerts();
else if (args.includes("--stop")) stopProxy();
else if (args.includes("--start")) startProxy();
else {
  console.log(`Usage:`);
  console.log(`  bun run tools/leap-mitm-proxy.ts --gen-certs  # Generate certs (one-time)`);
  console.log(`  bun run tools/leap-mitm-proxy.ts --start      # Start proxy`);
  console.log(`  bun run tools/leap-mitm-proxy.ts --stop       # Remove lo0 alias`);
  console.log();
  console.log(`How it works:`);
  console.log(`  1. Aliases ${PROC_IPV4} on lo0 (steals processor's IP)`);
  console.log(`  2. Listens on ${PROC_IPV4}:8081 (app connects here)`);
  console.log(`  3. Forwards to processor via IPv6 link-local (${PROC_IPV6}%en0)`);
  console.log(`  4. Logs all LEAP JSON both directions`);
}
