import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
  buildDumpData,
  fetchLeapData,
  hrefId,
  LeapConnection,
  type LeapDumpData,
} from "../lib/leap-client";

// LeapConnection internals are private; tests reach them with a narrow cast.
type ConnInternals = {
  buffer: string;
  tagCounter: number;
  pendingRequests: Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >;
  handleData(data: string): void;
  nextTag(): string;
};
const internals = (conn: LeapConnection): ConnInternals =>
  conn as unknown as ConnInternals;

// ── MockLeap — duck-typed stand-in for LeapConnection ────────────

class MockLeap {
  private responses: Record<string, unknown>;
  readonly readCalls: string[] = [];

  constructor(responses: Record<string, unknown>) {
    this.responses = responses;
  }

  async readBody(url: string): Promise<unknown> {
    this.readCalls.push(url);
    return url in this.responses ? this.responses[url] : null;
  }
}

// ── hrefId ────────────────────────────────────────────────────────

describe("hrefId", () => {
  test("extracts numeric id from href path", () => {
    assert.equal(hrefId("/zone/518"), 518);
    assert.equal(hrefId("/device/42"), 42);
    assert.equal(hrefId("/area/1"), 1);
  });

  test("returns 0 for non-matching href", () => {
    assert.equal(hrefId("/"), 0);
    assert.equal(hrefId("/zone"), 0);
    assert.equal(hrefId(""), 0);
  });

  test("matches trailing digits only", () => {
    // hrefId matches the last /\d+$
    assert.equal(hrefId("/area/1/associatedzone/5"), 5);
  });
});

// ── fetchLeapData: RA3 vs Caseta auto-detection ──────────────────

describe("fetchLeapData auto-detection", () => {
  test("RA3: /zone returns null (405) → falls back to area walk", async () => {
    const mock = new MockLeap({
      "/server": {
        Servers: [{ Type: "LEAP", ProtocolVersion: "03.247.2710" }],
      },
      "/link": {
        Links: [
          {
            LinkType: "RF",
            RFProperties: { Channel: 7, SubnetAddress: 128 },
          },
        ],
      },
      // /zone returns null (RA3 returns 405 Method Not Allowed → readBody returns null)
      "/area": {
        Areas: [{ href: "/area/1", Name: "Office", IsLeaf: true }],
      },
      "/area/1/associatedzone": {
        Zones: [
          {
            href: "/zone/100",
            Name: "Main Light",
            ControlType: "Dimmed",
          },
        ],
      },
      "/area/1/associatedcontrolstation": { ControlStations: [] },
      "/project": { Project: { MasterDeviceList: { Devices: [] } } },
    });

    const result = await fetchLeapData(mock as never);

    assert.equal(result.leapVersion, "03.247.2710");
    assert.equal(result.productType, "RadioRA3");
    assert.equal(result.zones.length, 1);
    assert.equal(result.zones[0].id, 100);
    assert.equal(result.zones[0].name, "Main Light");
    assert.equal(result.zones[0].area, "Office");
    assert.equal(result.link.rf?.channel, 7);
    assert.equal(result.link.rf?.subnetAddress, 128);

    // Must have probed /zone before falling back to area walk
    assert.ok(mock.readCalls.includes("/zone"));
    assert.ok(mock.readCalls.includes("/area"));
  });

  test("Caseta: /zone returns zones → uses direct path", async () => {
    const mock = new MockLeap({
      "/server": { Servers: [{ Type: "LEAP", ProtocolVersion: "01.45" }] },
      "/link": {
        Links: [
          {
            LinkType: "RF",
            RFProperties: { Channel: 7 },
          },
        ],
      },
      "/zone": {
        Zones: [
          {
            href: "/zone/5",
            Name: "Kitchen",
            ControlType: "Dimmed",
          },
        ],
      },
      "/device": { Devices: [] },
      "/project": { Project: { MasterDeviceList: { Devices: [] } } },
    });

    const result = await fetchLeapData(mock as never);

    assert.equal(result.productType, "Caseta");
    assert.equal(result.zones.length, 1);
    assert.equal(result.zones[0].id, 5);
    // Must NOT have walked /area — direct path is used when /zone returns data
    assert.ok(!mock.readCalls.includes("/area"));
  });

  test("HomeWorks: 02.xxx version detected", async () => {
    const mock = new MockLeap({
      "/server": { Servers: [{ Type: "LEAP", ProtocolVersion: "02.100" }] },
      "/link": { Links: [] },
      "/area": { Areas: [] },
      "/project": { Project: { MasterDeviceList: { Devices: [] } } },
    });

    const result = await fetchLeapData(mock as never);
    assert.equal(result.productType, "HomeWorks");
  });

  test("unknown version leaves productType empty", async () => {
    const mock = new MockLeap({
      "/server": { Servers: [{ Type: "LEAP", ProtocolVersion: "99.x" }] },
      "/link": { Links: [] },
      "/area": { Areas: [] },
      "/project": { Project: { MasterDeviceList: { Devices: [] } } },
    });

    const result = await fetchLeapData(mock as never);
    assert.equal(result.productType, "");
  });
});

