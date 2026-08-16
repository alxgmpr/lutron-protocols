/**
 * LEAP Client — shared connection and data fetching for Lutron LEAP API
 *
 * Supports both RA3 (v3.x) and Caseta (v1.x) processors with auto-detection.
 * RA3 uses area walk (area/associatedzone, area/associatedcontrolstation).
 * Caseta uses direct /zone and /device endpoints.
 *
 * Usage:
 *   import { LeapConnection, fetchLeapData } from "./leap-client";
 *   const conn = new LeapConnection({ host: "10.1.9.2" }); // certs auto-resolved from config.json
 *   await conn.connect();
 *   const data = await fetchLeapData(conn);
 *   conn.close();
 */

import * as fs from "fs";
import * as path from "path";
import * as tls from "tls";
import { fileURLToPath } from "url";
import { certsForHost } from "../lib/config";

// --- Types ---

export interface ZoneInfo {
  id: number;
  name: string;
  controlType: string;
  area: string;
  deviceSerial?: number;
}

export interface DeviceInfo {
  id: number;
  name: string;
  type: string;
  serial: number;
  model?: string;
  station: string;
  area: string;
}

export interface PresetMapping {
  presetId: number;
  buttonId: number;
  buttonNumber: number;
  buttonName: string;
  engraving?: string;
  programmingModelType: string;
  presetRole: "primary" | "secondary" | "single";
  deviceId: number;
  deviceName: string;
  deviceType: string;
  serialNumber: number;
  stationName: string;
  areaName: string;
}

export interface LinkInfo {
  rf?: { channel: number; subnetAddress?: number };
  ccx?: {
    channel: number;
    panId: number;
    extPanId: string;
    masterKey: string;
  };
}

export interface LeapDumpData {
  timestamp: string;
  host: string;
  leapVersion: string;
  productType: string;
  link: LinkInfo;
  zones: Record<
    string,
    { name: string; controlType: string; area: string; deviceSerial?: number }
  >;
  devices: Record<
    string,
    {
      name: string;
      type: string;
      serial: number;
      model?: string;
      station: string;
      area: string;
    }
  >;
  serials: Record<
    string,
    { name: string; leapId: number; type: string; area: string }
  >;
  presets: Record<string, { name: string; role: string; device: string }>;
}

const __dir =
  import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));

// --- Helpers ---

export function hrefId(href: string): number {
  const match = href.match(/\/(\d+)$/);
  return match ? parseInt(match[1], 10) : 0;
}

// --- LEAP Connection ---

export interface LeapConnectionOptions {
  host: string;
  port?: number;
}

export type LeapEventHandler = (msg: any) => void;

// --- Subscriptions ---

/**
 * One frame pushed by the processor on an open subscription.
 *
 * Captured shape (RA3 10.1.9.2, `tools/leap/leap-push-probe.ts`, fixture
 * `test/fixtures/leap-subscription-push-ra3.json`): `CommuniqueType` is
 * `ReadResponse` — *not* `SubscribeResponse`, which only ever answers the
 * SubscribeRequest itself — with `StatusCode: "200 OK"`, `Url` echoing the
 * subscribed URL, and the subscribe request's own `ClientTag` reused verbatim.
 *
 * The body is a **delta, not a snapshot**: only what changed. Pushed
 * `ZoneStatus` entries omit `ZoneLockState`, which the subscribe-time snapshot
 * includes, so a consumer merging pushes into the snapshot must treat an
 * absent field as unchanged rather than as a change to null.
 */
export interface LeapPush {
  /** `Header.Url`, echoing the subscribed URL. */
  url: string;
  /** The subscription's ClientTag, reused on every push it carries. */
  tag: string;
  /** `ReadResponse` on every captured push. */
  communiqueType: string;
  /** e.g. `MultipleZoneStatus`, `OneAreaStatus`. */
  messageBodyType: string;
  header: Record<string, unknown>;
  body: any;
}

export type LeapPushHandler = (push: LeapPush) => void;

export interface LeapUnsubscribeResult {
  /** The UnsubscribeResponse's StatusCode, or `(inactive)` if already detached. */
  status: string;
  communiqueType: string;
  /** Set when the request could not be sent or answered at all. */
  error?: string;
}

