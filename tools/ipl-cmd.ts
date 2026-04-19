#!/usr/bin/env npx tsx

/**
 * IPL write-path tester: sends Version3 LEI-framed Commands to an RA3
 * processor and prints any frames the processor sends back.
 *
 * Framing + body layouts reversed from Designer 26.0.2.100 .NET assemblies
 * (see docs/protocols/ipl.md). Shared protocol primitives live in lib/ipl.ts.
 *
 * Commands implemented:
 *   ping                                       -> opId 11 (empty body)
 *   gotolevel <zoneId> <pct> [fade] [delay]    -> opId 13 (OUTPUT, fade/delay sec)
 *   loadstate <zoneId> <pct> [fade] [delay] [fieldmask]
 *                                              -> opId 340 (color/vibrancy/CCT)
 *   setoutput <proc> <link> <serialHex> <comp> <pct>
 *                                              -> opId 44 (DEVICE, no fade)
 *   identify <objectId> <objectType> on|off [timeoutSec]
 *                                              -> opId 6 (RuntimeIdentify)
 *   devidentify <proc> <link> <serialHex> <comp> on|off
 *                                              -> opId 40 (DeviceSetIdentifyState)
 *   devreset <proc> <link> <serialHex> <comp>  -> opId 284 (FactoryResetDevice) DANGER
 *   ipl-version                                -> opId 338 (read-only request)
 *   schema                                     -> opId 335 (ReportSchemaVersion)
 *   dbsync-info                                -> opId 346 (ReportDatabaseSyncInfo)
 *   dbsync-uri                                 -> opId 344 (ask for DB URI)
 *   telnet-diag-user                           -> opId 92 (RequestTelnetDiagnosticUser)
 *   raw <opId> <bodyHex>                       -> escape hatch
 *
 * Common flags:
 *   --host <ip>       processor IP (default from config.json via lib/config)
 *   --port <n>        default 8902
 *   --listen <sec>    how long to stay connected after sending (default 4)
 *   --system <n>      systemId (default 1)
 *   --sender <n>      senderId (default 1)
 *   --receiver <n>    receiverId (default 255 = broadcast)
 *   --no-ack          use ReceiverProcessing.NoAck instead of Normal
 *   --yes             bypass confirmation on DANGER commands
 *   --decode          pretty-print known telemetry/event bodies
 */

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { connect } from "tls";
import { fileURLToPath } from "url";
import { defaultHost } from "../lib/config";
import {
  bodyDeviceSetIdentifyState,
  bodyDeviceSetOutputLevel,
  bodyDMXOutputFlash,
  bodyFactoryResetDevice,
  bodyGetRuntimeProperty,
  bodyGoToLevel,
  bodyGoToLoadState,
  bodyPingLinkDevice,
  bodyPresetGoToLiftAndTiltLevels,
  bodyProcessorSetDateTime,
  bodyRuntimeIdentify,
  bodySetRuntimeProperty,
  bodyShadeIdentifyOnInterfaceAddress,
  buildCommandFrame,
  CommandOp,
  decodeRuntimeTelemetry,
  level16ToPct,
  MsgType,
  MsgTypeName,
  ObjectType,
  type ParsedFrame,
  parseAllFrames,
  RuntimeProperty,
  resolveOpName,
} from "../lib/ipl";

const args = process.argv.slice(2);
const flagKeys = new Set([
  "--host",
  "--port",
  "--listen",
  "--system",
  "--sender",
  "--receiver",
]);
const getArg = (name: string) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (flagKeys.has(a)) {
    i++;
    continue;
  }
  if (a.startsWith("--")) continue;
  positional.push(a);
}

const __dir = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
const HOST = getArg("--host") ?? defaultHost ?? "10.1.1.133";
const PORT = Number.parseInt(getArg("--port") ?? "8902", 10);
const LISTEN_SECONDS = Number.parseFloat(getArg("--listen") ?? "4");
const SYSTEM_ID = Number.parseInt(getArg("--system") ?? "1", 10);
const SENDER_ID = Number.parseInt(getArg("--sender") ?? "1", 10);
const RECEIVER_ID = Number.parseInt(getArg("--receiver") ?? "255", 10);
const NO_ACK = args.includes("--no-ack");
const YES = args.includes("--yes");
const DECODE = args.includes("--decode");

