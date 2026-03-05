#!/usr/bin/env bun
import { LeapConnection } from "./leap-client";

const conn = new LeapConnection({ host: "10.0.0.1", certName: "ra3" });
await conn.connect();
console.log("Connected to LEAP\n");

// Compare: send GoToLevel to a REAL zone and the FAKE zone
const tests = [
  { id: 518, name: "Office Light (REAL)", level: 75 },
  { id: 3697, name: "Fake (UNADDRESSED)", level: 50 },
];

for (const t of tests) {
  console.log(`=== ${t.name} — zone/${t.id} → ${t.level}% ===`);
  try {
    const result = await conn.create(`/zone/${t.id}/commandprocessor`, {
      Command: {
        CommandType: "GoToLevel",
        Parameter: [{ Type: "Level", Value: t.level }],
      },
    });
    const body = result?.Body?.ZoneStatus;
    console.log(`  Status: ${result?.Header?.StatusCode}`);
    console.log(`  Level: ${body?.Level}`);
    console.log(`  Accuracy: ${body?.StatusAccuracy}`);
    console.log(`  Availability: ${body?.Availability}`);
    console.log();
  } catch (e) {
    console.log(`  Error: ${(e as Error).message}\n`);
  }
}

// Restore real zone
await conn.create("/zone/518/commandprocessor", {
  Command: { CommandType: "GoToLevel", Parameter: [{ Type: "Level", Value: 100 }] },
});
console.log("Restored Office Light to 100%");

conn.close();