/** A live subscription. Obtained from {@link LeapConnection.subscribe}. */
export interface LeapSubscription {
  readonly url: string;
  /** ClientTag the SubscribeRequest went out with; every push reuses it. */
  readonly tag: string;
  readonly status: string;
  /** `Header.MessageBodyType` of the SubscribeResponse. */
  readonly messageBodyType: string;
  /** The SubscribeResponse body — the full set, against which pushes are deltas. */
  readonly snapshot: any;
  /** False once unsubscribed, or once the connection was closed or reconnected. */
  readonly active: boolean;
  /**
   * Stop dispatching pushes and tell the processor to stop sending them.
   *
   * Local dispatch stops before the request is written, so detaching cannot
   * fail; the returned status reports only what the processor said. LEAP lists
   * `UnsubscribeRequest` among its CommuniqueTypes (firmware RE,
   * `docs/reference/leap-api-spec.yaml`) but we have no capture of a processor
   * answering one, so do not read a non-200 here as "still subscribed".
   */
  unsubscribe(): Promise<LeapUnsubscribeResult>;
}

interface SubscriptionState {
  url: string;
  tag: string;
  status: string;
  messageBodyType: string;
  snapshot: any;
  active: boolean;
  onPush: LeapPushHandler;
}

/**
 * The status objects a push — or a subscribe-time snapshot — carries, without
 * the collection wrapper. Accepts a {@link LeapPush} or a
 * {@link LeapSubscription} so the delta and the full set unwrap the same way.
 *
 * LEAP nests them under one body key named for the MessageBodyType's subject,
 * pluralized in English: `MultipleZoneStatus` → `ZoneStatuses`, not
 * `ZoneStatuss`. That is not mechanically derivable from the type name, so the
 * key is read off the body instead of reconstructed — which holds because
 * every one of the 15 MessageBodyTypes seen across the captures has a body
 * with exactly one key. `One*` bodies hold an object, `Multiple*` an array;
 * both are flattened to a list.
 */
export function pushItems(
  source: { body?: unknown } | { snapshot?: unknown },
): unknown[] {
  const body =
    "body" in source
      ? source.body
      : (source as { snapshot?: unknown }).snapshot;
  if (!body || typeof body !== "object") return [];
  const values = Object.values(body as Record<string, unknown>);
  const items: unknown[] = [];
  for (const v of values) {
    if (Array.isArray(v)) items.push(...v);
    else if (v && typeof v === "object") items.push(v);
  }
  return items;
}

export class LeapConnection {
  private socket: tls.TLSSocket | null = null;
  private buffer = "";
  private tagCounter = 0;
  private pendingRequests: Map<
    string,
    { resolve: (value: any) => void; reject: (err: Error) => void }
  > = new Map();
  /** Open subscriptions, keyed by the ClientTag their pushes carry. */
  private subscriptions: Map<string, SubscriptionState> = new Map();

  /** Called for unsolicited messages (subscription events, etc.) */
  onEvent: LeapEventHandler | null = null;

  /**
   * Called for EVERY parsed frame, before it is routed to a pending request
   * or to onEvent. onEvent alone cannot distinguish a pushed frame from the
   * response to a request, because responses never reach it — so a capture
   * that needs one ordered timeline of everything the socket delivered taps
   * here and classifies the frames itself.
   */
  onFrame: LeapEventHandler | null = null;

  readonly host: string;
  readonly port: number;
  private certPaths: { cert: string; key: string; ca: string };

  constructor(opts: LeapConnectionOptions) {
    this.host = opts.host;
    this.port = opts.port ?? 8081;
    const certs = certsForHost(opts.host);
    if (!certs) {
      throw new Error(
        `No certs configured for ${opts.host} — add it to config.json`,
      );
    }
    this.certPaths = certs;
  }

  async connect(): Promise<void> {
    // ClientTags are per-connection — the processor's tag space resets with the
    // socket, and a subscription is bound to the connection that opened it. So
    // a reconnect starts the counter over and drops the old state rather than
    // letting a stale pending entry collide with a reissued tag.
    this.resetConnectionState(new Error("connection replaced by reconnect"));

    return new Promise((resolve, reject) => {
      this.socket = tls.connect(
        this.port,
        this.host,
        {
          cert: fs.readFileSync(this.certPaths.cert),
          key: fs.readFileSync(this.certPaths.key),
          ca: fs.readFileSync(this.certPaths.ca),
          rejectUnauthorized: false,
        },
        () => resolve(),
      );

      this.socket.on("data", (data) => this.handleData(data.toString()));
      this.socket.on("error", (err) => {
        for (const [, req] of this.pendingRequests) {
          req.reject(err);
        }
        this.pendingRequests.clear();
        reject(err);
      });
    });
  }

  private nextTag(): string {
    return `lt-${++this.tagCounter}`;
  }

