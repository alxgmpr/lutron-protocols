#!/usr/bin/env bun
/**
 * LEAP Firmware Update Session — try CreateRequest on Caseta
 * Tests what happens when we try to create a firmware update session
 * even though all devices are up to date.
 */

import * as tls from "tls";
import * as fs from "fs";
import * as path from "path";

import { resolveCerts } from "./leap-client";

function sendAndWait(
  socket: tls.TLSSocket,
  msg: any,
  timeout = 10000,
): Promise<any[]> {
  return new Promise((resolve) => {
    const responses: any[] = [];
    let buffer = "";

    const handler = (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          responses.push(JSON.parse(line));
        } catch {}
      }
    };

    socket.on("data", handler);

    socket.write(JSON.stringify(msg) + "\n");

    setTimeout(() => {
      socket.removeListener("data", handler);
      resolve(responses);
    }, timeout);
  });
}

async function connect(host: string, certName: string): Promise<tls.TLSSocket> {
  const certs = resolveCerts(certName);
  const ca = fs.readFileSync(certs.ca);
  const cert = fs.readFileSync(certs.cert);
  const key = fs.readFileSync(certs.key);

  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host,
        port: 8081,
        ca,
        cert,
        key,
        rejectUnauthorized: false,
      },
      () => {
        // Drain initial messages (Caseta sends SubscribeResponse on connect)
        setTimeout(() => resolve(socket), 2000);
      },
    );
    socket.on("error", reject);
    // Drain data during connect
    socket.on("data", () => {});
  });
}

function dump(label: string, data: any) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${label}`);
  console.log(`${"─".repeat(60)}`);
  console.log(JSON.stringify(data, null, 2));
}

async function main() {
  console.log("Connecting to Caseta...");
  const socket = await connect("10.0.0.2", "caseta");
  console.log("Connected.\n");

  // 1. Try CreateRequest /firmwareupdatesession (empty body)
  console.log("=== Test 1: CreateRequest /firmwareupdatesession (empty body) ===");
  const r1 = await sendAndWait(socket, {
    CommuniqueType: "CreateRequest",
    Header: { Url: "/firmwareupdatesession" },
  });
  dump("CreateRequest /firmwareupdatesession (empty)", r1);

  // 2. Try CreateRequest /firmwareupdatesession with device hrefs
  console.log("\n=== Test 2: CreateRequest /firmwareupdatesession with device list ===");
  const r2 = await sendAndWait(socket, {
    CommuniqueType: "CreateRequest",
    Header: { Url: "/firmwareupdatesession" },
    Body: {
      FirmwareUpdateSession: {
        Devices: [
          { href: "/device/15" }, // DVRF-6L dimmer
        ],
      },
    },
  });
  dump("CreateRequest /firmwareupdatesession (with devices)", r2);

  // 3. Try CreateRequest /firmwareupdate
  console.log("\n=== Test 3: CreateRequest /firmwareupdate ===");
  const r3 = await sendAndWait(socket, {
    CommuniqueType: "CreateRequest",
    Header: { Url: "/firmwareupdate" },
    Body: {
      FirmwareUpdate: {
        Devices: [{ href: "/device/15" }],
      },
    },
  });
  dump("CreateRequest /firmwareupdate", r3);

  // 4. Try UpdateRequest /firmwareimage/15 (see if we can change AvailableForUpload)
  console.log("\n=== Test 4: ReadRequest /firmwareimage/15 (baseline) ===");
  const r4 = await sendAndWait(socket, {
    CommuniqueType: "ReadRequest",
    Header: { Url: "/firmwareimage/15" },
  });
  dump("ReadRequest /firmwareimage/15", r4);

  // 5. Try CreateRequest to /server/1/commandprocessor (BeginTransferSession)
  console.log("\n=== Test 5: CreateRequest /server/1/commandprocessor (BeginTransferSession) ===");
  const r5 = await sendAndWait(socket, {
    CommuniqueType: "CreateRequest",
    Header: { Url: "/server/1/commandprocessor" },
    Body: {
      Command: {
        CommandType: "BeginTransferSession",
      },
    },
  });
  dump("CreateRequest /server/1/commandprocessor (BeginTransferSession)", r5);

  // 6. Try SubscribeRequest /firmwareupdatesession
  console.log("\n=== Test 6: SubscribeRequest /firmwareupdatesession ===");
  const r6 = await sendAndWait(socket, {
    CommuniqueType: "SubscribeRequest",
    Header: { Url: "/firmwareupdatesession" },
  }, 5000);
  dump("SubscribeRequest /firmwareupdatesession", r6);

  // 7. Try SubscribeRequest /operation/status
  console.log("\n=== Test 7: SubscribeRequest /operation/status ===");
  const r7 = await sendAndWait(socket, {
    CommuniqueType: "SubscribeRequest",
    Header: { Url: "/operation/status" },
  }, 5000);
  dump("SubscribeRequest /operation/status", r7);

  // 8. Try reading /server/1/commandprocessor
  console.log("\n=== Test 8: ReadRequest /server/1/commandprocessor ===");
  const r8 = await sendAndWait(socket, {
    CommuniqueType: "ReadRequest",
    Header: { Url: "/server/1/commandprocessor" },
  }, 5000);
  dump("ReadRequest /server/1/commandprocessor", r8);

  // 9. Try CreateRequest /device/15/firmwareupdate
  console.log("\n=== Test 9: CreateRequest /device/15/firmwareupdate ===");
  const r9 = await sendAndWait(socket, {
    CommuniqueType: "CreateRequest",
    Header: { Url: "/device/15/firmwareupdate" },
  });
  dump("CreateRequest /device/15/firmwareupdate", r9);

  socket.destroy();
  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
