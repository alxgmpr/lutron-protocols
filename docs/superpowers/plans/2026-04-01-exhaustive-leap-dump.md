# GLAB-56: Exhaustive LEAP Dump Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `--full` flag to `leap-dump.ts` that recursively walks all known LEAP endpoints via a declarative registry, producing a comprehensive JSON dump of the entire processor state.

**Architecture:** A typed endpoint registry array defines every known LEAP path with metadata (key, children, per-item sub-resources). A generic walker function iterates the registry, fetches collections, recurses into children per item, and returns raw LEAP JSON keyed by registry key. The existing `fetchLeapData` pipeline is unchanged.

**Tech Stack:** TypeScript (tsx), Node.js TLS, LEAP JSON-over-TLS protocol

**Spec:** `docs/superpowers/specs/2026-04-01-exhaustive-leap-dump-design.md`

---

### Task 1: Add Registry Types and Walker to leap-client.ts

**Files:**
- Modify: `lib/leap-client.ts:648-653` (append after `buildDumpData`)
- Test: `test/leap-walker.test.ts`

- [ ] **Step 1: Write the failing test for walkEndpoints**

Create `test/leap-walker.test.ts`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { walkEndpoints, LEAP_REGISTRY } from "../tools/leap-client";

// Mock LeapConnection that returns canned responses
class MockLeap {
  private responses: Record<string, any>;

  constructor(responses: Record<string, any>) {
    this.responses = responses;
  }

  async readBody(url: string): Promise<any | null> {
    return this.responses[url] ?? null;
  }
}

test("walkEndpoints fetches top-level collection", async () => {
  const mock = new MockLeap({
    "/server": { Servers: [{ Type: "LEAP", ProtocolVersion: "03.247" }] },
  });

  const registry = [
    { path: "/server", key: "server", core: true, itemsField: "Servers" },
  ];

  const result = await walkEndpoints(mock as any, registry, {
    full: true,
    log: () => {},
  });

  assert.deepStrictEqual(result.server, [
    { Type: "LEAP", ProtocolVersion: "03.247" },
  ]);
});

test("walkEndpoints skips non-core endpoints when full=false", async () => {
  const mock = new MockLeap({
    "/server": { Servers: [{ Type: "LEAP" }] },
    "/system": { TimeZone: "America/New_York" },
  });

  const registry = [
    { path: "/server", key: "server", core: true, itemsField: "Servers" },
    { path: "/system", key: "system", itemsField: null },
  ];

  const result = await walkEndpoints(mock as any, registry, {
    full: false,
    log: () => {},
  });

  assert.ok(result.server);
  assert.strictEqual(result.system, undefined);
});

test("walkEndpoints handles singleton endpoints (itemsField=null)", async () => {
  const mock = new MockLeap({
    "/system": { TimeZone: "America/New_York", Coordinates: { Lat: 40 } },
  });

  const registry = [
    { path: "/system", key: "system", core: true, itemsField: null },
  ];

  const result = await walkEndpoints(mock as any, registry, {
    full: true,
    log: () => {},
  });

  assert.strictEqual(result.system.TimeZone, "America/New_York");
});

test("walkEndpoints silently skips null responses", async () => {
  const mock = new MockLeap({});

  const registry = [
    { path: "/occupancygroup", key: "occupancyGroups", core: true, itemsField: "OccupancyGroups" },
  ];

  const result = await walkEndpoints(mock as any, registry, {
    full: true,
    log: () => {},
  });

  assert.strictEqual(result.occupancyGroups, undefined);
});

test("walkEndpoints fetches children per item", async () => {
  const mock = new MockLeap({
    "/area": {
      Areas: [
        { href: "/area/1", Name: "Office", IsLeaf: true },
        { href: "/area/2", Name: "Lobby", IsLeaf: true },
      ],
    },
    "/area/1/associatedzone": {
      Zones: [{ href: "/zone/10", Name: "Light" }],
    },
    "/area/2/associatedzone": {
      Zones: [{ href: "/zone/20", Name: "Fan" }],
    },
  });

  const registry = [
    {
      path: "/area",
      key: "areas",
      core: true,
      itemsField: "Areas",
      children: [
        { path: "/associatedzone", key: "zones", itemsField: "Zones" },
      ],
    },
  ];

  const result = await walkEndpoints(mock as any, registry, {
    full: true,
    log: () => {},
  });

  assert.strictEqual(result.areas.length, 2);
  assert.deepStrictEqual(result.areas[0].zones, [
    { href: "/zone/10", Name: "Light" },
  ]);
  assert.deepStrictEqual(result.areas[1].zones, [
    { href: "/zone/20", Name: "Fan" },
  ]);
});

