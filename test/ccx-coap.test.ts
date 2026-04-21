import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  CcxCoapClient,
  coapCodeClass,
  coapCodeFromNumber,
  coapCodeToNumber,
  formatCoapTarget,
  generateScanPaths,
  hexPayloadToBuffer,
  level16ToPercent,
  parseCoapBroadcast,
  parseCoapGetResponse,
  percentToLevel16,
  TRIM_MAX,
} from "../lib/ccx-coap";

test("formatCoapTarget renders rloc, serial, and ipv6 targets", () => {
  assert.equal(formatCoapTarget({ kind: "rloc", rloc: "4800" }), "rloc:4800");
  assert.equal(
    formatCoapTarget({ kind: "serial", serial: 72200096 }),
    "serial:72200096",
  );
  assert.equal(
    formatCoapTarget({ kind: "ipv6", addr: "fd0d:2ef:a82c::ff:fe00:4800" }),
    "fd0d:2ef:a82c::ff:fe00:4800",
  );
});

test("formatCoapTarget resolves serial to secondary ML-EID when an address resolver is provided", () => {
  const resolver = (serial: number) =>
    serial === 71148018 ? "fd00::e079:8dff:fe92:85fe" : undefined;
  assert.equal(
    formatCoapTarget({ kind: "serial", serial: 71148018 }, resolver),
    "fd00::e079:8dff:fe92:85fe",
  );
  // Unknown serial falls back to the legacy serial:N form
  assert.equal(
    formatCoapTarget({ kind: "serial", serial: 99999999 }, resolver),
    "serial:99999999",
  );
  // No resolver → legacy behavior preserved
  assert.equal(
    formatCoapTarget({ kind: "serial", serial: 71148018 }),
    "serial:71148018",
  );
});

test("percentToLevel16 matches documented formula raw = percent * 0xFEFF / 100", () => {
  assert.equal(percentToLevel16(0), 0);
  assert.equal(percentToLevel16(100), TRIM_MAX);
  assert.equal(percentToLevel16(50), Math.round((50 * TRIM_MAX) / 100));
  assert.equal(percentToLevel16(1), Math.round(TRIM_MAX / 100));
});

test("level16ToPercent inverts percentToLevel16 within rounding", () => {
  for (const p of [0, 1, 25, 50, 75, 99, 100]) {
    const raw = percentToLevel16(p);
    const back = level16ToPercent(raw);
    assert.ok(Math.abs(back - p) < 0.01, `roundtrip ${p}% → ${raw} → ${back}%`);
  }
});

test("percentToLevel16 rejects out-of-range percentages", () => {
  assert.throws(() => percentToLevel16(-0.1));
  assert.throws(() => percentToLevel16(100.1));
});

test("coapCodeToNumber and coapCodeFromNumber round-trip", () => {
  assert.equal(coapCodeToNumber("2.05"), (2 << 5) | 5);
  assert.equal(coapCodeFromNumber((2 << 5) | 5), "2.05");
  assert.equal(coapCodeToNumber("4.04"), (4 << 5) | 4);
  assert.equal(coapCodeFromNumber((4 << 5) | 4), "4.04");
  assert.equal(coapCodeClass("2.05"), 2);
  assert.equal(coapCodeClass("4.04"), 4);
});

test("hexPayloadToBuffer parses space-separated hex bytes", () => {
  assert.equal(hexPayloadToBuffer("01 02 FF").toString("hex"), "0102ff");
  assert.equal(hexPayloadToBuffer("").length, 0);
  assert.equal(hexPayloadToBuffer("0a").toString("hex"), "0a");
});

test("parseCoapGetResponse handles successful response with payload", () => {
  const text = [
    "CoAP GET cg/db/ct/c/AAI → waiting...",
    "CoAP response code=2.05 mid=0x1234 from fd0d:2ef:a82c::ff:fe00:4800",
    "Payload (5 bytes): 82 03 A1 02 18",
  ].join("\r\n");

  const r = parseCoapGetResponse(text);
  assert.ok(r && r.kind === "response");
  assert.equal(r.code, "2.05");
  assert.equal(r.mid, 0x1234);
  assert.equal(r.src, "fd0d:2ef:a82c::ff:fe00:4800");
  assert.equal(r.payload.toString("hex"), "8203a10218");
  assert.equal(r.ok, true);
});

