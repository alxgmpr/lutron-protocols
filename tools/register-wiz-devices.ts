#!/usr/bin/env bun

/**
 * Register synthetic CCX devices in the Designer DB for WiZ-bridged zones.
 *
 * The Lutron RA3 processor ignores DEVICE_REPORT messages from unknown serials.
 * This script inserts fake device records so the bridge can report state back.
 *
 * Usage:
 *   bun run tools/register-wiz-devices.ts --dry-run     Print SQL without executing
 *   bun run tools/register-wiz-devices.ts --apply        Execute against Designer DB
 *
 * Prerequisites: Designer VM running with project open, sql-http-api.ps1 listening.
 */

const DESIGNER_VM_HOST = process.env.DESIGNER_VM_HOST ?? "10.0.0.5";
const QUERY_URL = `http://${DESIGNER_VM_HOST}:9999/query`;

// CCX zone IDs for WiZ-bridged zones (ObjectType=370 in Designer DB)
const WIZ_ZONES = [8238, 9390, 9475, 9538, 9555, 9572, 9589, 9606, 9623];
const SERIAL_BASE = 90000001;

// HQR-3LD ModelInfoID — standard CCX local dimmer, already in the project
const MODEL_INFO_ID = 730;

const args = process.argv.slice(2);
const dryRun = !args.includes("--apply");

async function query(sql: string): Promise<string> {
  const res = await fetch(QUERY_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: sql,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok)
    throw new Error(`DB query failed: ${res.status} ${await res.text()}`);
  return res.text();
}

function parsePsvRows(text: string): Record<string, string>[] {
  const lines = text
    .trim()
    .split("\n")
    .filter(
      (l) =>
        l.trim() &&
        !l.match(/^\(?\d+ rows? affected\)?/) &&
        !l.match(/^-+(\|-+)*$/),
    );
  if (lines.length < 2) return [];
  const headers = lines[0].split("|").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const vals = line.split("|").map((v) => v.trim());
    const row: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) row[headers[i]] = vals[i] ?? "";
    return row;
  });
}

