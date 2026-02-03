/**
 * CCA Packet Server
 *
 * High-performance UDP packet receiver and SSE broadcaster for Lutron CCA RF packets.
 * Serves the React frontend and provides API endpoints.
 *
 * Architecture:
 *   ESP32 --UDP--> [UDP Socket] --> [Packet Queue] --> [SSE Broadcaster] --> Frontends
 *
 * Ports:
 *   - 9433: UDP RX (packets from ESP32)
 *   - 5001: HTTP API + SSE stream + static frontend
 */

import { createSocket, type RemoteInfo, type Socket } from "dgram";
import { join } from "path";

// Path to built frontend
const STATIC_DIR = join(import.meta.dir, "../../web/dist");

// ESP32 TX port (for sending commands)
const ESP_TX_PORT = 9434;

// Packet types
const PACKET_TYPES: Record<number, string> = {
  0x88: "BTN_SHORT_A",
  0x89: "BTN_LONG_A",
  0x8a: "BTN_SHORT_B",
  0x8b: "BTN_LONG_B",
  0x81: "LEVEL_81",
  0x82: "LEVEL_82",
  0x83: "LEVEL_83",
  0x90: "DISCOVERY_B0",
  0x91: "BEACON_91",
  0x92: "BEACON_92",
  0x93: "BEACON_93",
  0xb0: "DIMMER_DISCOVERY",
  0xb1: "PAIRING_B1",
  0xb2: "PAIRING_B2",
  0xb8: "VIVE_DEVICE_REQ",   // Device pairing request to hub
  0xb9: "PAIRING_B9",
  0xba: "VIVE_BEACON",       // Vive hub enter pairing mode
  0xbb: "VIVE_ACCEPT",       // Vive hub accept/exit pairing
};

// Packet format expected by frontend
interface Packet {
  direction: "rx" | "tx";
  type: string;
  time: string;
  device_id?: string;
  source_id?: string;
  summary?: string;
  details?: Record<string, string | number | boolean>;
  raw_hex?: string;
  rssi?: number;
}

interface Stats {
  packetsReceived: number;
  packetsDropped: number;
  clientsConnected: number;
  uptimeMs: number;
  lastPacketTime: number;
  espHost: string;
  udpPort: number;
}

// ESP32 host configuration (can be changed at runtime)
let espHost = process.env.ESP_HOST || "cca-proxy.local";

class PacketServer {
  private packets: Packet[] = [];
  private maxPackets = 1000; // Keep last 1000 packets
  private clients = new Set<WritableStreamDefaultWriter>();
  private startTime = Date.now();
  private txSocket: Socket;
  private stats: Stats = {
    packetsReceived: 0,
    packetsDropped: 0,
    clientsConnected: 0,
    uptimeMs: 0,
    lastPacketTime: 0,
    espHost: espHost,
    udpPort: 9433,
  };

  constructor() {
    this.startUdpReceiver();
    this.txSocket = createSocket("udp4");
  }