  /**
   * Drop everything scoped to one socket: the parse buffer, the tag counter,
   * in-flight requests, and open subscriptions. Pending requests are rejected
   * rather than abandoned so a caller awaiting one fails immediately instead
   * of waiting out its timeout against a socket that is gone.
   */
  private resetConnectionState(reason: Error): void {
    this.buffer = "";
    this.tagCounter = 0;
    for (const [, req] of this.pendingRequests) req.reject(reason);
    this.pendingRequests.clear();
    for (const [, sub] of this.subscriptions) sub.active = false;
    this.subscriptions.clear();
  }

  private handleData(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop()!;

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const resp = JSON.parse(line);
        const tag = resp.Header?.ClientTag;

        // Raw tap first: the capture wants the frame regardless of where it
        // is about to be routed, and whether a tag was pending at the moment
        // it arrived (which routing itself destroys).
        if (this.onFrame) {
          this.onFrame(resp);
        }

        // Match by ClientTag if present
        if (tag && this.pendingRequests.has(tag)) {
          const status: string = resp.Header?.StatusCode ?? "";
          // "102 Processing" is an interim ack some processors send (with a
          // null body) before the real response, reusing the same
          // ClientTag roughly a second later. Captured traffic against
          // /firmwareimage/<id> shows this: the caller previously got the
          // 102 as if it were the final answer, and the real
          // ReadResponse — with the actual body — was dropped because the
          // pending entry had already been deleted. Only 102 has been
          // observed behaving this way, so only it is treated as interim;
          // every other status (including other 1xx codes we have not
          // seen in practice) is treated as terminal, matching prior
          // behavior.
          if (status.startsWith("102")) {
            continue;
          }
          const pending = this.pendingRequests.get(tag)!;
          this.pendingRequests.delete(tag);
          pending.resolve(resp);
          continue;
        }

        // Subscription push. Reached only after the pendingRequests branch
        // above declined the frame, which is what separates a push from the
        // SubscribeResponse: both carry the subscription's tag, but the
        // response consumes the pending entry and a push arrives after it.
        // (`102 Processing` never gets here — it `continue`s as interim.)
        const sub = tag ? this.subscriptions.get(tag) : undefined;
        if (sub?.active) {
          const push: LeapPush = {
            url: resp.Header?.Url ?? sub.url,
            tag,
            communiqueType: resp.CommuniqueType ?? "",
            messageBodyType: resp.Header?.MessageBodyType ?? "",
            header: resp.Header ?? {},
            body: resp.Body ?? null,
          };
          // One handler's failure must not swallow the frames behind it in
          // this chunk, nor kill the socket's data listener.
          try {
            sub.onPush(push);
          } catch {}
          continue;
        }

        // Unsolicited message — pass to event handler
        if (this.onEvent) {
          this.onEvent(resp);
        }
      } catch {}
    }
  }

  /** Send a raw LEAP request and wait for the response */
  async send(
    communiqueType: string,
    url: string,
    body?: any,
    timeout = 10000,
  ): Promise<any> {
    return (await this.sendTagged(communiqueType, url, body, timeout)).response;
  }

  /**
   * Like send(), but also reports the ClientTag the request went out with.
   * Tags are allocated internally, so a caller that needs to reason about
   * which later frames carry that tag — e.g. asking whether a subscription
   * push echoes the subscribe request's tag — cannot otherwise know it
   * except by trusting the tag echoed back on the response.
   */
  async sendTagged(
    communiqueType: string,
    url: string,
    body?: any,
    timeout = 10000,
  ): Promise<{ tag: string; response: any }> {
    if (!this.socket) throw new Error("Not connected");
    const tag = this.nextTag();
    return {
      tag,
      response: await this.sendWithTag(tag, communiqueType, url, body, timeout),
    };
  }

  /**
   * Send on a caller-chosen tag.
   *
   * subscribe() needs the tag *before* the request goes out, because pushes
   * are routed by it and the processor may deliver one in the same TCP segment
   * as the SubscribeResponse. Allocating the tag inside the send — as
   * sendTagged does, revealing it only on resolve — leaves a window in which
   * such a push has nowhere to go but onEvent.
   */
  private async sendWithTag(
    tag: string,
    communiqueType: string,
    url: string,
    body?: any,
    timeout = 10000,
  ): Promise<any> {
    if (!this.socket) throw new Error("Not connected");

    const response = await new Promise<any>((resolve, reject) => {
      this.pendingRequests.set(tag, { resolve, reject });

      const req: any = {
        CommuniqueType: communiqueType,
        Header: { Url: url, ClientTag: tag },
      };
      if (body !== undefined) req.Body = body;
      this.socket!.write(JSON.stringify(req) + "\n");

      // Not extended when a 102 Processing interim frame is seen for this
      // tag (see handleData). Captured evidence shows the real response
      // typically follows ~1s after the 102, well inside the default
      // 10s timeout, so a fixed deadline from the original send() call is
      // enough to cover the observed case. Extending on every 102 would
      // let a processor that keeps re-emitting 102 without ever finishing
      // stall the caller indefinitely instead of failing loudly.
      setTimeout(() => {
        if (this.pendingRequests.has(tag)) {
          this.pendingRequests.delete(tag);
          reject(new Error(`Timeout: ${communiqueType} ${url}`));
        }
      }, timeout);
    });
    return response;
  }

  async read(url: string): Promise<any> {
    return this.send("ReadRequest", url);
  }

  async readBody(url: string): Promise<any | null> {
    try {
      const resp = await this.read(url);
      const status = resp.Header?.StatusCode ?? "";
      if (status.startsWith("204") || status.startsWith("404")) return null;
      if (status.startsWith("405")) return null;
      return resp.Body ?? null;
    } catch {
      return null;
    }
  }

  /** Send a CreateRequest (zone commands, device pairing, etc.) */
  async create(url: string, body: any): Promise<any> {
    return this.send("CreateRequest", url, body);
  }

  /** Send an UpdateRequest (config changes: tuning, phase, presets, etc.) */
  async update(url: string, body: any): Promise<any> {
    return this.send("UpdateRequest", url, body);
  }

  /**
   * Subscribe to a resource and receive its pushes on `onPush`.
   *
   * Resolves once the processor has answered the SubscribeRequest, with the
   * snapshot that answer carried; every later frame on the subscription's tag
   * is handed to `onPush` as a {@link LeapPush} and does *not* reach `onEvent`.
   *
   *   const sub = await conn.subscribe("/zone/status", (push) => {
   *     for (const z of pushItems(push) as any[]) {
   *       console.log(z.Zone.href, z.Level);
   *     }
   *   });
   *   // ... later
   *   await sub.unsubscribe();
   *
   * Subscribe to **collections**, not to individual resources: RA3 answers
   * `SubscribeRequest /zone/{id}/status` with `405 MethodNotAllowed`, and
   * `/zone/status` is the subscribable form. A refusal rejects here and leaves
   * nothing registered — a probe that wants a refusal as data rather than as
   * an error should drive `sendTagged("SubscribeRequest", …)` directly, which
   * is what `tools/leap/leap-connect-observe.ts` does.
   */
  async subscribe(
    url: string,
    onPush: LeapPushHandler,
    timeout = 10000,
  ): Promise<LeapSubscription> {
    if (!this.socket) throw new Error("Not connected");

    const tag = this.nextTag();
    const state: SubscriptionState = {
      url,
      tag,
      status: "",
      messageBodyType: "",
      snapshot: null,
      active: true,
      onPush,
    };
    // Registered before the write: the processor can deliver a push in the
    // same segment as the SubscribeResponse, and a subscription that is not
    // yet in the map would lose it to onEvent.
    this.subscriptions.set(tag, state);

    let response: any;
    try {
      response = await this.sendWithTag(
        tag,
        "SubscribeRequest",
        url,
        undefined,
        timeout,
      );
    } catch (err) {
      state.active = false;
      this.subscriptions.delete(tag);
      throw err;
    }

    const status: string = response?.Header?.StatusCode ?? "";
    if (!status.startsWith("2")) {
      state.active = false;
      this.subscriptions.delete(tag);
      throw new Error(
        `SubscribeRequest ${url} refused: ${status || "(no status)"}` +
          (response?.Body?.Message ? ` — ${response.Body.Message}` : ""),
      );
    }

    state.status = status;
    state.messageBodyType = response?.Header?.MessageBodyType ?? "";
    state.snapshot = response?.Body ?? null;

    const detach = (): void => {
      state.active = false;
      if (this.subscriptions.get(tag) === state) this.subscriptions.delete(tag);
    };

    return {
      url,
      tag,
      get status() {
        return state.status;
      },
      get messageBodyType() {
        return state.messageBodyType;
      },
      get snapshot() {
        return state.snapshot;
      },
      get active() {
        return state.active;
      },
      unsubscribe: async (): Promise<LeapUnsubscribeResult> => {
        if (!state.active) {
          return { status: "(inactive)", communiqueType: "" };
        }
        // Detach first: dispatch must stop whatever the processor answers,
        // and must not depend on a request that may never be answered.
        detach();
        if (!this.socket) {
          return {
            status: "(inactive)",
            communiqueType: "",
            error: "Not connected",
          };
        }
        try {
          const resp = await this.send("UnsubscribeRequest", url);
          return {
            status: resp?.Header?.StatusCode ?? "(none)",
            communiqueType: resp?.CommuniqueType ?? "",
          };
        } catch (err) {
          return {
            status: "(error)",
            communiqueType: "",
            error: (err as Error).message,
          };
        }
      },
    };
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
    this.resetConnectionState(new Error("connection closed"));
  }
}

