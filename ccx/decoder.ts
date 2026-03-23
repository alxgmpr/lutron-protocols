/**
 * Lutron Clear Connect X (CCX) CBOR Decoder
 *
 * Decodes CBOR-encoded CCX messages from UDP port 9190.
 * All messages are CBOR arrays: [msg_type, body_map]
 *
 * Usage:
 *   import { decodeHex, decodeAndParse } from "./decoder";
 *   const msg = decodeAndParse("8200a300a20019feff03010182101903c105185c");
 *   console.log(msg); // CCXLevelControl { level: 0xFEFF, zone: 961, ... }
 */

import { decode as cborDecode } from "cbor-x";
import {
  getDeviceBySerial,
  getPresetInfo,
  getSceneName,
  getSerialName,
  getZoneName,
  presetIdFromDeviceId,
} from "./config";
import {
  BodyKey,
  CCXMessageType,
  CCXMessageTypeName,
  Level,
  levelToPercent,
} from "./constants";
import type {
  CCXAck,
  CCXBody,
  CCXButtonPress,
  CCXComponentCmd,
  CCXDeviceReport,
  CCXDeviceState,
  CCXDimHold,
  CCXDimStep,
  CCXLevelControl,
  CCXMessage,
  CCXPacket,
  CCXPresence,
  CCXSceneRecall,
  CCXStatus,
  CCXUnknown,
} from "./types";

/** Collect unknown keys from a CBOR map — anything not in consumed set */
function collectUnknown(
  map: Record<number, unknown>,
  consumed: Set<number>,
): Record<number, unknown> | undefined {
  const unknown: Record<number, unknown> = {};
  let hasAny = false;
  for (const k of Object.keys(map)) {
    const key = Number(k);
    if (!consumed.has(key)) {
      unknown[key] = map[key];
      hasAny = true;
    }
  }
  return hasAny ? unknown : undefined;
}

/** Derive direction string from action number */
function actionToDirection(
  action: number | undefined,
): "RAISE" | "LOWER" | undefined {
  if (action === 3) return "RAISE";
  if (action === 2) return "LOWER";
  return undefined;
}

/** Known ACK response codes */
const ACK_LABELS: Record<number, string> = {
  0x50: "LEVEL_ACK",
  0x55: "BUTTON_ACK",
};

/** Decode raw CBOR bytes into message type + body */
function decodeCbor(raw: Uint8Array): { msgType: number; body: CCXBody } {
  const decoded = cborDecode(raw);
  if (!Array.isArray(decoded) || decoded.length < 1) {
    throw new Error(
      `Invalid CCX message: expected CBOR array, got ${typeof decoded}`,
    );
  }
  const msgType = decoded[0] as number;
  const body = (decoded[1] ?? {}) as CCXBody;
  return { msgType, body };
}

/** Parse Level Control (Type 0) */
function parseLevelControl(body: CCXBody): CCXLevelControl {
  const inner = (body[BodyKey.COMMAND] ?? {}) as Record<number, unknown>;
  const level = (inner[0] ?? 0) as number;
  const fade = (inner[3] ?? 1) as number;
  const delay = (inner[4] ?? 0) as number;
  const warmDimMode = inner[5] as number | undefined;
  const cct = inner[6] as number | undefined;
  const zone = (body[BodyKey.ZONE] ?? [0, 0]) as number[];
  const sequence = (body[BodyKey.SEQUENCE] ?? 0) as number;

  // Collect unknown body keys
  const consumedBody = new Set([
    BodyKey.COMMAND,
    BodyKey.ZONE,
    BodyKey.SEQUENCE,
  ]);
  const consumedInner = new Set([0, 3, 4, 5, 6]);

  return {
    type: "LEVEL_CONTROL",
    level,
    levelPercent: levelToPercent(level),
    zoneType: zone[0] ?? 0,
    zoneId: zone[1] ?? 0,
    fade,
    delay,
    cct,
    warmDimMode,
    sequence,
    rawBody: body,
    unknownKeys:
      collectUnknown(body, consumedBody) ??
      collectUnknown(inner, consumedInner),
  };
}