// ── fetchLinkInfo: RF and CCX parsing ────────────────────────────

describe("link info parsing", () => {
  test("parses both RF and CCX link properties", async () => {
    const mock = new MockLeap({
      "/server": {
        Servers: [{ Type: "LEAP", ProtocolVersion: "03.247" }],
      },
      "/link": {
        Links: [
          {
            LinkType: "RF",
            RFProperties: { Channel: 7, SubnetAddress: 128 },
          },
          {
            LinkType: "ClearConnectTypeX",
            ClearConnectTypeXLinkProperties: {
              Channel: 25,
              PANID: 0x1234,
              ExtendedPANID: "aabbccddeeff0011",
              NetworkMasterKey: "00112233445566778899aabbccddeeff",
            },
          },
        ],
      },
      "/area": { Areas: [] },
      "/project": { Project: { MasterDeviceList: { Devices: [] } } },
    });

    const result = await fetchLeapData(mock as never);

    assert.equal(result.link.rf?.channel, 7);
    assert.equal(result.link.rf?.subnetAddress, 128);
    assert.equal(result.link.ccx?.channel, 25);
    assert.equal(result.link.ccx?.panId, 0x1234);
    assert.equal(result.link.ccx?.extPanId, "aabbccddeeff0011");
    assert.equal(
      result.link.ccx?.masterKey,
      "00112233445566778899aabbccddeeff",
    );
  });

  test("missing SubnetAddress omitted from rf object", async () => {
    const mock = new MockLeap({
      "/server": { Servers: [{ Type: "LEAP", ProtocolVersion: "01.45" }] },
      "/link": {
        Links: [{ LinkType: "RF", RFProperties: { Channel: 7 } }],
      },
      "/zone": { Zones: [] },
      "/device": { Devices: [] },
      "/project": { Project: { MasterDeviceList: { Devices: [] } } },
    });

    const result = await fetchLeapData(mock as never);
    assert.equal(result.link.rf?.channel, 7);
    assert.equal(result.link.rf?.subnetAddress, undefined);
  });

  test("link missing entirely → empty link object", async () => {
    const mock = new MockLeap({
      "/server": { Servers: [{ Type: "LEAP", ProtocolVersion: "03.247" }] },
      // /link missing → readBody returns null → no Links
      "/area": { Areas: [] },
      "/project": { Project: { MasterDeviceList: { Devices: [] } } },
    });

    const result = await fetchLeapData(mock as never);
    assert.equal(result.link.rf, undefined);
    assert.equal(result.link.ccx, undefined);
  });
});

// ── fetchViaAreaWalk: RA3 device metadata stitching ──────────────