// --- Data fetching ---

type LogFn = (msg: string) => void;

/** Fetch link info (RF channel, CCX Thread credentials) */
async function fetchLinkInfo(
  leap: LeapConnection,
  log: LogFn,
): Promise<LinkInfo> {
  const link: LinkInfo = {};
  const linkBody = await leap.readBody("/link");
  const links = linkBody?.Links ?? [];

  for (const l of links) {
    const linkType = l.LinkType ?? "";
    if (linkType === "RF" && l.RFProperties) {
      const rf = l.RFProperties;
      link.rf = { channel: rf.Channel ?? 0 };
      if (rf.SubnetAddress !== undefined) {
        link.rf.subnetAddress = rf.SubnetAddress;
      }
    } else if (linkType === "ClearConnectTypeX") {
      const ccx = l.ClearConnectTypeXLinkProperties ?? {};
      link.ccx = {
        channel: ccx.Channel ?? 0,
        panId: ccx.PANID ?? 0,
        extPanId: ccx.ExtendedPANID ?? "",
        masterKey: ccx.NetworkMasterKey ?? "",
      };
    }
  }
  if (link.rf) log(`  RF channel=${link.rf.channel}`);
  if (link.ccx) log(`  CCX channel=${link.ccx.channel}`);
  return link;
}