/** Parse Button Press (Type 1) */
function parseButtonPress(body: CCXBody): CCXButtonPress {
  const inner = (body[BodyKey.COMMAND] ?? {}) as Record<number, unknown>;
  const rawDeviceId = inner[0];
  const deviceId =
    rawDeviceId instanceof Uint8Array ? rawDeviceId : new Uint8Array(0);
  const counters = (inner[1] ?? []) as number[];
  const sequence = (body[BodyKey.SEQUENCE] ?? 0) as number;

  const consumedBody = new Set([BodyKey.COMMAND, BodyKey.SEQUENCE]);

  return {
    type: "BUTTON_PRESS",
    deviceId,
    buttonZone: deviceId.length >= 2 ? deviceId[1] : 0,
    cmdType: deviceId.length >= 1 ? deviceId[0] : 0,
    counters,
    sequence,
    rawBody: body,
    unknownKeys: collectUnknown(body, consumedBody),
  };
}

/** Parse ACK (Type 7) */
function parseAck(body: CCXBody): CCXAck {
  const inner = (body[BodyKey.COMMAND] ?? {}) as Record<number, unknown>;
  const responseInner = (inner[1] ?? {}) as Record<number, unknown>;
  const rawResponse = responseInner[0];
  const response =
    rawResponse instanceof Uint8Array ? rawResponse : new Uint8Array(0);
  const responseCode = response.length > 0 ? response[0] : 0;
  const sequence = (body[BodyKey.SEQUENCE] ?? 0) as number;

  const consumedBody = new Set([BodyKey.COMMAND, BodyKey.SEQUENCE]);

  return {
    type: "ACK",
    responseCode,
    response,
    responseLabel: ACK_LABELS[responseCode],
    sequence,
    rawBody: body,
    unknownKeys: collectUnknown(body, consumedBody),
  };
}

/** Parse Status (Type 41) */
function parseStatus(body: CCXBody): CCXStatus {
  const inner = (body[BodyKey.COMMAND] ?? {}) as Record<number, unknown>;
  const rawInnerData = inner[2];
  const innerData =
    rawInnerData instanceof Uint8Array ? rawInnerData : new Uint8Array(0);
  const deviceInfo = (body[BodyKey.DEVICE] ?? [0, 0]) as number[];
  const sequence = (body[BodyKey.SEQUENCE] ?? 0) as number;
  const extraMap = (body[BodyKey.EXTRA] ?? {}) as Record<number, unknown>;
  const sceneFamilyId =
    typeof extraMap[1] === "number" ? (extraMap[1] as number) : undefined;

  // Collect extra fields (everything except command, device, sequence)
  const extra: Record<number, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    const key = Number(k);
    if (
      key !== BodyKey.COMMAND &&
      key !== BodyKey.DEVICE &&
      key !== BodyKey.SEQUENCE
    ) {
      extra[key] = v;
    }
  }

  return {
    type: "STATUS",
    innerData,
    deviceType: deviceInfo[0] ?? 0,
    deviceId: deviceInfo[1] ?? 0,
    sceneFamilyId,
    extra,
    sequence,
    rawBody: body,
  };
}

/** Parse Presence (Type 65535) */
function parsePresence(body: CCXBody): CCXPresence {
  const consumedBody = new Set([BodyKey.STATUS, BodyKey.SEQUENCE]);
  return {
    type: "PRESENCE",
    status: (body[BodyKey.STATUS] ?? 0) as number,
    sequence: (body[BodyKey.SEQUENCE] ?? 0) as number,
    rawBody: body,
    unknownKeys: collectUnknown(body, consumedBody),
  };
}

/** Extract device ID bytes from inner command map (shared by button/dim types) */
function extractDeviceId(inner: Record<number, unknown>): Uint8Array {
  const raw = inner[0];
  return raw instanceof Uint8Array ? raw : new Uint8Array(0);
}

/** Parse Dim Hold (Type 2) — start of raise/lower */
function parseDimHold(body: CCXBody): CCXDimHold {
  const inner = (body[BodyKey.COMMAND] ?? {}) as Record<number, unknown>;
  const deviceId = extractDeviceId(inner);
  const zone = (body[BodyKey.ZONE] ?? [0, 0]) as number[];
  const action = inner[1] as number | undefined;

  const consumedBody = new Set([
    BodyKey.COMMAND,
    BodyKey.ZONE,
    BodyKey.SEQUENCE,
  ]);

  return {
    type: "DIM_HOLD",
    deviceId,
    buttonZone: deviceId.length >= 2 ? deviceId[1] : 0,
    cmdType: deviceId.length >= 1 ? deviceId[0] : 0,
    action,
    direction: actionToDirection(action),
    zoneType: zone[0] ?? 0,
    zoneId: zone[1] ?? 0,
    sequence: (body[BodyKey.SEQUENCE] ?? 0) as number,
    rawBody: body,
    unknownKeys: collectUnknown(body, consumedBody),
  };
}