describe("RA3 area walk", () => {
  test("stitches area + controlstation metadata onto devices", async () => {
    const mock = new MockLeap({
      "/server": { Servers: [{ Type: "LEAP", ProtocolVersion: "03.247" }] },
      "/link": { Links: [] },
      "/area": {
        Areas: [{ href: "/area/1", Name: "Bedroom", IsLeaf: true }],
      },
      "/area/1/associatedzone": {
        Zones: [
          {
            href: "/zone/10",
            Name: "Ceiling",
            ControlType: "Dimmed",
          },
        ],
      },
      "/area/1/associatedcontrolstation": {
        ControlStations: [
          {
            Name: "Entry Keypad",
            AssociatedGangedDevices: [{ Device: { href: "/device/42" } }],
          },
        ],
      },
      "/device/42": {
        Device: {
          Name: "Sunnata Keypad",
          DeviceType: "SunnataKeypad",
          SerialNumber: 12345678,
          ModelNumber: "RRST-W4B-XX",
        },
      },
      "/device/42/buttongroup": { ButtonGroups: [] },
      "/project": { Project: { MasterDeviceList: { Devices: [] } } },
    });

    const result = await fetchLeapData(mock as never);

    assert.equal(result.devices.length, 1);
    const dev = result.devices[0];
    assert.equal(dev.id, 42);
    assert.equal(dev.station, "Entry Keypad");
    assert.equal(dev.area, "Bedroom");
    assert.equal(dev.serial, 12345678);
  });

  test("non-leaf areas are skipped", async () => {
    const mock = new MockLeap({
      "/server": { Servers: [{ Type: "LEAP", ProtocolVersion: "03.247" }] },
      "/link": { Links: [] },
      "/area": {
        Areas: [
          { href: "/area/1", Name: "Root", IsLeaf: false },
          { href: "/area/2", Name: "Office", IsLeaf: true },
        ],
      },
      "/area/2/associatedzone": {
        Zones: [{ href: "/zone/20", Name: "Desk Lamp", ControlType: "Dimmed" }],
      },
      "/area/2/associatedcontrolstation": { ControlStations: [] },
      "/project": { Project: { MasterDeviceList: { Devices: [] } } },
    });

    const result = await fetchLeapData(mock as never);

    // Only the leaf area's zones should be walked
    assert.equal(result.zones.length, 1);
    assert.equal(result.zones[0].area, "Office");
    // /area/1/associatedzone must NOT have been fetched
    assert.ok(!mock.readCalls.includes("/area/1/associatedzone"));
  });
});

// ── fetchViaDirect: Caseta device area resolution ────────────────

describe("Caseta direct path", () => {
  test("resolves device area via AssociatedArea href lookup", async () => {
    const mock = new MockLeap({
      "/server": { Servers: [{ Type: "LEAP", ProtocolVersion: "01.45" }] },
      "/link": { Links: [] },
      "/zone": {
        Zones: [
          {
            href: "/zone/5",
            Name: "Kitchen",
            ControlType: "Dimmed",
            Device: { href: "/device/7" },
          },
        ],
      },
      "/device": {
        Devices: [
          {
            href: "/device/7",
            AssociatedArea: { href: "/area/3" },
          },
        ],
      },
      "/area/3": { Area: { Name: "Kitchen" } },
      "/device/7": {
        Device: {
          Name: "Caseta Dimmer",
          DeviceType: "WallDimmer",
          SerialNumber: 987654,
        },
      },
      "/device/7/buttongroup": { ButtonGroups: [] },
      "/project": { Project: { MasterDeviceList: { Devices: [] } } },
    });

    const result = await fetchLeapData(mock as never);

    assert.equal(result.zones.length, 1);
    assert.equal(result.zones[0].area, "Kitchen");
    assert.equal(result.devices[0].area, "Kitchen");
  });
});

// ── buildDumpData: aggregation + dedup ───────────────────────────