/** Fetch LEAP version and product type from /server */
async function fetchServerInfo(
  leap: LeapConnection,
): Promise<{ leapVersion: string; productType: string }> {
  const body = await leap.readBody("/server");
  const servers = body?.Servers ?? [];
  const leapServer =
    servers.find((s: any) => s.Type === "LEAP") ?? servers[0] ?? {};
  const protocolVersion = leapServer.ProtocolVersion ?? "";
  // Product type isn't directly on /server; infer from version range
  // RA3: 03.xxx, Caseta: 01.xxx, HomeWorks: 02.xxx
  let productType = "";
  if (protocolVersion.startsWith("03.")) productType = "RadioRA3";
  else if (protocolVersion.startsWith("01.")) productType = "Caseta";
  else if (protocolVersion.startsWith("02.")) productType = "HomeWorks";
  return { leapVersion: protocolVersion, productType };
}

/** RA3 walk: area → zones + control stations → devices */
async function fetchViaAreaWalk(
  leap: LeapConnection,
  log: LogFn,
): Promise<{
  zones: ZoneInfo[];
  deviceMeta: Map<number, { area: string; station: string }>;
}> {
  const areasBody = await leap.readBody("/area");
  const areas: { href: string; Name: string; IsLeaf: boolean }[] =
    areasBody?.Areas ?? [];
  log(`  ${areas.length} areas`);

  const zones: ZoneInfo[] = [];
  const deviceMeta = new Map<number, { area: string; station: string }>();

  for (const area of areas) {
    if (!area.IsLeaf) continue;
    const areaId = hrefId(area.href);

    const zonesBody = await leap.readBody(`/area/${areaId}/associatedzone`);
    for (const z of zonesBody?.Zones ?? []) {
      zones.push({
        id: hrefId(z.href),
        name: z.Name,
        controlType: z.ControlType,
        area: area.Name,
      });
    }

    const csBody = await leap.readBody(
      `/area/${areaId}/associatedcontrolstation`,
    );
    for (const cs of csBody?.ControlStations ?? []) {
      for (const g of cs.AssociatedGangedDevices ?? []) {
        if (g.Device?.href) {
          deviceMeta.set(hrefId(g.Device.href), {
            area: area.Name,
            station: cs.Name ?? "",
          });
        }
      }
    }
  }

  return { zones, deviceMeta };
}

