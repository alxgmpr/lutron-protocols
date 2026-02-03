// @bun
// src/server.ts
import { createSocket } from "dgram";
import { join } from "path";
var STATIC_DIR = join(import.meta.dir, "../../web/dist");
var ESP_TX_PORT = 9434;
var PACKET_TYPES = {
  136: "BTN_SHORT_A",
  137: "BTN_LONG_A",
  138: "BTN_SHORT_B",
  139: "BTN_LONG_B",
  129: "LEVEL_81",
  130: "LEVEL_82",
  131: "LEVEL_83",
  144: "DISCOVERY_B0",
  145: "BEACON_91",
  146: "BEACON_92",
  147: "BEACON_93",
  177: "PAIRING_B1",
  178: "PAIRING_B2",
  185: "PAIRING_B9"
};
var espHost = process.env.ESP_HOST || "cca-proxy.local";

class PacketServer {
  packets = [];
  maxPackets = 1000;
  clients = new Set;
  startTime = Date.now();
  txSocket;
  stats = {
    packetsReceived: 0,
    packetsDropped: 0,
    clientsConnected: 0,
    uptimeMs: 0,
    lastPacketTime: 0,
    espHost,
    udpPort: 9433
  };
  constructor() {
    this.startUdpReceiver();
    this.txSocket = createSocket("udp4");
  }
  sendToEsp(command, params) {
    return new Promise((resolve, reject) => {
      const msg = JSON.stringify({ cmd: command, ...params });
      const buf = Buffer.from(msg);
      this.txSocket.send(buf, ESP_TX_PORT, espHost, (err) => {
        if (err)
          reject(err);
        else
          resolve();
      });
    });
  }
  startUdpReceiver() {
    const udp = createSocket("udp4");
    udp.on("message", (msg, rinfo) => {
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
  parsePacket(buf) {
    if (buf.length < 3) {
      return null;
    }
    const flags = buf[0];
    const len = buf[1];
    if (buf.length < 2 + len || len < 6) {
      return null;
    }
    const data = buf.subarray(2, 2 + len);
    const direction = flags & 128 ? "tx" : "rx";
    const rssi = direction === "rx" ? -(flags & 127) : 0;
    const typeCode = data[0];
    const typeName = PACKET_TYPES[typeCode] ?? `0x${typeCode.toString(16).padStart(2, "0")}`;
    const deviceId = Array.from(data.subarray(2, 6)).map((b) => b.toString(16).padStart(2, "0")).join("");
    const seq = data[1];
    const rawHex = Array.from(data).map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const details = {
      seq
    };
    if (typeCode >= 136 && typeCode <= 139 && data.length > 10) {
      const button = data[10];
      const buttonNames = {
        1: "On",
        2: "Fav",
        3: "Off",
        4: "Raise",
        5: "Lower"
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
      rssi: direction === "rx" ? rssi : undefined
    };
  }
  handlePacket(pkt) {
    this.stats.packetsReceived++;
    this.stats.lastPacketTime = Date.now();
    this.packets.push(pkt);
    if (this.packets.length > this.maxPackets) {
      this.packets.shift();
    }
    const data = `data: ${JSON.stringify(pkt)}

`;
    for (const client of this.clients) {
      client.write(data).catch(() => {
        this.clients.delete(client);
        this.stats.clientsConnected = this.clients.size;
      });
    }
  }
  handleSSE(req) {
    const { readable, writable } = new TransformStream;
    const writer = writable.getWriter();
    this.clients.add(writer);
    this.stats.clientsConnected = this.clients.size;
    writer.write(`data: ${JSON.stringify({ type: "connected", clients: this.clients.size })}

`);
    req.signal.addEventListener("abort", () => {
      this.clients.delete(writer);
      this.stats.clientsConnected = this.clients.size;
      writer.close().catch(() => {});
    });
    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*"
      }
    });
  }
  handleGetPackets(req) {
    const url = new URL(req.url);
    const limit = parseInt(url.searchParams.get("limit") ?? "100", 10);
    const since = url.searchParams.get("since");
    let result = this.packets;
    if (since) {
      const sinceTime = new Date(since).getTime();
      result = result.filter((p) => new Date(p.timestamp).getTime() > sinceTime);
    }
    result = result.slice(-limit);
    return Response.json(result, {
      headers: { "Access-Control-Allow-Origin": "*" }
    });
  }
  handleGetStats() {
    this.stats.uptimeMs = Date.now() - this.startTime;
    this.stats.espHost = espHost;
    return Response.json(this.stats, {
      headers: { "Access-Control-Allow-Origin": "*" }
    });
  }
  handleGetConfig() {
    const now = Date.now();
    const lastPacketAge = this.stats.lastPacketTime > 0 ? (now - this.stats.lastPacketTime) / 1000 : null;
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
      healthy
    }, {
      headers: { "Access-Control-Allow-Origin": "*" }
    });
  }
  handleSetConfig(host) {
    espHost = host;
    this.stats.espHost = host;
    return Response.json({ status: "ok", host }, {
      headers: { "Access-Control-Allow-Origin": "*" }
    });
  }
  handleClearPackets() {
    this.packets = [];
    return Response.json({ success: true, message: "Packets cleared" }, {
      headers: { "Access-Control-Allow-Origin": "*" }
    });
  }
  async handleTxCommand(command, params) {
    try {
      await this.sendToEsp(command, params);
      return Response.json({
        status: "ok",
        command,
        ...params
      }, {
        headers: { "Access-Control-Allow-Origin": "*" }
      });
    } catch (err) {
      return Response.json({
        status: "error",
        error: String(err)
      }, {
        status: 500,
        headers: { "Access-Control-Allow-Origin": "*" }
      });
    }
  }
}
var server = new PacketServer;
var httpServer = Bun.serve({
  port: 5001,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }
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
          return Response.json({
            state: "IDLE",
            discovered_devices: [],
            selected_device: null,
            handshake_round: 0,
            error: null
          }, {
            headers: { "Access-Control-Allow-Origin": "*" }
          });
        case "/api/esp/config":
          if (req.method === "GET") {
            return server.handleGetConfig();
          }
          if (req.method === "POST") {
            const body = await req.json();
            if (body.host) {
              return server.handleSetConfig(body.host);
            }
            return Response.json({ error: "Missing host" }, { status: 400 });
          }
          break;
      }
      if (req.method === "POST") {
        const params = Object.fromEntries(url.searchParams);
        let body = {};
        try {
          const text = await req.text();
          if (text)
            body = JSON.parse(text);
        } catch {}
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
        }
      }
      return Response.json({ status: "error", error: "Not Found" }, {
        status: 404,
        headers: { "Access-Control-Allow-Origin": "*" }
      });
    }
    if (url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }
    let filePath = join(STATIC_DIR, url.pathname);
    let file = Bun.file(filePath);
    if (!await file.exists() || url.pathname === "/") {
      file = Bun.file(join(STATIC_DIR, "index.html"));
    }
    if (await file.exists()) {
      return new Response(file);
    }
    return new Response("Not Found", { status: 404 });
  }
});
console.log(`HTTP server listening on http://localhost:${httpServer.port}`);
console.log("API endpoints:");
console.log("  GET  /api/packets/stream - SSE stream of packets");
console.log("  GET  /api/packets        - Get recent packets");
console.log("  DELETE /api/packets      - Clear packet history");
console.log("  GET  /api/stats          - Server statistics");