/** Parse Dim Step (Type 3) — release/end of raise/lower */
function parseDimStep(body: CCXBody): CCXDimStep {
  const inner = (body[BodyKey.COMMAND] ?? {}) as Record<number, unknown>;
  const deviceId = extractDeviceId(inner);
  const zone = (body[BodyKey.ZONE] ?? [0, 0]) as number[];
  const action = inner[1] as number | undefined;

  const consumedBody = new Set([
    BodyKey.COMMAND,
    BodyKey.ZONE,
    BodyKey.SEQUENCE,
  ]);

  return {
    type: "DIM_STEP",
    deviceId,
    buttonZone: deviceId.length >= 2 ? deviceId[1] : 0,
    cmdType: deviceId.length >= 1 ? deviceId[0] : 0,
    action,
    direction: actionToDirection(action),
    stepValue: (inner[2] ?? 0) as number,
    zoneType: zone[0] ?? 0,
    zoneId: zone[1] ?? 0,
    sequence: (body[BodyKey.SEQUENCE] ?? 0) as number,
    rawBody: body,
    unknownKeys: collectUnknown(body, consumedBody),
  };
}

/** Parse Device Report (Type 27) — broadcast by devices after commands */
function parseDeviceReport(body: CCXBody): CCXDeviceReport {
  const inner = (body[BodyKey.COMMAND] ?? {}) as Record<number, unknown>;
  const deviceInfo = (body[BodyKey.DEVICE] ?? [0, 0]) as number[];
  const extra = (body[BodyKey.EXTRA] ?? {}) as Record<number, unknown>;
  const sequence = (body[BodyKey.SEQUENCE] ?? 0) as number;

  // Extract level from inner command map
  // Format A: inner key 1 is a map with key 0 = 8-bit level
  // Format B: inner key 3 is array of tuples [idx, Uint8Array(2), outputType?] = uint16 BE level
  let level: number | undefined;
  let levelPercent: number | undefined;
  let outputType: number | undefined;

  const innerKey1 = inner[1];
  const innerKey3 = inner[3];

  if (
    innerKey1 !== null &&
    innerKey1 !== undefined &&
    typeof innerKey1 === "object" &&
    !Array.isArray(innerKey1) &&
    !(innerKey1 instanceof Uint8Array)
  ) {
    // Format A: inner[1] is a map, inner[1][0] is 8-bit level
    const rawLevel = (innerKey1 as Record<number, unknown>)[0];
    if (typeof rawLevel === "number") {
      // Scale 8-bit (0-255) to 16-bit (0-0xFEFF)
      level = Math.round((rawLevel / 255) * 0xfeff);
      levelPercent = levelToPercent(level);
    }
  } else if (Array.isArray(innerKey3)) {
    // Format B: inner[3] is array of tuples [idx, Uint8Array(2), outputType?]
    // Element [2] is observed as 2 or 3 — possibly zone_type or output_type
    for (const entry of innerKey3) {
      if (
        Array.isArray(entry) &&
        entry[1] instanceof Uint8Array &&
        entry[1].length === 2
      ) {
        level = (entry[1][0] << 8) | entry[1][1];
        levelPercent = levelToPercent(level);
        if (typeof entry[2] === "number") {
          outputType = entry[2];
        }
        break;
      }
    }
  }

  const consumedBody = new Set([
    BodyKey.COMMAND,
    BodyKey.DEVICE,
    BodyKey.EXTRA,
    BodyKey.SEQUENCE,
  ]);

  return {
    type: "DEVICE_REPORT",
    deviceType: deviceInfo[0] ?? 0,
    deviceSerial: deviceInfo[1] ?? 0,
    groupId: (extra[1] ?? 0) as number,
    innerData: inner,
    level,
    levelPercent,
    outputType,
    sequence,
    rawBody: body,
    unknownKeys: collectUnknown(body, consumedBody),
  };
}

/** Parse Scene Recall (Type 36) */
function parseSceneRecall(body: CCXBody): CCXSceneRecall {
  const inner = (body[BodyKey.COMMAND] ?? {}) as Record<number, unknown>;
  const targets = (body[BodyKey.ZONE] ?? []) as number[];
  const extra = (body[BodyKey.EXTRA] ?? {}) as Record<number, unknown>;
  const recallRaw = inner[0];
  const recallVector = Array.isArray(recallRaw)
    ? recallRaw.filter((v): v is number => typeof v === "number")
    : [];

  const consumedBody = new Set([
    BodyKey.COMMAND,
    BodyKey.ZONE,
    BodyKey.EXTRA,
    BodyKey.SEQUENCE,
  ]);

  return {
    type: "SCENE_RECALL",
    command: recallRaw,
    recallVector,
    targets,
    sceneId: (extra[0] ?? 0) as number,
    params: (extra[2] ?? []) as number[],
    sequence: (body[BodyKey.SEQUENCE] ?? 0) as number,
    rawBody: body,
    unknownKeys: collectUnknown(body, consumedBody),
  };
}