/** Caseta walk: direct /zone and /device endpoints */
async function fetchViaDirect(
  leap: LeapConnection,
  log: LogFn,
): Promise<{
  zones: ZoneInfo[];
  deviceMeta: Map<number, { area: string; station: string }>;
}> {
  const zonesBody = await leap.readBody("/zone");
  const rawZones = zonesBody?.Zones ?? [];
  log(`  ${rawZones.length} zones from /zone`);

  const devicesBody = await leap.readBody("/device");
  const rawDevices = devicesBody?.Devices ?? [];
  log(`  ${rawDevices.length} devices from /device`);

  // Build area map from devices (Caseta devices have AssociatedArea)
  const deviceAreaMap = new Map<number, string>();
  for (const d of rawDevices) {
    const devId = hrefId(d.href);
    const areaHref = d.AssociatedArea?.href;
    if (areaHref) {
      // Fetch area name
      const areaBody = await leap.readBody(areaHref);
      const areaName = areaBody?.Area?.Name ?? `Area ${hrefId(areaHref)}`;
      deviceAreaMap.set(devId, areaName);
    }
  }

  // Zones — Caseta zones have a Device href directly
  const zones: ZoneInfo[] = [];
  for (const z of rawZones) {
    const zoneId = hrefId(z.href);
    // Try to resolve area from associated device
    let area = "";
    const deviceHref = z.Device?.href;
    if (deviceHref) {
      area = deviceAreaMap.get(hrefId(deviceHref)) ?? "";
    }
    if (!area && z.AssociatedArea?.href) {
      const areaBody = await leap.readBody(z.AssociatedArea.href);
      area = areaBody?.Area?.Name ?? "";
    }
    zones.push({
      id: zoneId,
      name: z.Name,
      controlType: z.ControlType ?? z.Category?.Type ?? "Unknown",
      area,
      deviceSerial: undefined,
    });
  }

  // Device metadata
  const deviceMeta = new Map<number, { area: string; station: string }>();
  for (const d of rawDevices) {
    const devId = hrefId(d.href);
    deviceMeta.set(devId, {
      area: deviceAreaMap.get(devId) ?? "",
      station: "",
    });
  }

  return { zones, deviceMeta };
}

/**
 * Fetch all LEAP data from a connected processor.
 * Auto-detects RA3 vs Caseta based on /zone endpoint behavior.
 */
export async function fetchLeapData(
  leap: LeapConnection,
  log: LogFn = () => {},
): Promise<{
  zones: ZoneInfo[];
  devices: DeviceInfo[];
  presets: PresetMapping[];
  link: LinkInfo;
  leapVersion: string;
  productType: string;
}> {
  // Fetch server info
  const { leapVersion, productType } = await fetchServerInfo(leap);
  log(`  LEAP version=${leapVersion} product=${productType || "(unknown)"}`);

  // Fetch link info
  log("Fetching link info...");
  const link = await fetchLinkInfo(leap, log);

  // Auto-detect: try /zone first — Caseta returns 200 with zones, RA3 returns 405
  log("Detecting LEAP path...");
  const zoneProbe = await leap.readBody("/zone");
  const useDirect = zoneProbe !== null && (zoneProbe.Zones?.length ?? 0) > 0;

  let zones: ZoneInfo[];
  let deviceMeta: Map<number, { area: string; station: string }>;

  if (useDirect) {
    log("  Using Caseta-style direct endpoints");
    ({ zones, deviceMeta } = await fetchViaDirect(leap, log));
  } else {
    log("  Using RA3-style area walk");
    ({ zones, deviceMeta } = await fetchViaAreaWalk(leap, log));
  }

  log(`  ${zones.length} zones, ${deviceMeta.size} devices`);

  // Also add processor device
  const projBody = await leap.readBody("/project");
  for (const d of projBody?.Project?.MasterDeviceList?.Devices ?? []) {
    const id = hrefId(d.href);
    if (!deviceMeta.has(id)) deviceMeta.set(id, { area: "", station: "" });
  }

  // Fetch device details + buttons → presets
  log("Fetching buttons and presets...");
  const devices: DeviceInfo[] = [];
  const presets: PresetMapping[] = [];

  for (const [devId, meta] of deviceMeta) {
    const devBody = await leap.readBody(`/device/${devId}`);
    const dev = devBody?.Device;
    if (!dev) continue;

    devices.push({
      id: devId,
      name: dev.Name,
      type: dev.DeviceType,
      serial: dev.SerialNumber,
      model: dev.ModelNumber,
      station: meta.station,
      area: meta.area,
    });

    // Get button groups
    const bgBody = await leap.readBody(`/device/${devId}/buttongroup`);
    const buttonGroups = bgBody?.ButtonGroups ?? [];

    for (const bg of buttonGroups) {
      for (const btnRef of bg.Buttons ?? []) {
        const btnId = hrefId(btnRef.href);

        const btnBody = await leap.readBody(`/button/${btnId}`);
        const btn = btnBody?.Button;
        if (!btn?.ProgrammingModel) continue;

        const pmBody = await leap.readBody(
          `/programmingmodel/${hrefId(btn.ProgrammingModel.href)}`,
        );
        const pm = pmBody?.ProgrammingModel;
        if (!pm) continue;

        const refs: {
          href: string;
          role: "primary" | "secondary" | "single";
        }[] = [];

        const toggleProps = pm.AdvancedToggleProperties;
        if (toggleProps?.PrimaryPreset)
          refs.push({ href: toggleProps.PrimaryPreset.href, role: "primary" });
        if (toggleProps?.SecondaryPreset)
          refs.push({
            href: toggleProps.SecondaryPreset.href,
            role: "secondary",
          });
        if (pm.Preset) refs.push({ href: pm.Preset.href, role: "single" });
        if (pm.Presets)
          for (const p of pm.Presets)
            refs.push({ href: p.href, role: "single" });

        for (const ref of refs) {
          presets.push({
            presetId: hrefId(ref.href),
            buttonId: btnId,
            buttonNumber: btn.ButtonNumber,
            buttonName: btn.Name,
            engraving: btn.Engraving?.Text,
            programmingModelType: pm.ProgrammingModelType,
            presetRole: ref.role,
            deviceId: devId,
            deviceName: dev.Name,
            deviceType: dev.DeviceType,
            serialNumber: dev.SerialNumber,
            stationName: meta.station,
            areaName: meta.area,
          });
        }
      }
    }
  }

  log(`  ${presets.length} presets from ${devices.length} devices`);

  return { zones, devices, presets, link, leapVersion, productType };
}

