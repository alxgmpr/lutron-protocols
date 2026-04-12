import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
  certsForHost,
  config,
  defaultHost,
  processorIPs,
} from "../lib/config";

// ── Config loading ──────────────────────────────────────────

test("config.json loads with required top-level keys", () => {
  assert.ok(config.processors, "processors key exists");
  assert.ok(config.openBridge, "openBridge key exists");
  assert.ok(config.designer, "designer key exists");
  assert.ok(config.designer.host, "designer.host exists");
  assert.ok(config.designer.user, "designer.user exists");
  assert.ok(config.designer.pass, "designer.pass exists");
});

test("processorIPs lists all configured processor IPs", () => {
  const ips = Object.keys(config.processors);
  assert.deepEqual(processorIPs, ips);
  assert.ok(processorIPs.length > 0, "at least one processor configured");
});

test("defaultHost is the first processor IP", () => {
  assert.equal(defaultHost, processorIPs[0]);
});

// ── Cert resolution ─────────────────────────────────────────

test("certsForHost returns absolute paths for configured processor", () => {
  const ip = processorIPs[0];
  const certs = certsForHost(ip);
  assert.ok(certs, `certs should exist for ${ip}`);
  assert.ok(resolve(certs.cert) === certs.cert, "cert path is absolute");
  assert.ok(resolve(certs.key) === certs.key, "key path is absolute");
  assert.ok(resolve(certs.ca) === certs.ca, "ca path is absolute");
});

test("certsForHost returns undefined for unconfigured IP", () => {
  assert.equal(certsForHost("192.168.255.255"), undefined);
});

test("each configured processor has cert/key/ca fields", () => {
  for (const [ip, proc] of Object.entries(config.processors)) {
    assert.ok(proc.cert, `${ip} missing cert`);
    assert.ok(proc.key, `${ip} missing key`);
    assert.ok(proc.ca, `${ip} missing ca`);
  }
});

// ── LeapConnection cert validation ──────────────────────────

test("LeapConnection throws for unconfigured host", async () => {
  const { LeapConnection } = await import("../tools/leap-client");
  assert.throws(
    () => new LeapConnection({ host: "192.168.255.255" }),
    /No certs configured/,
  );
});

test("LeapConnection accepts configured host", async () => {
  const { LeapConnection } = await import("../tools/leap-client");
  const conn = new LeapConnection({ host: processorIPs[0] });
  assert.equal(conn.host, processorIPs[0]);
});
