/**
 * Fetch firmware image details from LEAP processors.
 *
 * Connects to both Caseta (10.0.0.2) and RA3 (10.0.0.1) bridges,
 * queries /firmwareimage/{id} endpoints, and prints device/firmware info.
 */

import { LeapConnection, hrefId } from "./leap-client";

// ── Helpers ──

async function fetchFirmwareImage(
  leap: LeapConnection,
  id: number,
  label: string,
): Promise<void> {
  try {
    const resp = await leap.read(`/firmwareimage/${id}`);
    const status = resp?.Header?.StatusCode ?? "";
    if (status.startsWith("2")) {
      console.log(`  [${label}] /firmwareimage/${id}:`);
      console.log(JSON.stringify(resp.Body, null, 2));
    } else {
      console.log(`  [${label}] /firmwareimage/${id}: ${status}`);
    }
  } catch (err: any) {
    console.log(`  [${label}] /firmwareimage/${id}: ERROR ${err.message}`);
  }
}

// ── Main ──

async function main() {
  // ── Caseta ──
  console.log("=".repeat(70));
  console.log("CASETA (10.0.0.2)");
  console.log("=".repeat(70));

  const caseta = new LeapConnection({ host: "10.0.0.2", certName: "caseta" });
  await caseta.connect();
  console.log("Connected to Caseta\n");

  // Firmware images 1-20
  console.log("--- Firmware Images ---");
  for (let id = 1; id <= 20; id++) {
    await fetchFirmwareImage(caseta, id, "Caseta");
  }

  // Device list with DeviceType + FirmwareImage
  console.log("\n--- Devices ---");
  const casetaDevBody = await caseta.readBody("/device");
  const casetaDevices = casetaDevBody?.Devices ?? [];
  for (const d of casetaDevices) {
    const devId = hrefId(d.href);
    const devBody = await caseta.readBody(`/device/${devId}`);
    const dev = devBody?.Device;
    if (!dev) continue;
    console.log(`  Device ${devId}: ${dev.DeviceType ?? "unknown"}`);
    console.log(`    Name: ${dev.Name ?? "(none)"}`);
    console.log(`    SerialNumber: ${dev.SerialNumber ?? "(none)"}`);
    console.log(`    ModelNumber: ${dev.ModelNumber ?? "(none)"}`);
    if (dev.FirmwareImage?.href) {
      console.log(`    FirmwareImage: ${dev.FirmwareImage.href}`);
      // Fetch the firmware image details inline
      const fwId = hrefId(dev.FirmwareImage.href);
      const fwBody = await caseta.readBody(`/firmwareimage/${fwId}`);
      if (fwBody?.FirmwareImage) {
        console.log(`    FirmwareVersion: ${JSON.stringify(fwBody.FirmwareImage)}`);
      }
    } else {
      console.log(`    FirmwareImage: (none)`);
    }
    console.log();
  }

  caseta.close();

  // ── RA3 ──
  console.log("\n" + "=".repeat(70));
  console.log("RA3 (10.0.0.1)");
  console.log("=".repeat(70));

  const ra3 = new LeapConnection({ host: "10.0.0.1", certName: "ra3" });
  await ra3.connect();
  console.log("Connected to RA3\n");

  // Specific firmware image IDs
  console.log("--- Firmware Images (specific IDs) ---");
  for (const id of [15, 266, 232, 1993]) {
    await fetchFirmwareImage(ra3, id, "RA3");
  }

  // Also try a sweep of low IDs
  console.log("\n--- Firmware Images (1-20) ---");
  for (let id = 1; id <= 20; id++) {
    await fetchFirmwareImage(ra3, id, "RA3");
  }

  // Area walk - get first area's devices
  console.log("\n--- First Area Devices (via area walk) ---");
  const areasBody = await ra3.readBody("/area");
  const areas = areasBody?.Areas ?? [];
  console.log(`  Total areas: ${areas.length}`);

  // Find first leaf area
  let foundArea = false;
  for (const area of areas) {
    if (!area.IsLeaf) continue;
    const areaId = hrefId(area.href);
    console.log(`\n  Area: "${area.Name}" (id=${areaId})`);

    const csBody = await ra3.readBody(`/area/${areaId}/associatedcontrolstation`);
    const stations = csBody?.ControlStations ?? [];
    for (const cs of stations) {
      for (const g of cs.AssociatedGangedDevices ?? []) {
        if (!g.Device?.href) continue;
        const devId = hrefId(g.Device.href);
        const devBody = await ra3.readBody(`/device/${devId}`);
        const dev = devBody?.Device;
        if (!dev) continue;
        console.log(`    Device ${devId}: ${dev.DeviceType ?? "unknown"}`);
        console.log(`      Name: ${dev.Name ?? "(none)"}`);
        console.log(`      SerialNumber: ${dev.SerialNumber ?? "(none)"}`);
        console.log(`      ModelNumber: ${dev.ModelNumber ?? "(none)"}`);
        if (dev.FirmwareImage?.href) {
          console.log(`      FirmwareImage: ${dev.FirmwareImage.href}`);
          const fwId = hrefId(dev.FirmwareImage.href);
          const fwBody = await ra3.readBody(`/firmwareimage/${fwId}`);
          if (fwBody?.FirmwareImage) {
            console.log(`      FirmwareVersion: ${JSON.stringify(fwBody.FirmwareImage)}`);
          }
        }
        console.log();
      }
    }

    foundArea = true;
    break; // Only first leaf area
  }

  if (!foundArea) {
    console.log("  No leaf areas found");
  }

  // Also try /project to get the processor device itself
  console.log("\n--- Processor Device ---");
  const projBody = await ra3.readBody("/project");
  const masterDevices = projBody?.Project?.MasterDeviceList?.Devices ?? [];
  for (const dRef of masterDevices) {
    const devId = hrefId(dRef.href);
    const devBody = await ra3.readBody(`/device/${devId}`);
    const dev = devBody?.Device;
    if (!dev) continue;
    // Only show processor-like devices
    if (dev.DeviceType?.includes("Processor") || dev.DeviceType?.includes("Bridge") || devId <= 2) {
      console.log(`  Device ${devId}: ${dev.DeviceType ?? "unknown"}`);
      console.log(`    Name: ${dev.Name ?? "(none)"}`);
      console.log(`    SerialNumber: ${dev.SerialNumber ?? "(none)"}`);
      console.log(`    ModelNumber: ${dev.ModelNumber ?? "(none)"}`);
      if (dev.FirmwareImage?.href) {
        console.log(`    FirmwareImage: ${dev.FirmwareImage.href}`);
        const fwId = hrefId(dev.FirmwareImage.href);
        const fwBody = await ra3.readBody(`/firmwareimage/${fwId}`);
        if (fwBody?.FirmwareImage) {
          console.log(`    FirmwareVersion: ${JSON.stringify(fwBody.FirmwareImage)}`);
        }
      }
      console.log();
    }
  }

  ra3.close();
  console.log("Done.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
