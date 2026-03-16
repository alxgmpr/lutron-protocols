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
import { getPresetInfo, getSerialName, presetIdFromDeviceId } from "./config";
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
  const zone = (body[BodyKey.ZONE] ?? [0, 0]) as number[];
  const sequence = (body[BodyKey.SEQUENCE] ?? 0) as number;

  return {
    type: "LEVEL_CONTROL",
    level,
    levelPercent: levelToPercent(level),
    zoneType: zone[0] ?? 0,
    zoneId: zone[1] ?? 0,
    fade,
    delay,
    sequence,
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

  return {
    type: "BUTTON_PRESS",
    deviceId,
    buttonZone: deviceId.length >= 2 ? deviceId[1] : 0,
    cmdType: deviceId.length >= 1 ? deviceId[0] : 0,
    counters,
    sequence,
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

  return {
    type: "ACK",
    responseCode,
    response,
    sequence,
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
    extra,
    sequence,
  };
}

/** Parse Presence (Type 65535) */
function parsePresence(body: CCXBody): CCXPresence {
  return {
    type: "PRESENCE",
    status: (body[BodyKey.STATUS] ?? 0) as number,
    sequence: (body[BodyKey.SEQUENCE] ?? 0) as number,
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
  return {
    type: "DIM_HOLD",
    deviceId,
    buttonZone: deviceId.length >= 2 ? deviceId[1] : 0,
    cmdType: deviceId.length >= 1 ? deviceId[0] : 0,
    action: inner[1] as number | undefined,
    zoneType: zone[0] ?? 0,
    zoneId: zone[1] ?? 0,
    sequence: (body[BodyKey.SEQUENCE] ?? 0) as number,
  };
}

/** Parse Dim Step (Type 3) — release/end of raise/lower */
function parseDimStep(body: CCXBody): CCXDimStep {
  const inner = (body[BodyKey.COMMAND] ?? {}) as Record<number, unknown>;
  const deviceId = extractDeviceId(inner);
  const zone = (body[BodyKey.ZONE] ?? [0, 0]) as number[];
  return {
    type: "DIM_STEP",
    deviceId,
    buttonZone: deviceId.length >= 2 ? deviceId[1] : 0,
    cmdType: deviceId.length >= 1 ? deviceId[0] : 0,
    action: inner[1] as number | undefined,
    stepValue: (inner[2] ?? 0) as number,
    zoneType: zone[0] ?? 0,
    zoneId: zone[1] ?? 0,
    sequence: (body[BodyKey.SEQUENCE] ?? 0) as number,
  };
}

/** Parse Device Report (Type 27) — broadcast by devices after commands */
function parseDeviceReport(body: CCXBody): CCXDeviceReport {
  const inner = (body[BodyKey.COMMAND] ?? {}) as Record<number, unknown>;
  const deviceInfo = (body[BodyKey.DEVICE] ?? [0, 0]) as number[];
  const extra = (body[BodyKey.EXTRA] ?? {}) as Record<number, unknown>;
  return {
    type: "DEVICE_REPORT",
    deviceType: deviceInfo[0] ?? 0,
    deviceSerial: deviceInfo[1] ?? 0,
    groupId: (extra[1] ?? 0) as number,
    innerData: inner,
  };
}

/** Parse Scene Recall (Type 36) */
function parseSceneRecall(body: CCXBody): CCXSceneRecall {
  const inner = (body[BodyKey.COMMAND] ?? {}) as Record<number, unknown>;
  const targets = (body[BodyKey.ZONE] ?? []) as number[];
  const extra = (body[BodyKey.EXTRA] ?? {}) as Record<number, unknown>;
  return {
    type: "SCENE_RECALL",
    command: inner[0],
    targets,
    sceneId: (extra[0] ?? 0) as number,
    params: (extra[2] ?? []) as number[],
    sequence: (body[BodyKey.SEQUENCE] ?? 0) as number,
  };
}

/** Parse Component Command (Type 40) — shades, fans, etc. */
function parseComponentCmd(body: CCXBody): CCXComponentCmd {
  const inner = (body[BodyKey.COMMAND] ?? {}) as Record<number, unknown>;
  const targets = (body[BodyKey.ZONE] ?? []) as number[];
  const extra = (body[BodyKey.EXTRA] ?? {}) as Record<number, unknown>;
  return {
    type: "COMPONENT_CMD",
    command: inner[0],
    targets,
    groupId: (extra[0] ?? 0) as number,
    params: (extra[2] ?? []) as number[],
    sequence: (body[BodyKey.SEQUENCE] ?? 0) as number,
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
      return `LEVEL_CONTROL(${state}, level=0x${msg.level.toString(16).padStart(4, "0")}, zone=${msg.zoneId}${fadeStr}${delayStr}, seq=${msg.sequence})`;
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
      return `ACK(response=${respHex}, seq=${msg.sequence})`;
    }
    case "STATUS": {
      const dataHex = Array.from(msg.innerData)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const preview =
        dataHex.length > 32 ? dataHex.slice(0, 32) + "..." : dataHex;
      return `STATUS(device=0x${msg.deviceId.toString(16).padStart(8, "0")}, data=${preview})`;
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
      const dir =
        msg.action === 3
          ? "RAISE"
          : msg.action === 2
            ? "LOWER"
            : `action=${msg.action}`;
      const zoneStr = msg.zoneId ? `, zone=${msg.zoneId}` : "";
      return `DIM_HOLD(${dir}, ${label}, id=${idHex}${zoneStr}, seq=${msg.sequence})`;
    }
    case "DIM_STEP": {
      const idHex = Array.from(msg.deviceId)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const presetId = presetIdFromDeviceId(msg.deviceId);
      const preset = getPresetInfo(presetId);
      const label = preset
        ? `"${preset.name}" [${preset.device}]`
        : `preset=${presetId}`;
      const dir =
        msg.action === 3
          ? "RAISE"
          : msg.action === 2
            ? "LOWER"
            : `action=${msg.action}`;
      const zoneStr = msg.zoneId ? `, zone=${msg.zoneId}` : "";
      return `DIM_STEP(${dir}, ${label}, step=${msg.stepValue}${zoneStr}, seq=${msg.sequence})`;
    }
    case "DEVICE_REPORT": {
      const serialName = getSerialName(msg.deviceSerial);
      const serialLabel = serialName
        ? `"${serialName}"`
        : `0x${msg.deviceSerial.toString(16).padStart(8, "0")}`;
      return `DEVICE_REPORT(${serialLabel}, serial=${msg.deviceSerial}, group=${msg.groupId})`;
    }
    case "SCENE_RECALL":
      return `SCENE_RECALL(scene=${msg.sceneId}, params=[${msg.params.join(",")}], seq=${msg.sequence})`;
    case "COMPONENT_CMD":
      return `COMPONENT_CMD(group=${msg.groupId}, params=[${msg.params.join(",")}], seq=${msg.sequence})`;
    case "PRESENCE":
      return `PRESENCE(status=${msg.status}, seq=${msg.sequence})`;
    case "UNKNOWN":
      return `UNKNOWN(type=${msg.msgType}, keys=[${Object.keys(msg.body).join(",")}], seq=${msg.sequence})`;
  }
}