/** Build a LeapDumpData object from fetched data */
export function buildDumpData(
  host: string,
  result: Awaited<ReturnType<typeof fetchLeapData>>,
): LeapDumpData {
  const { zones, devices, presets, link, leapVersion, productType } = result;

  const zonesMap: LeapDumpData["zones"] = {};
  for (const z of zones) {
    zonesMap[z.id] = {
      name: z.name,
      controlType: z.controlType,
      area: z.area,
      deviceSerial: z.deviceSerial,
    };
  }

  const devicesMap: LeapDumpData["devices"] = {};
  for (const d of devices) {
    devicesMap[d.id] = {
      name: d.name,
      type: d.type,
      serial: d.serial,
      model: d.model,
      station: d.station,
      area: d.area,
    };
  }

  const serialsMap: LeapDumpData["serials"] = {};
  for (const d of devices) {
    if (d.serial && d.serial < 0xffffffff) {
      serialsMap[d.serial] = {
        name: d.station ? `${d.area} ${d.station} ${d.type}` : d.name,
        leapId: d.id,
        type: d.type,
        area: d.area,
      };
    }
  }

  const presetsMap: LeapDumpData["presets"] = {};
  const seen = new Set<number>();
  for (const p of presets.sort((a, b) => a.presetId - b.presetId)) {
    if (seen.has(p.presetId)) continue;
    seen.add(p.presetId);
    presetsMap[p.presetId] = {
      name: p.engraving ?? p.buttonName,
      role: p.presetRole,
      device: p.stationName ? `${p.areaName} ${p.stationName}` : p.deviceName,
    };
  }

  return {
    timestamp: new Date().toISOString(),
    host,
    leapVersion,
    productType,
    link,
    zones: zonesMap,
    devices: devicesMap,
    serials: serialsMap,
    presets: presetsMap,
  };
}

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
  {
    path: "/link",
    key: "links",
    core: true,
    itemsField: "Links",
    perItem: [
      { path: "/status", key: "status" },
      { path: "/memberinfo/status", key: "memberInfoStatus" },
    ],
  },
  {
    path: "/area",
    key: "areas",
    core: true,
    itemsField: "Areas",
    perItem: [
      { path: "/status", key: "status" },
      { path: "/summary", key: "summary" },
    ],
    children: [
      { path: "/associatedzone", key: "zones", itemsField: "Zones" },
      {
        path: "/associatedcontrolstation",
        key: "controlStations",
        itemsField: "ControlStations",
      },
      { path: "/associatedareascene", key: "scenes", itemsField: "AreaScenes" },
      {
        path: "/associatedoccupancygroup",
        key: "occupancyGroups",
        itemsField: "OccupancyGroups",
      },
    ],
  },
  {
    path: "/zone",
    key: "zones",
    core: true,
    itemsField: "Zones",
    perItem: [
      { path: "/status", key: "status" },
      { path: "/fadesettings", key: "fadeSettings" },
    ],
  },
  {
    path: "/device",
    key: "devices",
    core: true,
    itemsField: "Devices",
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
    path: "/preset",
    key: "presets",
    itemsField: "Presets",
    perItem: [{ path: "/presetassignment", key: "assignments" }],
  },
  {
    path: "/presetassignment",
    key: "presetAssignments",
    itemsField: "PresetAssignments",
  },
  {
    path: "/programmingmodel",
    key: "programmingModels",
    itemsField: "ProgrammingModels",
  },
  {
    path: "/virtualbutton",
    key: "virtualButtons",
    itemsField: "VirtualButtons",
  },
  { path: "/buttongroup", key: "buttonGroups", itemsField: "ButtonGroups" },
  {
    path: "/occupancygroup",
    key: "occupancyGroups",
    itemsField: "OccupancyGroups",
    children: [
      { path: "/associatedzone", key: "zones", itemsField: "Zones" },
      { path: "/associatedsensor", key: "sensors", itemsField: "Sensors" },
    ],
  },
  { path: "/timeclock", key: "timeClocks", itemsField: "TimeClocks" },
  {
    path: "/timeclockevent",
    key: "timeClockEvents",
    itemsField: "TimeClockEvents",
  },
  { path: "/service", key: "services", itemsField: "Services" },
  { path: "/firmware", key: "firmwareImages", itemsField: "Firmwares" },
  { path: "/firmware/status", key: "firmwareStatus", itemsField: null },
  {
    path: "/firmwareupdatesession",
    key: "firmwareUpdateSessions",
    itemsField: "FirmwareUpdateSessions",
  },
  { path: "/operation/status", key: "operationStatus", itemsField: null },
  { path: "/networkinterface/1", key: "networkInterface", itemsField: null },
  { path: "/project/contactinfo", key: "projectContactInfo", itemsField: null },
  {
    path: "/project/masterdevicelist/devices",
    key: "masterDeviceList",
    itemsField: "Devices",
  },
  { path: "/server/status/ping", key: "ping", itemsField: null },
  { path: "/server/leap/pairinglist", key: "pairingList", itemsField: null },
  { path: "/system/away", key: "awayMode", itemsField: null },
  {
    path: "/system/loadshedding/status",
    key: "loadShedding",
    itemsField: null,
  },
  {
    path: "/system/naturallightoptimization",
    key: "naturalLight",
    itemsField: null,
  },
  { path: "/facade", key: "facades", itemsField: "Facades" },
  {
    path: "/countdowntimer",
    key: "countdownTimers",
    itemsField: "CountdownTimers",
  },
  { path: "/favorite", key: "favorites", itemsField: "Favorites" },
  { path: "/daynightmode", key: "dayNightMode", itemsField: null },

  // Status collections — discovered from multi-server-phoenix.gobin RE.
  // See docs/protocols/leap/server-internals.md.
  {
    path: "/area/status",
    key: "areaStatuses",
    itemsField: "AreaStatuses",
  },
  {
    path: "/zone/status",
    key: "zoneStatuses",
    itemsField: "ZoneStatuses",
  },
  {
    path: "/loadcontroller/status",
    key: "loadControllerStatuses",
    itemsField: "LoadControllerStatuses",
  },
  {
    path: "/timeclock/status",
    key: "timeclockStatuses",
    itemsField: "TimeclockStatuses",
  },
  {
    path: "/timeclockevent/status",
    key: "timeclockEventStatuses",
    itemsField: "TimeclockEventStatuses",
  },
  { path: "/curve", key: "curves", itemsField: "Curves" },
  { path: "/clientsetting", key: "clientSetting", itemsField: null },
  { path: "/server/ipl", key: "serverIPL", itemsField: null },
  {
    path: "/project/masterdevicelist",
    key: "masterDeviceListMeta",
    itemsField: null,
  },

  // Service integrations (Alexa, BACnet, HomeKit, IFTTT, Sonos, Google Home, NTP)
  { path: "/service/alexa", key: "serviceAlexa", itemsField: null },
  {
    path: "/service/alexa/config",
    key: "serviceAlexaConfig",
    itemsField: null,
  },
  { path: "/service/bacnet", key: "serviceBACnet", itemsField: null },
  { path: "/service/homekit", key: "serviceHomeKit", itemsField: null },
  { path: "/service/ifttt", key: "serviceIFTTT", itemsField: null },
  { path: "/service/sonos", key: "serviceSonos", itemsField: null },
  {
    path: "/service/sonos/status",
    key: "serviceSonosStatus",
    itemsField: null,
  },
  { path: "/service/googlehome", key: "serviceGoogleHome", itemsField: null },
  { path: "/service/ntpserver", key: "serviceNTPServer", itemsField: null },

  // Operation status (system-wide async operation tracker) — v2 is preferred
  {
    path: "/v2/operation/status",
    key: "operationStatusV2",
    itemsField: "OperationStatuses",
  },
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