async function main() {
  console.log(
    dryRun
      ? "=== DRY RUN (use --apply to execute) ==="
      : "=== APPLYING to Designer DB ===",
  );
  console.log(`Designer VM: ${DESIGNER_VM_HOST}`);
  console.log();

  // 1. Find zone info (AreaID, Name) from Designer DB
  const zoneList = WIZ_ZONES.join(",");
  const zoneInfo = parsePsvRows(
    await query(`
      SELECT z.ZoneID, z.Name AS ZoneName, a.AreaID, a.Name AS AreaName
      FROM tblZone z
      JOIN tblArea a ON z.ParentId = a.AreaID
      WHERE z.ZoneID IN (${zoneList})
      ORDER BY z.ZoneID
    `),
  );

  if (zoneInfo.length === 0) {
    console.error("No zones found in Designer DB! Are they created?");
    process.exit(1);
  }

  console.log("Found zones:");
  for (const z of zoneInfo) {
    console.log(`  ${z.ZoneID}: ${z.AreaName} / ${z.ZoneName}`);
  }
  console.log();

  // 2. Check which zones already have devices (skip them)
  const existingDevices = parsePsvRows(
    await query(`
      SELECT zcui.AssignedZoneID
      FROM tblZoneControlUI zcui
      WHERE zcui.AssignedZoneID IN (${zoneList})
        AND zcui.ParentDeviceType = 5
    `),
  );
  const zonesWithDevices = new Set(
    existingDevices.map((r) => parseInt(r.AssignedZoneID, 10)),
  );

  const zonesToRegister = zoneInfo.filter(
    (z) => !zonesWithDevices.has(parseInt(z.ZoneID, 10)),
  );

  if (zonesToRegister.length === 0) {
    console.log("All zones already have devices. Nothing to do.");
    return;
  }

  if (zonesWithDevices.size > 0) {
    console.log(
      `Skipping zones with existing devices: ${[...zonesWithDevices].join(", ")}`,
    );
  }

  // 3. Get next available IDs
  const maxIds = parsePsvRows(
    await query(`
      SELECT
        (SELECT ISNULL(MAX(ControlStationID), 100000) FROM tblControlStation) AS MaxCS,
        (SELECT ISNULL(MAX(ControlStationDeviceID), 100000) FROM tblControlStationDevice) AS MaxCSD,
        (SELECT ISNULL(MAX(ZoneControlUIID), 100000) FROM tblZoneControlUI) AS MaxZCUI
    `),
  );

  let nextCS = parseInt(maxIds[0].MaxCS, 10) + 1;
  let nextCSD = parseInt(maxIds[0].MaxCSD, 10) + 1;
  let nextZCUI = parseInt(maxIds[0].MaxZCUI, 10) + 1;

  // 4. Build SQL
  const statements: string[] = ["SET XACT_ABORT ON;", "BEGIN TRANSACTION;"];
  const serialMap: Record<string, number> = {};

  for (let i = 0; i < zonesToRegister.length; i++) {
    const z = zonesToRegister[i];
    const zoneId = parseInt(z.ZoneID, 10);
    const areaId = parseInt(z.AreaID, 10);
    const serial = SERIAL_BASE + WIZ_ZONES.indexOf(zoneId);
    const csId = nextCS++;
    const csdId = nextCSD++;
    const zcuiId = nextZCUI++;
    const name = `WiZ ${z.ZoneName || "Zone " + zoneId}`;

    serialMap[String(zoneId)] = serial;

    const guid1 = crypto.randomUUID().toUpperCase();
    const guid2 = crypto.randomUUID().toUpperCase();

    statements.push(`
-- Zone ${zoneId}: ${z.AreaName} / ${z.ZoneName} → serial ${serial}
INSERT INTO tblControlStation (ControlStationID, Name, ParentId, ParentType, DesignRevision, DatabaseRevision, SortOrder, CustomSortOrder, ShadeGroupCount, HasTranslucentCover, WhereUsedId, [Guid])
  VALUES (${csId}, N'${name}', ${areaId}, 2, 1, 0, 0, 0, 0, 0, 2147483647, '${guid1}');

INSERT INTO tblControlStationDevice (ControlStationDeviceID, Name, SerialNumber, SerialNumberState, ModelInfoID, ParentControlStationID, DesignRevision, DatabaseRevision, SortOrder, ModelIsLocked, ProgrammingID, RFDeviceSlot, IsManuallyProgrammed, HardwareRevision, IsAuto, AppliedEngravingType, OrderOnCommunicationLink, IsSceneSaveEnabled, MasterSliderID, WhereUsedId, BacklightLevel, QuickTestStatus, InputReceived, IsEmergencyController, [Guid])
  VALUES (${csdId}, N'${name}', ${serial}, 2, ${MODEL_INFO_ID}, ${csId}, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2147483647, 0, 0, 0, 0, '${guid2}');

INSERT INTO tblZoneControlUI (ZoneControlUIID, Name, ParentDeviceID, ParentDeviceType, AssignedZoneID, DesignRevision, DatabaseRevision, SortOrder, ControlNumber, DoubleTapFadeTimeOrRateValue, DoubleTapFadeType, LocalButtonDoubleTapPresetLevel, LocalButtonPresetLevel, LongFadeToOffPrefadeTime, LongFadeToOffTimeOrRateValue, LongFadeToOffType, PressFadeOffTimeOrRateValue, PressFadeOffType, PressFadeOnTimeOrRateValue, PressFadeOnType, RaiseLowerRate, SaveAlways, ObjectType /* 15=standard dimmer */, IsRemoteZone, SliderLowEndType, WhereUsedId, ZoneOnIndicatorIntensity, ZoneOffIndicatorIntensity)
  VALUES (${zcuiId}, N'${name}', ${csdId}, 5, ${zoneId}, 1, 0, 0, 0, 0, 0, 100, 100, 0, 0, 0, 0, 0, 0, 0, 19, 0, 15, 0, 0, 2147483647, 0, 0);`);
  }

  statements.push("", "COMMIT TRANSACTION;");

  const sql = statements.join("\n");

  console.log("=== Generated SQL ===");
  console.log(sql);
  console.log();

  console.log("=== Serial Mapping ===");
  for (const [zid, serial] of Object.entries(serialMap)) {
    const z = zonesToRegister.find((r) => r.ZoneID === zid);
    console.log(
      `  zone ${zid} (${z?.AreaName}/${z?.ZoneName}): serial ${serial}`,
    );
  }
  console.log();

  if (dryRun) {
    console.log("Dry run complete. Use --apply to execute.");
    // Write serial map for reference
    const { writeFileSync } = await import("fs");
    const { join } = await import("path");
    const outPath = join(
      import.meta.dir,
      "..",
      "data",
      "wiz-device-serials.json",
    );
    writeFileSync(outPath, JSON.stringify(serialMap, null, 2) + "\n");
    console.log(`Serial map written to ${outPath}`);
    return;
  }

  // Execute
  console.log("Executing...");
  const result = await query(sql);
  console.log("Result:", result.trim() || "(success, no output)");

  // Verify
  console.log("\nVerifying...");
  const verify = parsePsvRows(
    await query(`
      SELECT csd.SerialNumber, csd.Name, zcui.AssignedZoneID
      FROM tblControlStationDevice csd
      JOIN tblZoneControlUI zcui ON zcui.ParentDeviceID = csd.ControlStationDeviceID
        AND zcui.ParentDeviceType = 5
      WHERE csd.SerialNumber >= ${SERIAL_BASE}
        AND csd.SerialNumber < ${SERIAL_BASE + 100}
    `),
  );

  for (const row of verify) {
    console.log(
      `  ✓ serial ${row.SerialNumber} → zone ${row.AssignedZoneID} (${row.Name})`,
    );
  }

  if (verify.length === zonesToRegister.length) {
    console.log(`\nAll ${verify.length} devices registered successfully.`);
  } else {
    console.log(
      `\nWARNING: Expected ${zonesToRegister.length} devices, found ${verify.length}`,
    );
  }

  // Write serial map
  const { writeFileSync } = await import("fs");
  const { join } = await import("path");
  const outPath = join(
    import.meta.dir,
    "..",
    "data",
    "wiz-device-serials.json",
  );
  writeFileSync(outPath, JSON.stringify(serialMap, null, 2) + "\n");
  console.log(`Serial map written to ${outPath}`);

  console.log("\nNext: Transfer project to RA3 via Designer UI.");
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
