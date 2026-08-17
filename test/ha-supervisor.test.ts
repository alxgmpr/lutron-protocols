/**
 * Home Assistant Supervisor service discovery — tests.
 *
 * The add-on should get its broker the way every other HA add-on does: ask the
 * Supervisor, which hands back the Mosquitto add-on's host, port and generated
 * credentials. Nobody should have to copy a password into a second place.
 *
 * Every failure here has to be soft. Discovery not working is a bridge without
 * MQTT, never a bridge that will not start.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { discoverMqttService } from "../lib/ha-supervisor";

/** A Supervisor stub that records what was asked of it. */
function supervisor(
  response: unknown,
  opts: { status?: number; throws?: Error } = {},
) {
  const calls: Array<{ url: string; auth: string | undefined }> = [];
  const fetchImpl = async (url: string, init?: { headers?: any }) => {
    calls.push({ url, auth: init?.headers?.Authorization });
    if (opts.throws) throw opts.throws;
    return {
      ok: (opts.status ?? 200) < 400,
      status: opts.status ?? 200,
      json: async () => response,
    };
  };
  return { calls, fetchImpl: fetchImpl as any };
}

const OK = (data: Record<string, unknown>) => ({ result: "ok", data });

/** Stands in for the credential Mosquitto generates for add-ons. */
const GENERATED_CREDENTIAL = "supervisor-generated-value";

describe("supervisor mqtt discovery", () => {
  it("builds a broker url from the mqtt service", async () => {
    const sv = supervisor(
      OK({ host: "core-mosquitto", port: 1883, ssl: false }),
    );

    const found = await discoverMqttService({
      token: "tok",
      fetchImpl: sv.fetchImpl,
    });

    assert.equal(found?.url, "mqtt://core-mosquitto:1883");
  });

  it("asks the documented endpoint with the supervisor token", async () => {
    const sv = supervisor(OK({ host: "h", port: 1883 }));

    await discoverMqttService({ token: "tok", fetchImpl: sv.fetchImpl });

    assert.equal(sv.calls[0].url, "http://supervisor/services/mqtt");
    assert.equal(sv.calls[0].auth, "Bearer tok");
  });

  it("uses mqtts when the broker is TLS", async () => {
    const sv = supervisor(OK({ host: "broker", port: 8883, ssl: true }));

    const found = await discoverMqttService({
      token: "tok",
      fetchImpl: sv.fetchImpl,
    });

    assert.equal(found?.url, "mqtts://broker:8883");
  });

  it("carries the generated credentials through", async () => {
    const sv = supervisor(
      OK({
        host: "core-mosquitto",
        port: 1883,
        username: "addons",
        password: GENERATED_CREDENTIAL,
      }),
    );

    const found = await discoverMqttService({
      token: "tok",
      fetchImpl: sv.fetchImpl,
    });

    assert.equal(found?.username, "addons");
    assert.equal(found?.password, GENERATED_CREDENTIAL);
  });

  it("omits credentials the broker does not use", async () => {
    const sv = supervisor(
      OK({ host: "h", port: 1883, username: "", password: "" }),
    );

    const found = await discoverMqttService({
      token: "tok",
      fetchImpl: sv.fetchImpl,
    });

    assert.equal(found?.username, undefined);
    assert.equal(found?.password, undefined);
  });

  // ── Every failure is soft ───────────────────────────────

  it("returns nothing outside Home Assistant, without asking", async () => {
    const sv = supervisor(OK({ host: "h", port: 1883 }));

    // No SUPERVISOR_TOKEN means this is a plain container or a dev machine.
    const found = await discoverMqttService({
      token: undefined,
      fetchImpl: sv.fetchImpl,
    });

    assert.equal(found, null);
    assert.equal(sv.calls.length, 0, "asked the Supervisor without a token");
  });

  it("returns nothing when no mqtt service is configured", async () => {
    const sv = supervisor(
      { result: "error", message: "no services found" },
      {
        status: 400,
      },
    );

    const found = await discoverMqttService({
      token: "tok",
      fetchImpl: sv.fetchImpl,
    });

    assert.equal(found, null);
  });

  it("returns nothing when the Supervisor answers without a host", async () => {
    const sv = supervisor(OK({ port: 1883 }));

    const found = await discoverMqttService({
      token: "tok",
      fetchImpl: sv.fetchImpl,
    });

    assert.equal(found, null);
  });

  it("returns nothing when the Supervisor is unreachable", async () => {
    const sv = supervisor(null, { throws: new Error("EAI_AGAIN supervisor") });

    const found = await discoverMqttService({
      token: "tok",
      fetchImpl: sv.fetchImpl,
    });

    assert.equal(found, null);
  });

  it("defaults the port when the service omits it", async () => {
    const sv = supervisor(OK({ host: "core-mosquitto" }));

    const found = await discoverMqttService({
      token: "tok",
      fetchImpl: sv.fetchImpl,
    });

    assert.equal(found?.url, "mqtt://core-mosquitto:1883");
  });
});
