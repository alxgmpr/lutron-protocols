import { LeapConnection, hrefId } from "./leap-client";

const conn = new LeapConnection({ host: "10.0.0.1", certName: "ra3" });
await conn.connect();
console.log("Connected.");

conn.onEvent = (msg: any) => {
  const url = msg.Header?.Url ?? "?";
  const type = msg.CommuniqueType ?? "?";
  console.log(`\n=== EVENT [${new Date().toISOString()}] ${type} ${url} ===`);
  console.log(JSON.stringify(msg, null, 2));
};

// Find all zones first
const areas = (await conn.read("/area"))?.Body?.Areas ?? [];
console.log(`Found ${areas.length} areas`);
const leafAreas = areas.filter((a: any) => a.IsLeaf);
console.log(`Leaf areas: ${leafAreas.length}`);

// Subscribe to each leaf area's zone status
for (const area of leafAreas) {
  const areaId = hrefId(area.href);
  const resp = await conn.subscribe(`/area/${areaId}/associatedzone/status`);
  const s = resp?.Header?.StatusCode ?? "?";
  console.log(`  /area/${areaId}/associatedzone/status [${s}] (${area.Name})`);
}

// Also try subscribing to specific zone statuses
const zoneResp = await conn.read("/area/32/associatedzone");
const zones = zoneResp?.Body?.Zones ?? [];
console.log(`\nZones in area 32 (Office): ${zones.length}`);
for (const z of zones) {
  const zid = hrefId(z.href);
  const resp = await conn.subscribe(`/zone/${zid}/status`);
  const s = resp?.Header?.StatusCode ?? "?";
  console.log(`  /zone/${zid}/status [${s}] (${z.Name})`);
}

// Subscribe broadly
for (const url of ["/device/3681", "/project", "/link/437/status"]) {
  const r = await conn.subscribe(url).catch(() => null);
  console.log(`  ${url} [${r?.Header?.StatusCode ?? "err"}]`);
}

console.log("\nListening for events... Control a light in the app. (45s timeout)\n");
await new Promise((r) => setTimeout(r, 40000));
conn.close();