const CERT_DIR = join(__dir, "..", "certs", "designer");
const clientCert = readFileSync(join(CERT_DIR, "ipl_client_cert.pem"));
const clientKey = readFileSync(join(CERT_DIR, "ipl_client_key.pem"));
const caCert = readFileSync(join(CERT_DIR, "radioRa3_products.crt"));

function frameOpts() {
  return {
    systemId: SYSTEM_ID,
    senderId: SENDER_ID,
    receiverId: RECEIVER_ID,
    messageId: 1,
    wantAck: !NO_ACK,
  };
}

// Decode a small set of well-known telemetry/event bodies inline so output
// is readable without firing up ipl-monitor.ts in parallel.
function decodeBody(f: ParsedFrame): string | null {
  if (f.msgType === MsgType.Telemetry && f.operationId === 1) {
    const t = decodeRuntimeTelemetry(f.body);
    if (!t) return null;
    let valStr = `0x${t.value.toString("hex")}`;
    const isLevel = t.propertyNumber === 1 || t.propertyNumber === 4;
    if (isLevel && t.value.length >= 3) {
      const lvl = t.value.readUInt16BE(1);
      valStr = `cmd=${t.value[0]} level=${level16ToPct(lvl)}% (0x${lvl.toString(16)})`;
    } else if (isLevel && t.value.length === 2) {
      const lvl = t.value.readUInt16BE(0);
      valStr = `level=${level16ToPct(lvl)}% (0x${lvl.toString(16)})`;
    } else if (t.value.length === 1) {
      valStr = `${t.value[0]}`;
    } else if (t.value.length === 2) {
      valStr = `0x${t.value.readUInt16BE(0).toString(16).padStart(4, "0")}`;
    }
    return `obj=${t.objectId} type=${t.objectType} ${t.propertyName}(${t.propertyNumber})=${valStr}`;
  }
  if (f.msgType === MsgType.Event && f.body.length >= 6) {
    const objId = f.body.readUInt32BE(0);
    const objType = f.body.readUInt16BE(4);
    const evt =
      f.operationId !== undefined
        ? (resolveOpName(f.msgType, f.operationId) ?? `?${f.operationId}`)
        : "?";
    return `${evt} obj=${objId} type=${objType} rest=${f.body.subarray(6).toString("hex")}`;
  }
  return null;
}

function formatFrame(f: ParsedFrame): string {
  const mt = MsgTypeName[f.msgType];
  const op = f.operationId;
  const opName = op === undefined ? "" : resolveOpName(f.msgType, op);
  const head = `LEI${String.fromCharCode(0x40 + f.msgType)} v${f.version} ${mt}/${f.receiverProcessing} sys=${f.systemId} s=${f.senderId}->r=${f.receiverId} seq=${f.messageId}${op !== undefined ? ` op=${op}(${opName})` : ""}`;
  if (DECODE) {
    const decoded = decodeBody(f);
    if (decoded) return `${head}\n    ${decoded}`;
  }
  const bodyHex = f.body.toString("hex");
  return `${head} body(${f.body.length}B)=${bodyHex.length > 80 ? `${bodyHex.slice(0, 80)}...` : bodyHex}`;
}

function requireConfirm(what: string) {
  if (!YES) {
    console.error(`refusing without --yes: ${what}`);
    process.exit(3);
  }
}

