/**
 * Home Assistant Supervisor service discovery.
 *
 * An add-on that declares `services: [mqtt:want]` can ask the Supervisor for
 * the broker rather than being told: it answers with the Mosquitto add-on's
 * host, port and the credentials it generated. That is how every other HA
 * add-on gets its broker, and it means no password is copied into a second
 * place to drift out of date.
 *
 * Explicit configuration still wins — someone pointing the bridge at a broker
 * outside HA has said something the Supervisor cannot know.
 *
 * ## Everything here fails soft
 *
 * Discovery is a convenience, not a dependency. No token (running as a plain
 * container), no mqtt service configured, a Supervisor that cannot be reached —
 * all of them mean "no broker discovered" and none of them may throw. The
 * bridge still decodes packets and drives its other sinks without MQTT.
 */

/** What the bridge needs to connect, once discovery has resolved it. */
import {
  isJsonObject,
  isNumber,
  isString,
  type JsonValue,
} from "./data-values";

export interface DiscoveredMqtt {
  /** Broker URL, e.g. mqtt://core-mosquitto:1883 */
  url: string;
  username?: string;
  password?: string;
}

/** The subset of `fetch` used here, injected so tests need no network. */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<JsonValue>;
}>;

export interface DiscoverOptions {
  /** Defaults to SUPERVISOR_TOKEN, which only exists inside an add-on. */
  token?: string;
  fetchImpl?: FetchLike;
  /** Supervisor API root. Only overridden by tests. */
  baseUrl?: string;
  log?: (msg: string) => void;
}

const SUPERVISOR_URL = "http://supervisor";
const DEFAULT_MQTT_PORT = 1883;

/**
 * Ask the Supervisor for the configured MQTT service.
 *
 * Returns null whenever the answer is anything other than a usable broker.
 */
export async function discoverMqttService(
  opts: DiscoverOptions = {},
): Promise<DiscoveredMqtt | null> {
  const token = "token" in opts ? opts.token : process.env.SUPERVISOR_TOKEN;
  const log = opts.log ?? (() => {});

  // No token means this is not running as an add-on at all. Asking anyway would
  // just be a DNS failure with a scarier message.
  if (!token) return null;

  const fetchImpl: FetchLike =
    opts.fetchImpl ??
    (async (requestUrl, init) => {
      const response = await globalThis.fetch(requestUrl, init);
      return {
        ok: response.ok,
        status: response.status,
        json: async (): Promise<JsonValue> => {
          const parsed: JsonValue = JSON.parse(await response.text());
          return parsed;
        },
      };
    });
  if (!fetchImpl) return null;

  const url = `${opts.baseUrl ?? SUPERVISOR_URL}/services/mqtt`;

  let body: JsonValue;
  try {
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      log(`  [mqtt] supervisor has no mqtt service (HTTP ${res.status})`);
      return null;
    }
    body = await res.json();
  } catch (err) {
    log(
      `  [mqtt] supervisor unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  const data = readServiceData(body);
  if (!data?.host) {
    log("  [mqtt] supervisor answered without a broker host");
    return null;
  }

  const scheme = data.ssl ? "mqtts" : "mqtt";
  const port = data.port ?? DEFAULT_MQTT_PORT;

  return {
    url: `${scheme}://${data.host}:${port}`,
    // Empty strings are what the Supervisor sends for an anonymous broker, and
    // passing them through would authenticate as the user "".
    username: data.username || undefined,
    password: data.password || undefined,
  };
}

interface ServiceData {
  host?: string;
  port?: number;
  ssl?: boolean;
  username?: string;
  password?: string;
}

/** `{ result: "ok", data: {...} }` — anything else is not an answer. */
function readServiceData(body: JsonValue): ServiceData | null {
  if (!isJsonObject(body) || body.result !== "ok" || !isJsonObject(body.data)) {
    return null;
  }
  const data = body.data;
  return {
    host: isString(data.host) ? data.host : undefined,
    port: isNumber(data.port) ? data.port : undefined,
    ssl: data.ssl === true,
    username: isString(data.username) ? data.username : undefined,
    password: isString(data.password) ? data.password : undefined,
  };
}