test("walkEndpoints fetches perItem sub-resources", async () => {
  const mock = new MockLeap({
    "/zone": {
      Zones: [{ href: "/zone/518", Name: "Light" }],
    },
    "/zone/518/status": { Level: 75, FanSpeed: null },
  });

  const registry = [
    {
      path: "/zone",
      key: "zones",
      core: true,
      itemsField: "Zones",
      perItem: [{ path: "/status", key: "status" }],
    },
  ];

  const result = await walkEndpoints(mock as any, registry, {
    full: true,
    log: () => {},
  });

  assert.strictEqual(result.zones.length, 1);
  assert.deepStrictEqual(result.zones[0].status, {
    Level: 75,
    FanSpeed: null,
  });
});

test("walkEndpoints handles children returning null gracefully", async () => {
  const mock = new MockLeap({
    "/area": {
      Areas: [{ href: "/area/1", Name: "Office", IsLeaf: true }],
    },
    // /area/1/associatedzone returns null (204/404)
  });

  const registry = [
    {
      path: "/area",
      key: "areas",
      core: true,
      itemsField: "Areas",
      children: [
        { path: "/associatedzone", key: "zones", itemsField: "Zones" },
      ],
    },
  ];

  const result = await walkEndpoints(mock as any, registry, {
    full: true,
    log: () => {},
  });

  assert.strictEqual(result.areas.length, 1);
  assert.deepStrictEqual(result.areas[0].zones, undefined);
});