test("parseCoapGetResponse handles successful response with no payload", () => {
  const text = [
    "CoAP GET cg/nt/able → waiting...",
    "CoAP response code=0.00 mid=0x0042 from fd0d:2ef:a82c::ff:fe00:4800",
    "(no payload)",
  ].join("\r\n");

  const r = parseCoapGetResponse(text);
  assert.ok(r && r.kind === "response");
  assert.equal(r.code, "0.00");
  assert.equal(r.mid, 0x0042);
  assert.equal(r.payload.length, 0);
  assert.equal(r.ok, false);
});

test("parseCoapGetResponse handles 4.04 not found", () => {
  const text = [
    "CoAP GET cg/db/ct/c/AAA → waiting...",
    "CoAP response code=4.04 mid=0x0100 from fd0d:2ef:a82c::ff:fe00:4800",
    "(no payload)",
  ].join("\r\n");

  const r = parseCoapGetResponse(text);
  assert.ok(r && r.kind === "response");
  assert.equal(r.code, "4.04");
  assert.equal(r.ok, false);
});

test("parseCoapGetResponse handles timeout", () => {
  const text = [
    "CoAP GET cg/db/ct/c/AAA → waiting...",
    "No CoAP response (timeout 5s)",
  ].join("\r\n");

  const r = parseCoapGetResponse(text);
  assert.ok(r && r.kind === "timeout");
});

test("parseCoapGetResponse handles TX failure", () => {
  const text = "CoAP TX failed (not joined?)";
  const r = parseCoapGetResponse(text);
  assert.ok(r && r.kind === "error");
  assert.match(r.message, /TX failed/);
});

test("parseCoapGetResponse handles invalid address", () => {
  const text = "Invalid address (use IPv6, rloc:XXXX, or serial:NNN)";
  const r = parseCoapGetResponse(text);
  assert.ok(r && r.kind === "error");
  assert.match(r.message, /Invalid address/);
});

test("parseCoapGetResponse returns null on incomplete text", () => {
  const text = "CoAP GET foo/bar → waiting...";
  assert.equal(parseCoapGetResponse(text), null);
});

test("parseCoapBroadcast parses [coap] notification with path", () => {
  const n = parseCoapBroadcast("[coap] 2.05 cg/db/ct/c/AAI mid=0x9abc len=5");
  assert.ok(n);
  assert.equal(n.code, "2.05");
  assert.equal(n.path, "cg/db/ct/c/AAI");
  assert.equal(n.mid, 0x9abc);
  assert.equal(n.len, 5);
});

test("parseCoapBroadcast parses [coap] notification without path", () => {
  const n = parseCoapBroadcast("[coap] 4.04 mid=0x0001 len=0");
  assert.ok(n);
  assert.equal(n.code, "4.04");
  assert.equal(n.path, "");
  assert.equal(n.mid, 1);
  assert.equal(n.len, 0);
});

test("parseCoapBroadcast returns null for non-matching lines", () => {
  assert.equal(parseCoapBroadcast("CoAP GET foo → waiting..."), null);
  assert.equal(parseCoapBroadcast("random text"), null);
});

test("generateScanPaths expands base with default A-Z suffixes", () => {
  const paths = generateScanPaths("cg/db/ct/c/AA");
  assert.equal(paths.length, 26);
  assert.equal(paths[0], "cg/db/ct/c/AAA");
  assert.equal(paths[25], "cg/db/ct/c/AAZ");
});

test("generateScanPaths accepts custom suffix list", () => {
  const paths = generateScanPaths("cg/db/pr/c/", ["01", "02", "03"]);
  assert.deepEqual(paths, ["cg/db/pr/c/01", "cg/db/pr/c/02", "cg/db/pr/c/03"]);
});

// ── CcxCoapClient with mock transport ─────────────────

class MockTransport extends EventEmitter {
  public sent: string[] = [];
  public started = false;
  public closed = false;

  async start(): Promise<void> {
    this.started = true;
  }

  sendText(text: string): Promise<void> {
    this.sent.push(text);
    return Promise.resolve();
  }

  close(): void {
    this.closed = true;
  }

  emitText(text: string): void {
    this.emit("text", text);
  }
}

