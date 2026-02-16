/**
 * LEAP Client — shared connection and data fetching for Lutron LEAP API
 *
 * Supports both RA3 (v3.x) and Caseta (v1.x) processors with auto-detection.
 * RA3 uses area walk (area/associatedzone, area/associatedcontrolstation).
 * Caseta uses direct /zone and /device endpoints.
 *
 * Usage:
 *   import { LeapConnection, fetchLeapData } from "./leap-client";
 *   const conn = new LeapConnection({ host: "10.0.0.1", certName: "ra3" });
 *   await conn.connect();
 *   const data = await fetchLeapData(conn);
 *   conn.close();
 */

import * as fs from "fs";
import * as path from "path";
import * as tls from "tls";

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

// --- Cert resolver ---

const DEFAULT_CERT_DIR = path.resolve(import.meta.dir, "..");

/**
 * Resolve LEAP TLS certificate paths.
 * Tries `lutron-{name}-cert.pem` then `lutron_{name}-cert.pem`.
 */
export function resolveCerts(
  name: string,
  dir: string = DEFAULT_CERT_DIR,
): { cert: string; key: string; ca: string } {
  for (const sep of ["-", "_"]) {
    const prefix = `lutron${sep}${name}`;
    const certPath = path.join(dir, `${prefix}-cert.pem`);
    if (fs.existsSync(certPath)) {
      return {
        cert: certPath,
        key: path.join(dir, `${prefix}-key.pem`),
        ca: path.join(dir, `${prefix}-ca.pem`),
      };
    }
  }
  // Fallback to dash variant (will error on connect if missing)
  const prefix = `lutron-${name}`;
  return {
    cert: path.join(dir, `${prefix}-cert.pem`),
    key: path.join(dir, `${prefix}-key.pem`),
    ca: path.join(dir, `${prefix}-ca.pem`),
  };
}

// --- Helpers ---

export function hrefId(href: string): number {
  const match = href.match(/\/(\d+)$/);
  return match ? parseInt(match[1], 10) : 0;
}

// --- LEAP Connection ---

export interface LeapConnectionOptions {
  host: string;
  port?: number;
  certName?: string;
  certDir?: string;
}

export type LeapEventHandler = (msg: any) => void;

export class LeapConnection {
  private socket: tls.TLSSocket | null = null;
  private buffer = "";
  private tagCounter = 0;
  private pendingRequests: Map<
    string,
    { resolve: (value: any) => void; reject: (err: Error) => void }
  > = new Map();

  /** Called for unsolicited messages (subscription events, etc.) */
  onEvent: LeapEventHandler | null = null;

  readonly host: string;
  readonly port: number;
  private certPaths: { cert: string; key: string; ca: string };

  constructor(opts: LeapConnectionOptions) {
    this.host = opts.host;
    this.port = opts.port ?? 8081;
    this.certPaths = resolveCerts(opts.certName ?? "ra3", opts.certDir);
  }

  async connect(): Promise<void> {
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

  private handleData(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop()!;

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const resp = JSON.parse(line);
        const tag = resp.Header?.ClientTag;

        // Match by ClientTag if present
        if (tag && this.pendingRequests.has(tag)) {
          const pending = this.pendingRequests.get(tag)!;
          this.pendingRequests.delete(tag);
          pending.resolve(resp);
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
    if (!this.socket) throw new Error("Not connected");

    const tag = this.nextTag();
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(tag, { resolve, reject });

      const req: any = {
        CommuniqueType: communiqueType,
        Header: { Url: url, ClientTag: tag },
      };
      if (body !== undefined) req.Body = body;
      this.socket!.write(JSON.stringify(req) + "\n");

      setTimeout(() => {
        if (this.pendingRequests.has(tag)) {
          this.pendingRequests.delete(tag);
          reject(new Error(`Timeout: ${communiqueType} ${url}`));
        }
      }, timeout);
    });
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

  /** Send a SubscribeRequest. Events arrive via onEvent callback. */
  async subscribe(url: string): Promise<any> {
    return this.send("SubscribeRequest", url);
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
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
  const leapServer = servers.find((s: any) => s.Type === "LEAP") ?? servers[0] ?? {};
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
): Promise<{ zones: ZoneInfo[]; deviceMeta: Map<number, { area: string; station: string }> }> {
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
): Promise<{ zones: ZoneInfo[]; deviceMeta: Map<number, { area: string; station: string }> }> {
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
  leapVersion: number;
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
      device: p.stationName
        ? `${p.areaName} ${p.stationName}`
        : p.deviceName,
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