describe("buildDumpData", () => {
  const baseResult = {
    zones: [
      { id: 100, name: "Main", controlType: "Dimmed", area: "Office" },
      {
        id: 101,
        name: "Desk",
        controlType: "Dimmed",
        area: "Office",
        deviceSerial: 42,
      },
    ],
    devices: [
      {
        id: 7,
        name: "Keypad",
        type: "SunnataKeypad",
        serial: 12345678,
        station: "Entry",
        area: "Office",
      },
    ],
    presets: [
      {
        presetId: 500,
        buttonId: 1,
        buttonNumber: 1,
        buttonName: "Scene A",
        engraving: "Morning",
        programmingModelType: "SingleAction",
        presetRole: "single" as const,
        deviceId: 7,
        deviceName: "Keypad",
        deviceType: "SunnataKeypad",
        serialNumber: 12345678,
        stationName: "Entry",
        areaName: "Office",
      },
    ],
    link: {},
    leapVersion: "03.247",
    productType: "RadioRA3",
  };

  test("builds zones map keyed by id", () => {
    const dump = buildDumpData("10.0.0.1", baseResult);
    assert.equal(dump.zones["100"].name, "Main");
    assert.equal(dump.zones["101"].deviceSerial, 42);
  });

  test("serial filter: excludes 0xFFFFFFFF and zero", () => {
    const dump = buildDumpData("10.0.0.1", {
      ...baseResult,
      devices: [
        ...baseResult.devices,
        {
          id: 8,
          name: "Phantom",
          type: "Unknown",
          serial: 0xffffffff,
          station: "",
          area: "",
        },
        {
          id: 9,
          name: "Zero",
          type: "Unknown",
          serial: 0,
          station: "",
          area: "",
        },
      ],
    });
    assert.ok("12345678" in dump.serials);
    assert.ok(!((0xffffffff).toString() in dump.serials));
    // Zero is falsy, not kept
    assert.ok(!("0" in dump.serials));
  });

  test("serials use 'area station type' when station is set", () => {
    const dump = buildDumpData("10.0.0.1", baseResult);
    assert.equal(dump.serials["12345678"].name, "Office Entry SunnataKeypad");
  });

  test("serials fall back to device name when station is blank", () => {
    const dump = buildDumpData("10.0.0.1", {
      ...baseResult,
      devices: [
        {
          id: 7,
          name: "Lone Device",
          type: "Unknown",
          serial: 777,
          station: "",
          area: "",
        },
      ],
    });
    assert.equal(dump.serials["777"].name, "Lone Device");
  });

  test("presets dedup by presetId (first-seen wins)", () => {
    const dump = buildDumpData("10.0.0.1", {
      ...baseResult,
      presets: [
        // Two references to the same presetId — second should be dropped
        {
          ...baseResult.presets[0],
          presetId: 500,
          buttonName: "First",
          engraving: "Keep Me",
        },
        {
          ...baseResult.presets[0],
          presetId: 500,
          buttonName: "Second",
          engraving: "Drop Me",
        },
      ],
    });
    assert.equal(dump.presets["500"].name, "Keep Me");
  });

  test("preset name prefers engraving over buttonName", () => {
    const dump = buildDumpData("10.0.0.1", baseResult);
    assert.equal(dump.presets["500"].name, "Morning");
  });

  test("preset name falls back to buttonName when engraving absent", () => {
    const dump = buildDumpData("10.0.0.1", {
      ...baseResult,
      presets: [{ ...baseResult.presets[0], engraving: undefined }],
    });
    assert.equal(dump.presets["500"].name, "Scene A");
  });

  test("host and productType carry through", () => {
    const dump: LeapDumpData = buildDumpData("10.1.1.133", baseResult);
    assert.equal(dump.host, "10.1.1.133");
    assert.equal(dump.productType, "RadioRA3");
    assert.equal(dump.leapVersion, "03.247");
    assert.ok(dump.timestamp.length > 0);
  });
});

// ── LeapConnection: tag pairing + buffer splitting ───────────────