/** Parse Component Command (Type 40) — shades, fans, etc. */
function parseComponentCmd(body: CCXBody): CCXComponentCmd {
  const inner = (body[BodyKey.COMMAND] ?? {}) as Record<number, unknown>;
  const targets = (body[BodyKey.ZONE] ?? []) as number[];
  const extra = (body[BodyKey.EXTRA] ?? {}) as Record<number, unknown>;

  const consumedBody = new Set([
    BodyKey.COMMAND,
    BodyKey.ZONE,
    BodyKey.EXTRA,
    BodyKey.SEQUENCE,
  ]);

  return {
    type: "COMPONENT_CMD",
    command: inner[0],
    targets,
    groupId: (extra[0] ?? 0) as number,
    params: (extra[2] ?? []) as number[],
    sequence: (body[BodyKey.SEQUENCE] ?? 0) as number,
    rawBody: body,
    unknownKeys: collectUnknown(body, consumedBody),
  };
}

/** Parse Device State (Type 34) — component/output state notification */
function parseDeviceState(body: CCXBody): CCXDeviceState {
  const inner = (body[BodyKey.COMMAND] ?? {}) as Record<number, unknown>;
  const deviceInfo = (body[BodyKey.DEVICE] ?? [0, 0]) as number[];
  const sequence = (body[BodyKey.SEQUENCE] ?? 0) as number;

  const rawData = inner[2];
  const stateData = rawData instanceof Uint8Array ? rawData : undefined;

  const consumedBody = new Set([
    BodyKey.COMMAND,
    BodyKey.DEVICE,
    BodyKey.SEQUENCE,
  ]);

  return {
    type: "DEVICE_STATE",
    deviceType: deviceInfo[0] ?? 0,
    deviceSerial: deviceInfo[1] ?? 0,
    stateType: (inner[0] ?? 0) as number,
    stateValue: (inner[1] ?? 0) as number,
    stateData,
    sequence,
    rawBody: body,
    unknownKeys: collectUnknown(body, consumedBody),
  };
}

/** Parse CBOR body into typed CCX message */
export function parseMessage(msgType: number, body: CCXBody): CCXMessage {
  switch (msgType) {
    case CCXMessageType.LEVEL_CONTROL:
      return parseLevelControl(body);
    case CCXMessageType.BUTTON_PRESS:
      return parseButtonPress(body);
    case CCXMessageType.DIM_HOLD:
      return parseDimHold(body);
    case CCXMessageType.DIM_STEP:
      return parseDimStep(body);
    case CCXMessageType.ACK:
      return parseAck(body);
    case CCXMessageType.DEVICE_REPORT:
      return parseDeviceReport(body);
    case CCXMessageType.SCENE_RECALL:
      return parseSceneRecall(body);
    case CCXMessageType.COMPONENT_CMD:
      return parseComponentCmd(body);
    case CCXMessageType.DEVICE_STATE:
      return parseDeviceState(body);
    case CCXMessageType.STATUS:
      return parseStatus(body);
    case CCXMessageType.PRESENCE:
      return parsePresence(body);
    default:
      return {
        type: "UNKNOWN",
        msgType,
        body,
        sequence: (body[BodyKey.SEQUENCE] ?? 0) as number,
        rawBody: body,
      } satisfies CCXUnknown;
  }
}

/** Clean hex string (remove spaces, colons, commas, 0x prefix) */
function cleanHex(hex: string): string {
  return hex.replace(/[\s:,]/g, "").replace(/^0x/i, "");
}

/** Decode a hex string into raw msgType + body */
export function decodeHex(hex: string): {
  msgType: number;
  body: CCXBody;
} {
  const clean = cleanHex(hex);
  const raw = new Uint8Array(
    clean.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)),
  );
  return decodeCbor(raw);
}

/** Decode hex and parse into a typed CCX message */
export function decodeAndParse(hex: string): CCXMessage {
  const { msgType, body } = decodeHex(hex);
  return parseMessage(msgType, body);
}