test("LEAP_REGISTRY is a non-empty array with required fields", () => {
  assert.ok(Array.isArray(LEAP_REGISTRY));
  assert.ok(LEAP_REGISTRY.length > 20, `Expected 20+ entries, got ${LEAP_REGISTRY.length}`);

  for (const entry of LEAP_REGISTRY) {
    assert.ok(typeof entry.path === "string", `Missing path: ${JSON.stringify(entry)}`);
    assert.ok(typeof entry.key === "string", `Missing key: ${JSON.stringify(entry)}`);
    assert.ok(
      entry.itemsField === null || typeof entry.itemsField === "string",
      `Invalid itemsField: ${JSON.stringify(entry)}`,
    );
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test test/leap-walker.test.ts`
Expected: FAIL — `walkEndpoints` and `LEAP_REGISTRY` not exported from `lib/leap-client.ts`

- [ ] **Step 3: Add types, registry, and walker to leap-client.ts**

Append to `lib/leap-client.ts` after the closing `}` of `buildDumpData` (line 653):

```typescript
// --- Endpoint Registry & Walker ---

export interface EndpointDef {
  /** LEAP path, e.g. "/area", "/occupancygroup" */
  path: string;
  /** Output JSON key */
  key: string;
  /** If true, fetched even without --full */
  core?: boolean;
  /** Response body field containing the items array, null for singletons */
  itemsField: string | null;
  /** Sub-endpoints fetched per item (appended to item href) */
  children?: ChildDef[];
  /** Direct sub-resources fetched per item */
  perItem?: PerItemDef[];
}

export interface ChildDef {
  /** Appended to parent item href, e.g. "/associatedzone" */
  path: string;
  /** Nested key in item output */
  key: string;
  /** Response field containing child array */
  itemsField: string;
}

export interface PerItemDef {
  /** Appended to item href, e.g. "/status" */
  path: string;
  /** Key in item output */
  key: string;
}

export const LEAP_REGISTRY: EndpointDef[] = [
  // --- Core (always fetched) ---
  { path: "/server", key: "server", core: true, itemsField: "Servers" },
  { path: "/link", key: "links", core: true, itemsField: "Links" },
  {
    path: "/area", key: "areas", core: true, itemsField: "Areas",
    children: [
      { path: "/associatedzone", key: "zones", itemsField: "Zones" },
      { path: "/associatedcontrolstation", key: "controlStations", itemsField: "ControlStations" },
      { path: "/associatedareascene", key: "scenes", itemsField: "AreaScenes" },
      { path: "/associatedoccupancygroup", key: "occupancyGroups", itemsField: "OccupancyGroups" },
    ],
  },
  {
    path: "/zone", key: "zones", core: true, itemsField: "Zones",
    perItem: [
      { path: "/status", key: "status" },
      { path: "/fadesettings", key: "fadeSettings" },
    ],
  },
  {
    path: "/device", key: "devices", core: true, itemsField: "Devices",
    perItem: [
      { path: "/status", key: "status" },
      { path: "/buttongroup/expanded", key: "buttonGroups" },
      { path: "/firmwareimage", key: "firmware" },
      { path: "/addressedstate", key: "addressedState" },
    ],
  },
  { path: "/button", key: "buttons", core: true, itemsField: "Buttons" },
  { path: "/project", key: "project", core: true, itemsField: null },

  // --- Extended (--full only) ---
  { path: "/system", key: "system", itemsField: null },
  {
    path: "/preset", key: "presets", itemsField: "Presets",
    perItem: [
      { path: "/presetassignment", key: "assignments" },
    ],
  },
  { path: "/presetassignment", key: "presetAssignments", itemsField: "PresetAssignments" },
  { path: "/programmingmodel", key: "programmingModels", itemsField: "ProgrammingModels" },
  { path: "/virtualbutton", key: "virtualButtons", itemsField: "VirtualButtons" },
  { path: "/buttongroup", key: "buttonGroups", itemsField: "ButtonGroups" },
  {
    path: "/occupancygroup", key: "occupancyGroups", itemsField: "OccupancyGroups",
    children: [
      { path: "/associatedzone", key: "zones", itemsField: "Zones" },
      { path: "/associatedsensor", key: "sensors", itemsField: "Sensors" },
    ],
  },
  { path: "/timeclock", key: "timeClocks", itemsField: "TimeClocks" },
  { path: "/timeclockevent", key: "timeClockEvents", itemsField: "TimeClockEvents" },
  { path: "/service", key: "services", itemsField: "Services" },
  { path: "/firmware", key: "firmware", itemsField: "Firmwares" },
  { path: "/firmware/status", key: "firmwareStatus", itemsField: null },
  { path: "/firmwareupdatesession", key: "firmwareUpdateSessions", itemsField: "FirmwareUpdateSessions" },
  { path: "/operation/status", key: "operationStatus", itemsField: null },
  { path: "/networkinterface/1", key: "networkInterface", itemsField: null },
  { path: "/project/contactinfo", key: "projectContactInfo", itemsField: null },
  { path: "/project/masterdevicelist/devices", key: "masterDeviceList", itemsField: "Devices" },
  { path: "/server/status/ping", key: "ping", itemsField: null },
  { path: "/server/leap/pairinglist", key: "pairingList", itemsField: null },
  { path: "/system/away", key: "awayMode", itemsField: null },
  { path: "/system/loadshedding/status", key: "loadShedding", itemsField: null },
  { path: "/system/naturallightoptimization", key: "naturalLight", itemsField: null },
  { path: "/facade", key: "facades", itemsField: "Facades" },
  { path: "/countdowntimer", key: "countdownTimers", itemsField: "CountdownTimers" },
  { path: "/favorite", key: "favorites", itemsField: "Favorites" },
  { path: "/daynightmode", key: "dayNightMode", itemsField: null },
];

/**
 * Walk LEAP endpoints defined in the registry and return raw response data.
 *
 * @param leap - Connected LeapConnection (or any object with readBody method)
 * @param registry - Endpoint definitions to walk
 * @param opts.full - If false, only fetch entries with core=true
 * @param opts.log - Progress logging function
 */
export async function walkEndpoints(
  leap: { readBody(url: string): Promise<any | null> },
  registry: EndpointDef[],
  opts: { full: boolean; log: (msg: string) => void },
): Promise<Record<string, any>> {
  const result: Record<string, any> = {};
  const entries = opts.full ? registry : registry.filter((e) => e.core);

  for (const entry of entries) {
    opts.log(`Fetching ${entry.path}...`);
    const body = await leap.readBody(entry.path);
    if (body === null) {
      opts.log(`  (skipped — no data)`);
      continue;
    }

    // Singleton endpoint (no itemsField)
    if (entry.itemsField === null) {
      result[entry.key] = body;
      opts.log(`  OK (singleton)`);
      continue;
    }

    // Collection endpoint
    const items: any[] = body[entry.itemsField] ?? [];
    if (items.length === 0) {
      opts.log(`  0 items`);
      continue;
    }
    opts.log(`  ${items.length} items`);

    // Fetch children and perItem for each item
    if (entry.children || entry.perItem) {
      for (const item of items) {
        const href = item.href;
        if (!href) continue;

        // Children: associated sub-collections
        if (entry.children) {
          for (const child of entry.children) {
            const childBody = await leap.readBody(`${href}${child.path}`);
            if (childBody !== null) {
              const childItems = childBody[child.itemsField];
              if (childItems !== undefined) {
                item[child.key] = childItems;
              }
            }
          }
        }

        // PerItem: direct sub-resources
        if (entry.perItem) {
          for (const sub of entry.perItem) {
            const subBody = await leap.readBody(`${href}${sub.path}`);
            if (subBody !== null) {
              item[sub.key] = subBody;
            }
          }
        }
      }
    }

    result[entry.key] = items;
  }

  return result;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test test/leap-walker.test.ts`
Expected: All 8 tests PASS

- [ ] **Step 5: Run existing tests to verify no regressions**

Run: `node --import tsx --test test/*.test.ts`
Expected: All existing tests still PASS

- [ ] **Step 6: Run lint and typecheck**

Run: `npx biome check lib/leap-client.ts && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add lib/leap-client.ts test/leap-walker.test.ts
git commit -m "feat(leap): add endpoint registry and walkEndpoints walker

Registry-driven recursive LEAP endpoint walker for exhaustive dumps.
Supports collections, singletons, children, and per-item sub-resources.
35+ endpoints defined covering all known LEAP routes.

Refs: GLAB-56"
```

---

### Task 2: Wire --full Flag Into leap-dump.ts

**Files:**
- Modify: `tools/leap/leap-dump.ts:50-53` (add FULL_OUTPUT flag)
- Modify: `tools/leap/leap-dump.ts:63-93` (branch main() on --full)

- [ ] **Step 1: Add --full flag parsing**

In `tools/leap/leap-dump.ts`, after line 52 (`const SAVE_OUTPUT = hasFlag("--save");`), add:

```typescript
const FULL_OUTPUT = hasFlag("--full");
```

- [ ] **Step 2: Add walkEndpoints import**

In `tools/leap/leap-dump.ts`, update the import from `./leap-client` (lines 24-31) to also import `walkEndpoints` and `LEAP_REGISTRY`:

```typescript
import {
  buildDumpData,
  type DeviceInfo,
  fetchLeapData,
  LEAP_REGISTRY,
  LeapConnection,
  type PresetMapping,
  walkEndpoints,
  type ZoneInfo,
} from "./leap-client";
```

- [ ] **Step 3: Add --full branch in main()**

Replace the `main()` function body (lines 63-93) with:

```typescript
async function main() {
  const leap = new LeapConnection({ host: HOST, certName: CERT_NAME });
  log(`Connecting to ${HOST}:8081 (certs: ${CERT_NAME})...`);
  await leap.connect();
  log("Connected.\n");

  if (FULL_OUTPUT) {
    await runFullDump(leap);
  } else {
    await runStandardDump(leap);
  }

  leap.close();
}

async function runFullDump(leap: LeapConnection) {
  const startTime = Date.now();

  // Get server info for the output envelope
  const serverBody = await leap.readBody("/server");
  const servers = serverBody?.Servers ?? [];
  const leapServer = servers.find((s: any) => s.Type === "LEAP") ?? servers[0] ?? {};
  const leapVersion = leapServer.ProtocolVersion ?? "";
  let productType = "";
  if (leapVersion.startsWith("03.")) productType = "RadioRA3";
  else if (leapVersion.startsWith("01.")) productType = "Caseta";
  else if (leapVersion.startsWith("02.")) productType = "HomeWorks";
  log(`LEAP version=${leapVersion} product=${productType || "(unknown)"}\n`);

  const data = await walkEndpoints(leap, LEAP_REGISTRY, { full: true, log });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const endpointCount = Object.keys(data).length;
  log(`\nDone: ${endpointCount} endpoints in ${elapsed}s`);

  const output = {
    timestamp: new Date().toISOString(),
    host: HOST,
    leapVersion,
    productType,
    data,
  };

  if (SAVE_OUTPUT) {
    mkdirSync(DATA_DIR, { recursive: true });
    const filePath = join(DATA_DIR, `leap-${HOST}-full.json`);
    writeFileSync(filePath, JSON.stringify(output, null, 2) + "\n");
    log(`Saved to ${filePath}`);
  }

  if (JSON_OUTPUT) {
    console.log(JSON.stringify(output, null, 2));
  } else if (!SAVE_OUTPUT) {
    // Human-readable summary
    console.log("\n=== LEAP Full Dump Summary ===\n");
    for (const [key, value] of Object.entries(data)) {
      const count = Array.isArray(value) ? value.length : 1;
      const label = Array.isArray(value) ? `${count} items` : "(singleton)";
      console.log(`  ${key.padEnd(28)} ${label}`);
    }
    console.log(`\n  Total time: ${elapsed}s`);
  }
}

async function runStandardDump(leap: LeapConnection) {
  const result = await fetchLeapData(leap, log);

  log("");
  const { zones, devices, presets } = result;

  // Save to JSON file
  if (SAVE_OUTPUT) {
    const dumpData = buildDumpData(HOST, result);
    mkdirSync(DATA_DIR, { recursive: true });
    const filePath = join(DATA_DIR, `leap-${HOST}.json`);
    writeFileSync(filePath, JSON.stringify(dumpData, null, 2) + "\n");
    log(`Saved to ${filePath}`);
  }

  // --- Output ---
  if (JSON_OUTPUT) {
    const dumpData = buildDumpData(HOST, result);
    console.log(JSON.stringify(dumpData, null, 2));
  } else if (CONFIG_OUTPUT) {
    printConfigOutput(zones, devices, presets);
  } else {
    printHumanOutput(zones, devices, presets);
  }
}
```

- [ ] **Step 4: Run lint and typecheck**

Run: `npx biome check tools/leap/leap-dump.ts lib/leap-client.ts && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Run all tests**

Run: `node --import tsx --test test/*.test.ts`
Expected: All tests PASS (including new walker tests)

- [ ] **Step 6: Commit**

```bash
git add tools/leap/leap-dump.ts
git commit -m "feat(leap): wire --full flag into leap-dump.ts

--full runs exhaustive walk of all LEAP endpoints.
--full --save writes data/leap-{host}-full.json.
--full --json outputs full JSON to stdout.
--full alone prints human-readable summary.
Existing modes (--save, --json, --config) unchanged.

Refs: GLAB-56"
```

---

### Task 3: Live Test Against RA3 Processor

This task requires network access to the RA3 processor at 10.0.0.1.

**Files:** None modified — validation only.

- [ ] **Step 1: Verify existing dump still works**

Run: `npx tsx tools/leap/leap-dump.ts --save 2>&1 | tail -5`
Expected: Connects, dumps, saves to `data/leap-10.0.0.1.json` — same as before.

- [ ] **Step 2: Run full dump in summary mode**

Run: `npx tsx tools/leap/leap-dump.ts --full 2>&1`
Expected: Progress log showing each endpoint, then summary table with item counts and total time. Some endpoints will show "(skipped — no data)" — that's expected for RA3 (e.g. `/occupancygroup` returns 204).

- [ ] **Step 3: Run full dump with --save**

Run: `npx tsx tools/leap/leap-dump.ts --full --save 2>&1`
Expected: Saves to `data/leap-10.0.0.1-full.json`. File should be larger than the standard dump.

- [ ] **Step 4: Inspect the full dump output**

Run: `node -e "const d = require('./data/leap-10.0.0.1-full.json'); console.log(Object.keys(d.data).join(', ')); for (const [k,v] of Object.entries(d.data)) console.log(k, Array.isArray(v) ? v.length + ' items' : typeof v)"`
Expected: Multiple endpoint keys with item counts. At minimum: server, links, areas (with nested zones/controlStations), project.

- [ ] **Step 5: Verify full dump has nested children**

Run: `node -e "const d = require('./data/leap-10.0.0.1-full.json'); const office = d.data.areas?.find(a => a.Name === 'Office'); console.log('Office zones:', office?.zones?.length ?? 'none'); console.log('Office controlStations:', office?.controlStations?.length ?? 'none')"`
Expected: Shows zone and control station counts for the Office area.

- [ ] **Step 6: Test against Caseta (if available)**

Run: `npx tsx tools/leap/leap-dump.ts --full --host 10.0.0.2 --certs caseta --save 2>&1`
Expected: Saves to `data/leap-10.0.0.2-full.json`. Caseta should have more endpoints returning data (presetassignment, programmingmodel, occupancygroup, facade, countdowntimer).

- [ ] **Step 7: Commit the full dump data files**

```bash
git add data/leap-*-full.json
git commit -m "data: add exhaustive LEAP dumps for RA3 and Caseta

Full endpoint walks capturing all known LEAP data.

Refs: GLAB-56"
```

---

### Task 4: Final CI Check

- [ ] **Step 1: Run full CI suite**

Run: `npm run lint && npx tsc --noEmit && node --import tsx --test test/*.test.ts`
Expected: All green — lint, typecheck, tests.

- [ ] **Step 2: Final commit if any fixups needed**

Only if previous steps required changes.