test("CcxCoapClient.get sends 'ccx coap get' and parses response", async () => {
  const transport = new MockTransport();
  const client = new CcxCoapClient(transport);
  await client.connect();

  const target = { kind: "rloc" as const, rloc: "4800" };
  const pending = client.get(target, "cg/db/ct/c/AAI", { timeoutMs: 500 });

  // Simulate firmware reply arriving in one chunk
  setImmediate(() => {
    transport.emitText(
      [
        "CoAP GET cg/db/ct/c/AAI → waiting...",
        "CoAP response code=2.05 mid=0x1234 from fd0d:2ef:a82c::ff:fe00:4800",
        "Payload (3 bytes): 82 03 A1",
      ].join("\r\n") + "\r\n",
    );
  });

  const resp = await pending;
  assert.equal(transport.sent[0], "ccx coap get rloc:4800 cg/db/ct/c/AAI");
  assert.equal(resp.code, "2.05");
  assert.equal(resp.payload.toString("hex"), "8203a1");
  assert.equal(resp.ok, true);
  client.close();
});

test("CcxCoapClient.get handles chunked text arrivals", async () => {
  const transport = new MockTransport();
  const client = new CcxCoapClient(transport);
  await client.connect();

  const pending = client.get(
    { kind: "serial" as const, serial: 12345 },
    "fw/ic/md",
    {
      timeoutMs: 500,
    },
  );

  setImmediate(() => {
    transport.emitText("CoAP GET fw/ic/md → waiting...\r\n");
    transport.emitText("CoAP response code=2.05 mid=0x0001 from fd0d::1\r\n");
    transport.emitText("Payload (2 bytes): 01 02\r\n");
  });

  const resp = await pending;
  assert.equal(transport.sent[0], "ccx coap get serial:12345 fw/ic/md");
  assert.equal(resp.payload.toString("hex"), "0102");
  client.close();
});

test("CcxCoapClient.get rejects on timeout error from firmware", async () => {
  const transport = new MockTransport();
  const client = new CcxCoapClient(transport);
  await client.connect();

  const pending = client.get({ kind: "rloc" as const, rloc: "dead" }, "nope", {
    timeoutMs: 500,
  });

  setImmediate(() => {
    transport.emitText(
      "CoAP GET nope → waiting...\r\nNo CoAP response (timeout 5s)\r\n",
    );
  });

  await assert.rejects(pending, /timeout/i);
  client.close();
});

test("CcxCoapClient.put sends PUT command with hex payload", async () => {
  const transport = new MockTransport();
  const client = new CcxCoapClient(transport);
  await client.connect();

  const pending = client.put(
    { kind: "rloc" as const, rloc: "1234" },
    "cg/db/ct/c/AHA",
    Buffer.from("82186ca20418e5051819", "hex"),
    { timeoutMs: 500 },
  );

  setImmediate(() => {
    transport.emitText("CoAP PUT cg/db/ct/c/AHA (10 bytes) → waiting...\r\n");
    transport.emitText(
      "CoAP response code=2.04 mid=0x0042\r\n(no payload)\r\n",
    );
  });

  const resp = await pending;
  assert.equal(
    transport.sent[0],
    "ccx coap put rloc:1234 cg/db/ct/c/AHA 82186CA20418E5051819",
  );
  assert.equal(resp.code, "2.04");
  assert.equal(resp.ok, true);
  client.close();
});

test("CcxCoapClient.probe fires and resolves on OK without waiting for response", async () => {
  const transport = new MockTransport();
  const client = new CcxCoapClient(transport);
  await client.connect();

  const pending = client.probe(
    { kind: "rloc" as const, rloc: "4800" },
    "fw/ic/md",
  );

  setImmediate(() => {
    transport.emitText("OK\r\n");
  });

  await pending;
  assert.equal(transport.sent[0], "ccx coap probe rloc:4800 fw/ic/md");
  client.close();
});