/** Decode raw bytes and parse into a typed CCX message */
export function decodeBytes(raw: Uint8Array): CCXMessage {
  const { msgType, body } = decodeCbor(raw);
  return parseMessage(msgType, body);
}

/** Build a full CCXPacket from tshark fields and CBOR payload */
export function buildPacket(opts: {
  timestamp: string;
  srcAddr: string;
  dstAddr: string;
  srcEui64?: string;
  dstEui64?: string;
  payloadHex: string;
}): CCXPacket {
  const { msgType, body } = decodeHex(opts.payloadHex);
  const parsed = parseMessage(msgType, body);

  return {
    timestamp: opts.timestamp,
    srcAddr: opts.srcAddr,
    dstAddr: opts.dstAddr,
    srcEui64: opts.srcEui64 ?? "",
    dstEui64: opts.dstEui64 ?? "",
    msgType,
    body,
    parsed,
    rawHex: cleanHex(opts.payloadHex),
  };
}

/** Get human-readable name for a message type */
export function getMessageTypeName(msgType: number): string {
  return CCXMessageTypeName[msgType] ?? `UNKNOWN_${msgType}`;
}

// ── Raw body formatting (Phase 3B) ─────────────────────────────────

/** Format a value for raw CBOR display */
function formatRawValue(v: unknown): string {
  if (v instanceof Uint8Array) {
    return (
      "h'" +
      Array.from(v)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("") +
      "'"
    );
  }
  if (typeof v === "number") {
    return v >= 256 ? `0x${v.toString(16).toUpperCase()}` : String(v);
  }
  if (Array.isArray(v)) {
    return `[${v.map(formatRawValue).join(", ")}]`;
  }
  if (v !== null && v !== undefined && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
      .map(([k, val]) => `${k}: ${formatRawValue(val)}`)
      .join(", ");
    return `{${entries}}`;
  }
  return String(v);
}

/** Format a raw CBOR body as compact readable notation */
export function formatRawBody(body: CCXBody): string {
  const entries = Object.entries(body)
    .map(([k, v]) => `${k}: ${formatRawValue(v)}`)
    .join(", ");
  return `{${entries}}`;
}

// ── Human-readable formatting ───────────────────────────────────────