  /** Send a command to the ESP32 via UDP */
  sendToEsp(command: string, params: Record<string, unknown>): Promise<void> {
    return new Promise((resolve, reject) => {
      const msg = JSON.stringify({ cmd: command, ...params });
      const buf = Buffer.from(msg);
      this.txSocket.send(buf, ESP_TX_PORT, espHost, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private startUdpReceiver() {
    const udp = createSocket("udp4");

    udp.on("message", (msg: Buffer, rinfo: RemoteInfo) => {
      try {
        const pkt = this.parsePacket(msg);
        if (pkt) {
          this.handlePacket(pkt);
        }
      } catch (e) {
        console.error("Failed to parse packet:", e);
      }
    });

    udp.on("error", (err) => {
      console.error("UDP error:", err);
    });

    udp.bind(9433, () => {
      console.log("UDP listening on port 9433");
    });
  }

  private parsePacket(buf: Buffer): Packet | null {
    if (buf.length < 3) {
      return null;
    }

    // Format: [FLAGS:1][LEN:1][DATA:N]
    // FLAGS: bit 7 = direction (0=RX, 1=TX), bits 0-6 = |RSSI| for RX
    const flags = buf[0];
    const len = buf[1];

    if (buf.length < 2 + len || len < 6) {
      return null; // Too short to contain device ID
    }

    const data = buf.subarray(2, 2 + len);
    const direction = (flags & 0x80) ? "tx" : "rx";
    const rssi = direction === "rx" ? -(flags & 0x7f) : 0;

    const typeCode = data[0];
    const typeName = PACKET_TYPES[typeCode] ?? `0x${typeCode.toString(16).padStart(2, "0")}`;

    // Extract device ID (bytes 2-5, big-endian)
    const deviceId = Array.from(data.subarray(2, 6))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // Extract sequence number (byte 1)
    const seq = data[1];

    // Format raw hex with spaces
    const rawHex = Array.from(data)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ");

    // Build details object
    const details: Record<string, string | number | boolean> = {
      seq,
    };

    // Add button info for button packets
    if (typeCode >= 0x88 && typeCode <= 0x8b && data.length > 10) {
      const button = data[10];
      const buttonNames: Record<number, string> = {
        0x01: "On",
        0x02: "Fav",
        0x03: "Off",
        0x04: "Raise",
        0x05: "Lower",
      };
      details.button = buttonNames[button] ?? `0x${button.toString(16)}`;
    }

    return {
      direction,
      type: typeName,
      time: new Date().toISOString(),
      device_id: deviceId,
      summary: deviceId,
      details,
      raw_hex: rawHex,
      rssi: direction === "rx" ? rssi : undefined,
    };
  }

  private handlePacket(pkt: Packet) {
    this.stats.packetsReceived++;
    this.stats.lastPacketTime = Date.now();

    // Store packet (with limit)
    this.packets.push(pkt);
    if (this.packets.length > this.maxPackets) {
      this.packets.shift();
    }

    // Broadcast to all SSE clients
    const data = `data: ${JSON.stringify(pkt)}\n\n`;
    for (const client of this.clients) {
      client.write(data).catch(() => {
        this.clients.delete(client);
        this.stats.clientsConnected = this.clients.size;
      });
    }
  }

  handleSSE(req: Request): Response {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    this.clients.add(writer);
    this.stats.clientsConnected = this.clients.size;

    // Send initial connection message
    writer.write(`data: ${JSON.stringify({ type: "connected", clients: this.clients.size })}\n\n`);

    // Heartbeat every 15 seconds to keep connection alive
    const heartbeat = setInterval(() => {
      writer.write(`: heartbeat\n\n`).catch(() => {});
    }, 15000);

    // Clean up on disconnect
    req.signal.addEventListener("abort", () => {
      clearInterval(heartbeat);
      this.clients.delete(writer);
      this.stats.clientsConnected = this.clients.size;
      writer.close().catch(() => {});
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  handleGetPackets(req: Request): Response {
    const url = new URL(req.url);
    const limit = parseInt(url.searchParams.get("limit") ?? "100", 10);
    const since = url.searchParams.get("since");
    const device = url.searchParams.get("device");
    const direction = url.searchParams.get("direction");

    let result = this.packets;

    if (since) {
      const sinceTime = new Date(since).getTime();
      result = result.filter((p) => new Date(p.time).getTime() > sinceTime);
    }
    if (device) {
      const normalized = device.replace(/^0x/i, "").toLowerCase();
      result = result.filter((p) => {
        const pid = (p.device_id ?? "").toLowerCase();
        const psrc = (p.source_id ?? "").toLowerCase();
        const ptarget = (p as Record<string, string | undefined>).target_id?.toLowerCase();
        return pid === normalized || psrc === normalized || ptarget === normalized;
      });
    }
    if (direction === "rx" || direction === "tx") {
      result = result.filter((p) => p.direction === direction);
    }

    result = result.slice(-limit);

    return Response.json(result, {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }

  handleGetStats(): Response {
    this.stats.uptimeMs = Date.now() - this.startTime;
    this.stats.espHost = espHost;
    return Response.json(this.stats, {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }

  handleGetConfig(): Response {
    const now = Date.now();
    const lastPacketAge = this.stats.lastPacketTime > 0
      ? (now - this.stats.lastPacketTime) / 1000
      : null;

    // Consider healthy if we received a packet in the last 30 seconds
    const receivingPackets = lastPacketAge !== null && lastPacketAge < 30;
    const healthy = receivingPackets && this.stats.clientsConnected > 0;

    return Response.json({
      host: espHost,
      port: 9433,
      default_host: "cca-proxy.local",
      last_packet_age: lastPacketAge,
      packets_received: this.stats.packetsReceived,
      clients_connected: this.stats.clientsConnected,
      receiving_packets: receivingPackets,
      healthy,
    }, {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }

  handleSetConfig(host: string): Response {
    espHost = host;
    this.stats.espHost = host;
    return Response.json({ status: "ok", host }, {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }

  handleClearPackets(): Response {
    this.packets = [];
    return Response.json({ success: true, message: "Packets cleared" }, {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }

  /** Handle TX command - send to ESP32 and return response */
  async handleTxCommand(command: string, params: Record<string, unknown>): Promise<Response> {
    try {
      await this.sendToEsp(command, params);
      return Response.json({
        status: "ok",
        command,
        ...params
      }, {
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    } catch (err) {
      return Response.json({
        status: "error",
        error: String(err)
      }, {
        status: 500,
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }
  }
}

// Create server instance
const server = new PacketServer();

// HTTP server
const httpServer = Bun.serve({
  port: 5001,
  idleTimeout: 255, // Max value (255 seconds) for SSE connections
  async fetch(req) {
    const url = new URL(req.url);

    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    // API Routes
    if (url.pathname.startsWith("/api/")) {
      switch (url.pathname) {
        case "/api/packets/stream":
          return server.handleSSE(req);

        case "/api/packets":
          if (req.method === "GET") {
            return server.handleGetPackets(req);
          }
          if (req.method === "DELETE") {
            return server.handleClearPackets();
          }
          break;

        case "/api/stats":
          return server.handleGetStats();

        case "/api/bridge/pair/status":
          // Stub - pairing status tracking not yet implemented
          return Response.json({
            state: "IDLE",
            discovered_devices: [],
            selected_device: null,
            handshake_round: 0,
            error: null
          }, {
            headers: { "Access-Control-Allow-Origin": "*" },
          });

        case "/api/esp/config":
          if (req.method === "GET") {
            return server.handleGetConfig();
          }
          if (req.method === "POST") {
            const body = await req.json() as { host?: string };
            if (body.host) {
              return server.handleSetConfig(body.host);
            }
            return Response.json({ error: "Missing host" }, { status: 400 });
          }
          break;
      }

      // TX Commands - send to ESP32
      if (req.method === "POST") {
        const params = Object.fromEntries(url.searchParams);
        let body: Record<string, unknown> = {};
        try {
          const text = await req.text();
          if (text) body = JSON.parse(text);
        } catch { /* ignore parse errors for query-string style requests */ }
        const allParams = { ...params, ...body };

        switch (url.pathname) {
          case "/api/send":
            return server.handleTxCommand("button", allParams);
          case "/api/level":
            return server.handleTxCommand("level", allParams);
          case "/api/reset":
            return server.handleTxCommand("reset", allParams);
          case "/api/state":
            return server.handleTxCommand("state", allParams);
          case "/api/unpair":
            return server.handleTxCommand("unpair", allParams);
          case "/api/save-favorite":
            return server.handleTxCommand("save_favorite", allParams);
          case "/api/pair-pico":
            return server.handleTxCommand("pair_pico", allParams);
          case "/api/config/fade":
            return server.handleTxCommand("config_fade", allParams);
          case "/api/config/led":
            return server.handleTxCommand("config_led", allParams);
          case "/api/config/trim":
            return server.handleTxCommand("config_trim", allParams);
          case "/api/config/phase":
            return server.handleTxCommand("config_phase", allParams);
          case "/api/pairing/start":
            return server.handleTxCommand("pairing_start", allParams);
          case "/api/pairing/stop":
            return server.handleTxCommand("pairing_stop", allParams);
          case "/api/pairing/pair":
            return server.handleTxCommand("pairing_pair", allParams);
          case "/api/pairing/assign":
            return server.handleTxCommand("pairing_assign", allParams);
          case "/api/bridge/pair":
            return server.handleTxCommand("bridge_pair", allParams);
          case "/api/bridge/pair/stop":
            return server.handleTxCommand("bridge_pair_stop", allParams);
          case "/api/bridge/pair/select":
            return server.handleTxCommand("bridge_pair_select", allParams);
          // Vive pairing endpoints
          case "/api/vive/start":
            return server.handleTxCommand("vive_start", allParams);
          case "/api/vive/stop":
            return server.handleTxCommand("vive_stop", allParams);
          case "/api/vive/beacon":
            return server.handleTxCommand("vive_beacon", allParams);
          case "/api/vive/accept":
            return server.handleTxCommand("vive_accept", allParams);
          case "/api/vive/on":
            return server.handleTxCommand("vive_on", allParams);
          case "/api/vive/off":
            return server.handleTxCommand("vive_off", allParams);
          case "/api/vive/raise":
            return server.handleTxCommand("vive_raise", allParams);
          case "/api/vive/lower":
            return server.handleTxCommand("vive_lower", allParams);
          case "/api/vive/toggle":
            return server.handleTxCommand("vive_toggle", allParams);
          case "/api/vive/cmd":
            return server.handleTxCommand("vive_cmd", allParams);
        }
      }

      return Response.json({ status: "error", error: "Not Found" }, {
        status: 404,
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }

    if (url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    // Serve static files from web/dist
    let filePath = join(STATIC_DIR, url.pathname);
    let file = Bun.file(filePath);

    // If file doesn't exist or is a directory, serve index.html (SPA fallback)
    if (!(await file.exists()) || url.pathname === "/") {
      file = Bun.file(join(STATIC_DIR, "index.html"));
    }

    if (await file.exists()) {
      return new Response(file);
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`HTTP server listening on http://localhost:${httpServer.port}`);
console.log("API endpoints:");
console.log("  GET  /api/packets/stream - SSE stream of packets");
console.log("  GET  /api/packets        - Get recent packets");
console.log("  DELETE /api/packets      - Clear packet history");
console.log("  GET  /api/stats          - Server statistics");