test("CcxCoapClient.scan iterates suffixes and classifies results", async () => {
  const transport = new MockTransport();
  const client = new CcxCoapClient(transport);
  await client.connect();

  const target = { kind: "rloc" as const, rloc: "4800" };
  const pending = client.scan(target, "cg/db/ct/c/AA", {
    suffixes: ["A", "I", "Z"],
    timeoutMs: 500,
  });

  const replies = [
    [
      "CoAP GET cg/db/ct/c/AAA → waiting...",
      "CoAP response code=4.04 mid=0x0001 from fd0d::1",
      "(no payload)",
    ].join("\r\n"),
    [
      "CoAP GET cg/db/ct/c/AAI → waiting...",
      "CoAP response code=0.00 mid=0x0002 from fd0d::1",
      "(no payload)",
    ].join("\r\n"),
    [
      "CoAP GET cg/db/ct/c/AAZ → waiting...",
      "No CoAP response (timeout 5s)",
    ].join("\r\n"),
  ];

  let i = 0;
  const originalSend = transport.sendText.bind(transport);
  transport.sendText = async (text: string) => {
    await originalSend(text);
    const reply = replies[i++];
    setImmediate(() => transport.emitText(reply + "\r\n"));
  };

  const result = await pending;
  assert.deepEqual(
    result.found.map((f) => f.path),
    ["cg/db/ct/c/AAI"],
  );
  assert.deepEqual(result.missing, ["cg/db/ct/c/AAA"]);
  assert.deepEqual(result.timeout, ["cg/db/ct/c/AAZ"]);
  client.close();
});

test("CcxCoapClient.scan reports progress", async () => {
  const transport = new MockTransport();
  const client = new CcxCoapClient(transport);
  await client.connect();

  const target = { kind: "rloc" as const, rloc: "4800" };
  const progress: Array<[number, number, string]> = [];

  const pending = client.scan(target, "cg/db/ct/c/AA", {
    suffixes: ["A", "B"],
    timeoutMs: 500,
    onProgress: (done, total, path) => progress.push([done, total, path]),
  });

  const replies = [
    "CoAP GET cg/db/ct/c/AAA → waiting...\r\nCoAP response code=4.04 mid=0x1 from fd0d::1\r\n(no payload)\r\n",
    "CoAP GET cg/db/ct/c/AAB → waiting...\r\nCoAP response code=4.04 mid=0x2 from fd0d::1\r\n(no payload)\r\n",
  ];
  let i = 0;
  const originalSend = transport.sendText.bind(transport);
  transport.sendText = async (text: string) => {
    await originalSend(text);
    const reply = replies[i++];
    setImmediate(() => transport.emitText(reply));
  };

  await pending;
  assert.equal(progress.length, 2);
  assert.deepEqual(progress[0], [1, 2, "cg/db/ct/c/AAA"]);
  assert.deepEqual(progress[1], [2, 2, "cg/db/ct/c/AAB"]);
  client.close();
});

test("CcxCoapClient.observe delivers subsequent broadcasts to handler and unsubscribes", async () => {
  const transport = new MockTransport();
  const client = new CcxCoapClient(transport);
  await client.connect();

  const target = { kind: "rloc" as const, rloc: "4800" };
  const notifications: Array<{ code: string; path: string; mid: number }> = [];

  const handler = (n: { code: string; path: string; mid: number }) =>
    notifications.push({ code: n.code, path: n.path, mid: n.mid });

  const obsPending = client.observe(target, "lg/all", handler, {
    timeoutMs: 500,
  });
  setImmediate(() => {
    transport.emitText(
      "CoAP Observe REGISTER lg/all → waiting...\r\nCoAP response code=2.05 mid=0x0001\r\n(no payload)\r\n",
    );
  });
  const unsubscribe = await obsPending;

  transport.emitText("[coap] 2.05 lg/all mid=0x0002 len=3\r\n");
  transport.emitText("[coap] 2.05 lg/all mid=0x0003 len=5\r\n");
  transport.emitText("[coap] 2.05 fw/ic/md mid=0x0099 len=1\r\n"); // different path

  assert.equal(notifications.length, 2);
  assert.equal(notifications[0].mid, 2);
  assert.equal(notifications[1].mid, 3);

  const unsubPending = unsubscribe();
  setImmediate(() => {
    transport.emitText(
      "CoAP Observe DEREGISTER lg/all → waiting...\r\nCoAP response code=2.05 mid=0x00AA\r\n(no payload)\r\n",
    );
  });
  await unsubPending;
  assert.equal(
    transport.sent.at(-1),
    "ccx coap observe rloc:4800 lg/all dereg",
  );

  transport.emitText("[coap] 2.05 lg/all mid=0x0004 len=1\r\n");
  assert.equal(
    notifications.length,
    2,
    "no more notifications after unsubscribe",
  );

  client.close();
});