async function main() {
  const cmd = positional[0];
  if (!cmd) {
    console.error(
      [
        "commands:",
        "  -- output / zone level --",
        "  gotolevel <zoneId> <pct> [fade] [delay]              opId 13",
        "  loadstate <zoneId> <pct> [fade] [delay] [fieldmask]  opId 340 (color/CCT/vibrancy)",
        "  setoutput <proc> <link> <serialHex> <comp> <pct>     opId 44 (DEVICE path)",
        "  presettilt <zoneId> [liftPct] [tiltPct] [delay]      opId 82 (shade lift+tilt)",
        "  dmxflash <objectId> [flashRate]                      opId 15",
        "",
        "  -- runtime property R/W (generic) --",
        "  set-prop <obj> <objType> <propNameOrNum> <valueHex>  opId 7 (or 6 if prop=0)",
        "  get-prop <obj> <objType> <propNameOrNum>             opId 9",
        "",
        "  -- identify / commissioning --",
        "  identify <objectId> <objectType> on|off [timeoutSec] opId 6 (RuntimeIdentify)",
        "  devidentify <proc> <link> <serialHex> <comp> on|off  opId 40",
        "  shadeident <proc> <link> <ifAddr> next|prev|stop     opId 320",
        "  pinglink <objectId> [objectType=15]                  opId 279",
        "",
        "  -- destructive (require --yes) --",
        "  devreset <proc> <link> <serialHex> <comp>            opId 284 (FactoryResetDevice)",
        "",
        "  -- system --",
        "  ping                                                 opId 11",
        "  settime                                              opId 25 (sets to host wallclock)",
        "  ipl-version | schema | dbsync-info | dbsync-uri | telnet-diag-user",
        "  raw <opId> <bodyHex>",
      ].join("\n"),
    );
    process.exit(2);
  }

  const rest = positional.slice(1);
  let opId: number;
  let body: Buffer;

  switch (cmd) {
    case "ping":
      opId = CommandOp.Ping;
      body = Buffer.alloc(0);
      break;

    case "gotolevel": {
      const [zone, pct, fade = "1", delay = "0"] = rest;
      opId = CommandOp.GoToLevel;
      body = bodyGoToLevel(parseNum(zone), parseNum(pct), {
        fadeSec: parseNum(fade),
        delaySec: parseNum(delay),
      });
      break;
    }

    case "loadstate": {
      const [zone, pct, fade = "1", delay = "0", fieldmask = "1"] = rest;
      opId = CommandOp.GoToLoadState;
      body = bodyGoToLoadState({
        objectId: parseNum(zone),
        pct: parseNum(pct),
        fadeSec: parseNum(fade),
        delaySec: parseNum(delay),
        fieldmask: parseNum(fieldmask),
      });
      break;
    }

    case "setoutput": {
      const [proc, link, serial, comp, pct] = rest;
      opId = CommandOp.DeviceSetOutputLevel;
      body = bodyDeviceSetOutputLevel(
        parseNum(proc),
        parseNum(link),
        Number.parseInt(serial, 16),
        parseNum(comp),
        parseNum(pct),
      );
      break;
    }

    case "identify": {
      const [objId, objType, state, timeout = "255"] = rest;
      opId = CommandOp.RuntimeIdentify;
      body = bodyRuntimeIdentify(
        parseNum(objId),
        parseNum(objType),
        state === "on" || state === "start" || state === "1",
        parseNum(timeout),
      );
      break;
    }

    case "devidentify": {
      const [proc, link, serial, comp, state] = rest;
      opId = CommandOp.DeviceSetIdentifyState;
      body = bodyDeviceSetIdentifyState(
        parseNum(proc),
        parseNum(link),
        Number.parseInt(serial, 16),
        parseNum(comp),
        state === "on" || state === "start" || state === "1",
      );
      break;
    }

    case "devreset": {
      requireConfirm(`FactoryResetDevice on ${rest.join(" ")}`);
      const [proc, link, serial, comp] = rest;
      opId = CommandOp.FactoryResetDevice;
      body = bodyFactoryResetDevice(
        parseNum(proc),
        parseNum(link),
        Number.parseInt(serial, 16),
        parseNum(comp),
      );
      break;
    }

    case "presettilt": {
      const [zone, lift = "", tilt = "", delay = "0"] = rest;
      opId = CommandOp.PresetGoToLiftAndTiltLevels;
      body = bodyPresetGoToLiftAndTiltLevels({
        objectId: parseNum(zone),
        liftPct: lift === "" ? undefined : parseNum(lift),
        tiltPct: tilt === "" ? undefined : parseNum(tilt),
        delaySec: parseNum(delay),
      });
      break;
    }

    case "dmxflash": {
      const [obj, rate = "1"] = rest;
      opId = CommandOp.DMXOutputFlashLevel;
      body = bodyDMXOutputFlash(parseNum(obj), parseNum(rate));
      break;
    }

    case "pinglink": {
      const [obj, type = String(ObjectType.Zone)] = rest;
      opId = CommandOp.PingLinkDevice;
      body = bodyPingLinkDevice(parseNum(obj), parseNum(type));
      break;
    }

    case "shadeident": {
      const [proc, link, ifAddr, cmdName] = rest;
      const code =
        cmdName === "next"
          ? 0
          : cmdName === "prev" || cmdName === "previous"
            ? 1
            : 2;
      opId = CommandOp.ShadeIdentifyOnInterfaceAddress;
      body = bodyShadeIdentifyOnInterfaceAddress(
        parseNum(proc),
        parseNum(link),
        parseNum(ifAddr),
        code as 0 | 1 | 2,
      );
      break;
    }

    case "settime":
      opId = CommandOp.ProcessorSetDateTime;
      body = bodyProcessorSetDateTime();
      break;

    case "set-prop": {
      // set-prop <objectId> <objectType> <propertyName-or-num> <valueHex>
      const [obj, type, prop, hex = ""] = rest;
      const propNum = Number.isFinite(parseNum(prop))
        ? parseNum(prop)
        : RuntimeProperty[Number(prop)]
          ? Number(prop)
          : NaN;
      // Accept either a known name or a number
      const finalProp = Number.isFinite(propNum)
        ? propNum
        : Number(
            Object.entries(RuntimeProperty).find(([, v]) => v === prop)?.[0] ??
              "",
          );
      if (!Number.isFinite(finalProp)) {
        console.error(`unknown property: ${prop}`);
        process.exit(2);
      }
      opId =
        finalProp === 0
          ? CommandOp.RuntimeIdentify
          : CommandOp.SetRuntimeProperty;
      body = bodySetRuntimeProperty(
        parseNum(obj),
        parseNum(type),
        finalProp,
        Buffer.from(hex, "hex"),
      );
      break;
    }

    case "get-prop": {
      const [obj, type, prop] = rest;
      const finalProp = Number.isFinite(Number(prop))
        ? Number(prop)
        : Number(
            Object.entries(RuntimeProperty).find(([, v]) => v === prop)?.[0] ??
              NaN,
          );
      if (!Number.isFinite(finalProp)) {
        console.error(`unknown property: ${prop}`);
        process.exit(2);
      }
      opId = CommandOp.GetRuntimeProperty;
      body = bodyGetRuntimeProperty(parseNum(obj), parseNum(type), finalProp);
      break;
    }

    case "ipl-version":
      opId = CommandOp.ReportIPLProtocolVersion;
      body = Buffer.alloc(0);
      break;
    case "schema":
      opId = CommandOp.ReportSchemaVersion;
      body = Buffer.alloc(0);
      break;
    case "dbsync-info":
      opId = CommandOp.ReportDatabaseSyncInfo;
      body = Buffer.alloc(0);
      break;
    case "dbsync-uri":
      opId = CommandOp.DatabaseSyncUri;
      body = Buffer.alloc(0);
      break;
    case "telnet-diag-user":
      opId = CommandOp.RequestTelnetDiagnosticUser;
      body = Buffer.alloc(0);
      break;

    case "raw": {
      const [opStr, hex = ""] = rest;
      opId = parseNum(opStr);
      body = Buffer.from(hex, "hex");
      break;
    }

    default:
      console.error(`unknown command: ${cmd}`);
      process.exit(2);
  }

  const frame = buildCommandFrame(opId, body, frameOpts());
  const opName = resolveOpName(MsgType.Command, opId);
  console.log(
    `TX ${opName} op=${opId} body=${body.length}B frame=${frame.length}B\n   hex=${frame.toString("hex")}`,
  );

  const sock = connect({
    host: HOST,
    port: PORT,
    cert: clientCert,
    key: clientKey,
    ca: caCert,
    rejectUnauthorized: false,
  });

  // Accumulate RX bytes across TLS reads so multi-chunk frames parse cleanly.
  // Typed as any-Buffer so Buffer.concat / subarray don't fight the TS types.
  let rxBuf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  sock.on("secureConnect", () => {
    console.log(
      `Connected ${HOST}:${PORT} [${sock.getCipher()?.name ?? "?"}]; listening ${LISTEN_SECONDS}s\n`,
    );
    sock.write(frame);
  });
  sock.on("data", (chunk: Buffer) => {
    rxBuf = Buffer.concat([rxBuf, chunk]);
    const { frames, remainder } = parseAllFrames(rxBuf);
    rxBuf = remainder;
    for (const f of frames) console.log(`  ${formatFrame(f)}`);
  });
  sock.on("error", (err) => {
    console.error("socket error:", err.message);
    process.exit(1);
  });
  sock.on("close", () => console.log("(socket closed by peer)"));
  setTimeout(() => {
    console.log("\n--- done ---");
    sock.end();
    process.exit(0);
  }, LISTEN_SECONDS * 1000);
}

function parseNum(s: string | undefined): number {
  if (s === undefined) throw new Error("missing argument");
  const n = Number.parseFloat(s);
  if (!Number.isFinite(n)) throw new Error(`bad number: ${s}`);
  return n;
}

main();