/** Format a CCXMessage for human-readable display */
export function formatMessage(msg: CCXMessage): string {
  switch (msg.type) {
    case "LEVEL_CONTROL": {
      let state: string;
      if (msg.level === Level.OFF) state = "OFF";
      else if (msg.level === Level.FULL_ON) state = "FULL_ON";
      else state = `${msg.levelPercent.toFixed(1)}%`;
      const fadeSec = msg.fade / 4;
      const fadeStr = fadeSec !== 0.25 ? `, fade=${fadeSec}s` : "";
      const delayStr = msg.delay > 0 ? `, delay=${msg.delay / 4}s` : "";
      const cctStr = msg.cct != null ? `, cct=${msg.cct}K` : "";
      const warmDimStr = msg.warmDimMode != null ? ", warm_dim" : "";
      const zoneName = getZoneName(msg.zoneId);
      const zoneAnnotation = zoneName ? ` [${zoneName}]` : "";
      return `LEVEL_CONTROL(${state}, level=0x${msg.level.toString(16).padStart(4, "0")}, zone=${msg.zoneId}${zoneAnnotation}${fadeStr}${delayStr}${cctStr}${warmDimStr}, seq=${msg.sequence})`;
    }
    case "BUTTON_PRESS": {
      const idHex = Array.from(msg.deviceId)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const presetId = presetIdFromDeviceId(msg.deviceId);
      const preset = getPresetInfo(presetId);
      const label = preset
        ? `"${preset.name}" [${preset.device}] (${preset.role})`
        : `preset=${presetId}`;
      return `BUTTON_PRESS(${label}, id=${idHex}, seq=${msg.sequence})`;
    }
    case "ACK": {
      const respHex = Array.from(msg.response)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const labelStr = msg.responseLabel ? ` ${msg.responseLabel}` : "";
      return `ACK(${labelStr}, response=${respHex}, seq=${msg.sequence})`;
    }
    case "STATUS": {
      const dataHex = Array.from(msg.innerData)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const preview =
        dataHex.length > 32 ? dataHex.slice(0, 32) + "..." : dataHex;
      const serialName = getSerialName(msg.deviceId);
      const nameStr = serialName
        ? `"${serialName}"`
        : `0x${msg.deviceId.toString(16).padStart(8, "0")}`;
      const sceneFamilyStr =
        msg.sceneFamilyId !== undefined
          ? `, scene_family=${msg.sceneFamilyId}`
          : "";
      const bodyKeys = msg.rawBody
        ? `, keys=[${Object.keys(msg.rawBody).join(",")}]`
        : "";
      return `STATUS(${nameStr}, device=${msg.deviceId}${sceneFamilyStr}${bodyKeys}, data=${preview})`;
    }
    case "DIM_HOLD": {
      const idHex = Array.from(msg.deviceId)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const presetId = presetIdFromDeviceId(msg.deviceId);
      const preset = getPresetInfo(presetId);
      const label = preset
        ? `"${preset.name}" [${preset.device}]`
        : `preset=${presetId}`;
      const dir = msg.direction ?? `action=${msg.action}`;
      const zoneName = msg.zoneId ? getZoneName(msg.zoneId) : undefined;
      const zoneStr = msg.zoneId
        ? `, zone=${msg.zoneId}${zoneName ? ` [${zoneName}]` : ""}`
        : "";
      return `DIM_HOLD(${dir}, ${label}, id=${idHex}${zoneStr}, seq=${msg.sequence})`;
    }
    case "DIM_STEP": {
      const presetId = presetIdFromDeviceId(msg.deviceId);
      const preset = getPresetInfo(presetId);
      const label = preset
        ? `"${preset.name}" [${preset.device}]`
        : `preset=${presetId}`;
      const dir = msg.direction ?? `action=${msg.action}`;
      const zoneName = msg.zoneId ? getZoneName(msg.zoneId) : undefined;
      const zoneStr = msg.zoneId
        ? `, zone=${msg.zoneId}${zoneName ? ` [${zoneName}]` : ""}`
        : "";
      return `DIM_STEP(${dir}, ${label}, step=${msg.stepValue}${zoneStr}, seq=${msg.sequence})`;
    }
    case "DEVICE_REPORT": {
      const serialName = getSerialName(msg.deviceSerial);
      const dev = getDeviceBySerial(msg.deviceSerial);
      const nameStr = serialName
        ? `"${serialName}"`
        : `0x${msg.deviceSerial.toString(16).padStart(8, "0")}`;
      const areaStr = dev?.area ? ` [${dev.area}]` : "";
      const levelStr =
        msg.levelPercent !== undefined
          ? `, level=${msg.levelPercent.toFixed(1)}%`
          : "";
      const outStr =
        msg.outputType !== undefined ? `, out=${msg.outputType}` : "";
      const groupName = msg.groupId ? getSceneName(msg.groupId) : undefined;
      const groupStr = msg.groupId
        ? `, group=${msg.groupId}${groupName ? ` "${groupName}"` : ""}`
        : "";
      return `DEVICE_REPORT(${nameStr}${areaStr}, serial=${msg.deviceSerial}${levelStr}${outStr}${groupStr}, seq=${msg.sequence})`;
    }
    case "DEVICE_STATE": {
      const serialName = getSerialName(msg.deviceSerial);
      const nameStr = serialName
        ? `"${serialName}"`
        : `serial=${msg.deviceSerial}`;
      const dataHex = msg.stateData
        ? Array.from(msg.stateData)
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("")
        : "";
      const dataStr = dataHex ? `, data=0x${dataHex}` : "";
      return `DEVICE_STATE(${nameStr}, type=${msg.stateType}, val=${msg.stateValue}${dataStr}, seq=${msg.sequence})`;
    }
    case "SCENE_RECALL": {
      const sceneName = getSceneName(msg.sceneId);
      const sceneStr = sceneName
        ? `scene=${msg.sceneId} "${sceneName}"`
        : `scene=${msg.sceneId}`;
      return `SCENE_RECALL(${sceneStr}, recall=[${msg.recallVector.join(",")}], params=[${msg.params.join(",")}], seq=${msg.sequence})`;
    }
    case "COMPONENT_CMD": {
      const groupName = getSceneName(msg.groupId);
      const groupStr = groupName
        ? `group=${msg.groupId} "${groupName}"`
        : `group=${msg.groupId}`;
      return `COMPONENT_CMD(${groupStr}, params=[${msg.params.join(",")}], seq=${msg.sequence})`;
    }
    case "PRESENCE":
      return `PRESENCE(status=${msg.status}, seq=${msg.sequence})`;
    case "UNKNOWN":
      return `UNKNOWN(type=${msg.msgType}, keys=[${Object.keys(msg.body).join(",")}], seq=${msg.sequence})`;
  }
}