describe("LeapConnection message framing", () => {
  // Constructor requires a configured host — use the example config entry.
  // connect() is never called, so cert files don't need to exist.
  const makeConn = () => new LeapConnection({ host: "10.x.x.x" });

  test("rejects construction when host is not in config", () => {
    assert.throws(
      () => new LeapConnection({ host: "192.168.99.99" }),
      /No certs configured/,
    );
  });

  test("nextTag produces monotonically increasing lt-N tags", () => {
    const conn = makeConn();
    const i = internals(conn);
    assert.equal(i.nextTag(), "lt-1");
    assert.equal(i.nextTag(), "lt-2");
    assert.equal(i.nextTag(), "lt-3");
  });

  test("handleData resolves pending request by ClientTag", async () => {
    const conn = makeConn();
    const i = internals(conn);

    const received = new Promise((resolve, reject) => {
      i.pendingRequests.set("lt-1", { resolve, reject });
    });

    i.handleData(
      JSON.stringify({
        Header: { ClientTag: "lt-1", StatusCode: "200 OK" },
        Body: { value: 42 },
      }) + "\n",
    );

    const resp = (await received) as { Body: { value: number } };
    assert.equal(resp.Body.value, 42);
    assert.equal(i.pendingRequests.size, 0, "pending map should be drained");
  });

  test("handleData buffers partial lines until newline arrives", async () => {
    const conn = makeConn();
    const i = internals(conn);

    const received = new Promise((resolve, reject) => {
      i.pendingRequests.set("lt-5", { resolve, reject });
    });

    const full =
      JSON.stringify({ Header: { ClientTag: "lt-5" }, Body: { ok: true } }) +
      "\n";
    // Feed first half — no newline yet, nothing should resolve
    i.handleData(full.slice(0, 20));
    assert.equal(i.pendingRequests.size, 1, "request still pending mid-chunk");

    // Feed the rest
    i.handleData(full.slice(20));
    const resp = (await received) as { Body: { ok: boolean } };
    assert.equal(resp.Body.ok, true);
  });

  test("handleData routes unsolicited messages to onEvent", () => {
    const conn = makeConn();
    const events: unknown[] = [];
    conn.onEvent = (msg) => events.push(msg);

    internals(conn).handleData(
      JSON.stringify({
        CommuniqueType: "SubscribeResponse",
        Header: { Url: "/zone/5/status" },
        Body: { Zone: { Level: 75 } },
      }) + "\n",
    );

    assert.equal(events.length, 1);
    const evt = events[0] as { Body: { Zone: { Level: number } } };
    assert.equal(evt.Body.Zone.Level, 75);
  });

  test("handleData does not fire onEvent for tagged responses", () => {
    const conn = makeConn();
    const events: unknown[] = [];
    conn.onEvent = (msg) => events.push(msg);

    const i = internals(conn);
    i.pendingRequests.set("lt-7", {
      resolve: () => {},
      reject: () => {},
    });

    i.handleData(
      JSON.stringify({ Header: { ClientTag: "lt-7" }, Body: {} }) + "\n",
    );

    assert.equal(events.length, 0);
  });

  test("handleData swallows malformed JSON without throwing", () => {
    const conn = makeConn();
    const i = internals(conn);
    // Must not throw
    i.handleData("not json at all\n");
    i.handleData("{ partial broken\n");
    // Internal state stays clean
    assert.equal(i.buffer, "");
  });

  test("handleData handles multiple messages in one chunk", async () => {
    const conn = makeConn();
    const i = internals(conn);

    const got1 = new Promise((resolve, reject) => {
      i.pendingRequests.set("lt-1", { resolve, reject });
    });
    const got2 = new Promise((resolve, reject) => {
      i.pendingRequests.set("lt-2", { resolve, reject });
    });

    const batch =
      JSON.stringify({ Header: { ClientTag: "lt-1" }, Body: { n: 1 } }) +
      "\n" +
      JSON.stringify({ Header: { ClientTag: "lt-2" }, Body: { n: 2 } }) +
      "\n";
    i.handleData(batch);

    const r1 = (await got1) as { Body: { n: number } };
    const r2 = (await got2) as { Body: { n: number } };
    assert.equal(r1.Body.n, 1);
    assert.equal(r2.Body.n, 2);
  });

  test("send() rejects when socket is not connected", async () => {
    const conn = makeConn();
    await assert.rejects(() => conn.read("/server"), /Not connected/);
  });
});
