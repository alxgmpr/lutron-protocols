#!/usr/bin/env npx tsx

/**
 * Firmware Update LEAP Probe — read-only queries to understand firmware state.
 *
 * Probes firmware sessions, device firmware images, and operation status
 * to determine what updates are available and what state they're in.
 *
 * Usage:
 *   npx tsx tools/fw-probe.ts                    # Probe RA3 processor
 *   npx tsx tools/fw-probe.ts --host 10.x.x.x   # Specific processor
 *   npx tsx tools/fw-probe.ts --device 1091      # Probe specific device firmware
 */

import { defaultHost } from "../lib/config";
import { LeapConnection } from "./leap-client";

const args = process.argv.slice(2);
const getArg = (name: string) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};

const HOST = getArg("--host") ?? defaultHost;
const DEVICE_ID = getArg("--device");

async function main() {
  const leap = new LeapConnection({ host: HOST });
  await leap.connect();
  console.log(`Connected to ${HOST}\n`);

  // 1. Check firmware update session state
  console.log("=== /firmwareupdatesession ===");
  const fwSession = await leap.read("/firmwareupdatesession");
  const sessionStatus = fwSession.Header?.StatusCode ?? "?";
  console.log(`Status: ${sessionStatus}`);
  if (fwSession.Body) {
    console.log(JSON.stringify(fwSession.Body, null, 2));
  } else {
    console.log("(no active session)");
  }

  // 2. Check device firmware package update session
  console.log("\n=== /devicefirmwarepackageupdatesession ===");
  const dfpSession = await leap.read("/devicefirmwarepackageupdatesession");
  const dfpStatus = dfpSession.Header?.StatusCode ?? "?";
  console.log(`Status: ${dfpStatus}`);
  if (dfpSession.Body) {
    console.log(JSON.stringify(dfpSession.Body, null, 2));
  } else {
    console.log("(no active session)");
  }

  // 3. Check operation status
  console.log("\n=== /operation/status ===");
  const opStatus = await leap.read("/operation/status");
  const opStatusCode = opStatus.Header?.StatusCode ?? "?";
  console.log(`Status: ${opStatusCode}`);
  if (opStatus.Body) {
    console.log(JSON.stringify(opStatus.Body, null, 2));
  } else {
    console.log("(no operations)");
  }

  // 4. List all devices with firmware info — find ones needing updates
  console.log("\n=== Devices with firmware info ===");
  const devicesResp = await leap.readBody("/device");
  const devices: any[] = devicesResp?.Devices ?? [];
  console.log(`Found ${devices.length} devices\n`);

  // Probe firmware image for each device (or just the specified one)
  const deviceIds = DEVICE_ID
    ? [DEVICE_ID]
    : devices.map((d: any) => d.href?.split("/").pop()).filter(Boolean);

  const needsUpdate: any[] = [];
  const allDeviceFw: any[] = [];

  for (const devId of deviceIds) {
    try {
      const fwResp = await leap.readBody(`/device/${devId}/firmwareimage`);
      if (!fwResp) continue;

      const fw = fwResp.FirmwareImage ?? fwResp;
      const contents = fw.Contents ?? [];

      // Also get device name/type
      const devResp = await leap.readBody(`/device/${devId}`);
      const dev = devResp?.Device ?? {};
      const name = dev.Name ?? dev.DeviceType ?? `device/${devId}`;
      const serial = dev.SerialNumber ?? "?";
      const devType = dev.DeviceType ?? "?";
      const model = dev.ModelNumber ?? "";

      for (const c of contents) {
        const type = c.Type ?? "?";
        const currentOS = c.OS?.Firmware?.DisplayName ?? "?";
        const availOS = c.OS?.AvailableForUpload?.DisplayName ?? "?";
        const currentBoot = c.Boot?.Firmware?.DisplayName ?? "";
        const availBoot = c.Boot?.AvailableForUpload?.DisplayName ?? "";

        const osNeedsUpdate = currentOS !== availOS && availOS !== "?";
        const bootNeedsUpdate =
          currentBoot && availBoot && currentBoot !== availBoot;

        const entry = {
          deviceId: devId,
          name,
          serial,
          devType,
          model,
          type,
          currentOS,
          availOS,
          currentBoot,
          availBoot,
          osNeedsUpdate,
          bootNeedsUpdate,
        };
        allDeviceFw.push(entry);

        if (osNeedsUpdate || bootNeedsUpdate) {
          needsUpdate.push(entry);
        }
      }
    } catch {
      // Some devices don't have firmware images (e.g. picos)
    }
  }

  // Print all devices with firmware
  console.log("Device firmware status:");
  console.log("-".repeat(120));
  console.log(
    "ID".padEnd(6) +
      "Name".padEnd(30) +
      "Serial".padEnd(14) +
      "Type".padEnd(8) +
      "Current OS".padEnd(22) +
      "Available".padEnd(22) +
      "Update?",
  );
  console.log("-".repeat(120));

  for (const d of allDeviceFw) {
    const marker = d.osNeedsUpdate ? " <<< UPDATE" : "";
    console.log(
      String(d.deviceId).padEnd(6) +
        d.name.slice(0, 28).padEnd(30) +
        String(d.serial).padEnd(14) +
        d.type.padEnd(8) +
        d.currentOS.padEnd(22) +
        d.availOS.padEnd(22) +
        marker,
    );
  }

  if (needsUpdate.length > 0) {
    console.log(`\n${needsUpdate.length} device(s) need firmware updates:`);
    for (const d of needsUpdate) {
      console.log(
        `  ${d.name} (serial ${d.serial}): ${d.currentOS} → ${d.availOS}`,
      );
    }
  } else {
    console.log("\nAll devices are up to date.");
  }

  // 5. If a specific device was requested, show full firmware image details
  if (DEVICE_ID) {
    console.log(`\n=== Full firmware image for device/${DEVICE_ID} ===`);
    const fullFw = await leap.readBody(`/device/${DEVICE_ID}/firmwareimage`);
    console.log(JSON.stringify(fullFw, null, 2));

    console.log(`\n=== Full device info for device/${DEVICE_ID} ===`);
    const fullDev = await leap.readBody(`/device/${DEVICE_ID}`);
    console.log(JSON.stringify(fullDev, null, 2));
  }

  // 6. Check the processor's device definition (firmware package state)
  console.log("\n=== Processor device definition (device/1) ===");
  const procDef = await leap.readBody("/device/1");
  if (procDef?.Device) {
    const proc = procDef.Device;
    console.log(`Name: ${proc.Name ?? "?"}`);
    console.log(`DeviceType: ${proc.DeviceType ?? "?"}`);
    console.log(`SerialNumber: ${proc.SerialNumber ?? "?"}`);
    console.log(`ModelNumber: ${proc.ModelNumber ?? "?"}`);
    if (proc.FirmwareImage) {
      console.log(`FirmwareImage:`);
      console.log(JSON.stringify(proc.FirmwareImage, null, 2));
    }
    if (proc.DeviceFirmwarePackage) {
      console.log(`DeviceFirmwarePackage:`);
      console.log(JSON.stringify(proc.DeviceFirmwarePackage, null, 2));
    }
  }

  leap.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
