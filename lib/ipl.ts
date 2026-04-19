/**
 * IPL (Integration Protocol Lutron) protocol primitives.
 *
 * Reversed from Lutron Designer 26.0.2.100 .NET DLLs
 * (`Lutron.Gulliver.Infrastructure.dll` / `Lutron.Gulliver.NetworkFramework.dll`).
 * See docs/protocols/ipl.md for the full writeup.
 *
 * All multi-byte integers are big-endian. Strings on the wire (when present)
 * are UTF-16BE with a uint16 BE length prefix.
 *
 * Version3 frame layout:
 *   +0  "LEI"                       magic
 *   +3  packed: [Version:3][RP:1][Attempt:1][MsgType:3]
 *   +4  systemId (u16 BE)
 *   +6  senderId (u8)
 *   +7  receiverId (u8; 0xFF = broadcast)
 *   +8  messageId (u16 BE)
 *   +10 operationId (u16 BE)       -- if message HasOperationId
 *   +12 payloadLength (u16 BE)     -- if message HasPayload
 *   +14 payload bytes
 */

export enum MsgType {
  Command = 0,
  Acknowledgement = 1,
  Response = 2,
  Event = 3,
  Control = 4,
  Telemetry = 5,
}

export const MsgTypeName: Record<MsgType, string> = {
  [MsgType.Command]: "Cmd",
  [MsgType.Acknowledgement]: "Ack",
  [MsgType.Response]: "Rsp",
  [MsgType.Event]: "Evt",
  [MsgType.Control]: "Ctrl",
  [MsgType.Telemetry]: "Tlm",
};

/** Command.Operation enum values (from Lutron.Gulliver.Infrastructure.dll). */
export const CommandOp = {
  DataFileTransferBlock: 1,
  DataFileTransferComplete: 2,
  DatabaseDeleteAllObjects: 5,
  RuntimeIdentify: 6,
  SetRuntimeProperty: 7,
  SetConfigurationProperty: 8,
  GetRuntimeProperty: 9,
  GetConfigurationProperty: 10,
  Ping: 11,
  PresetActivate: 12,
  GoToLevel: 13,
  DMXOutputFlashLevel: 15,
  GoToScene: 16,
  Raise: 20,
  Lower: 21,
  StopRaiseLower: 22,
  ProcessorSetDateTime: 25,
  SetUpTemporaryGroups: 26,
  ChangeReference: 27,
  DiagnosticBeacon: 28,
  RemoveAllTemporaryGroups: 29,
  DeviceLinkAddressingMode: 36,
  DevOrLinkRequestPresentStatus: 37,
  DevicePresent: 38,
  DeviceComponentPresent: 39,
  DeviceSetIdentifyState: 40,
  DeviceAssignLinkAddress: 41,
  DeviceSetOutputLevel: 44,
  DeviceAssignComponentAddress: 45,
  DevOrLinkInitialize: 46,
  DeviceOrLinkCommandStatus: 47,
  DatabaseProcessPartialUpload: 48,
  TimeclockSetEnableState: 49,
  TestTimeclockEvent: 50,
  TestHyperionEvent: 54,
  DeviceOrComponentFinalizeAddressingMode: 55,
  DaliEmergencyTestStart: 58,
  DaliEmergencyTestStop: 59,
  RequestTweakChanges: 69,
  ConfigurationProperty: 70,
  EndConfigurationProperty: 71,
  GetNumberOfProjectTweaks: 81,
  PresetGoToLiftAndTiltLevels: 82,
  DataTransfer: 85,
  GoToColorTemperatureLevel: 87,
  RaiseColorTemperatureLevel: 88,
  LowerColorTemperatureLevel: 89,
  StopColorTemperatureLevel: 90,
  FirmwareUpgradeError: 91,
  RequestTelnetDiagnosticUser: 92,
  ClearFileSystem: 270,
  SendSystemFile: 271,
  UpdateDeviceFirmware: 272,
  UpdateProcessorFirmware: 273,
  RemoteLimitSetMode: 274,
  RemoteLimitSetRaiseLower: 275,
  RemoteLimitSetRaiseLowerStop: 276,
  RemoteLimitSetAssignOpenCloseLimit: 277,
  RemoteLimitSetCommandStatus: 278,
  PingLinkDevice: 279,
  PingLinkDeviceStatus: 280,
  FactoryResetDevice: 284,
  ProcessorSystemOperationMode: 285,
  ProcessorFirmwareUpdateStatus: 286,
  DeviceLinkRFComponentSelfIdentify: 288,
  DeviceFirmwareUpgradeMode: 290,
  AutoBallastReplacementMode: 291,
  MultipleGoToLevel: 293,
  DeviceLinkSetConfigProperty: 297,
  VerifyLowEndTrim: 298,
  SendDeviceToLowEndTrim: 299,
  RaiseRelativeLowEndTrim: 300,
  StopRaiseRelativeLowEndTrim: 301,
  SaveLowEndTrim: 302,
  CancelLowEndTrimSession: 303,
  SendDataTransferChecksum: 304,
  RequestObjectTweaks: 306,
  StartTweakedDataExtraction: 307,
  TweakedObjectDataBlock: 308,
  EndTweakedDataExtraction: 309,
  MyRoomDatabaseTransfer: 312,
  DevicesNumberOnInterfaceAddress: 313,
  ShadeIdentifyOnInterfaceAddress: 320,
  ResponseForInterfaceCommand: 321,
  QueryBallastProperty: 322,
  QueryBallastPropertyResponse: 323,
  SetBallastProperty: 324,
  DuplicateBallastAddressResponse: 325,
  DMXVerifyLinkWiring: 329,
  PrepareForDatabaseTransfer: 330,
  DatabaseUri: 331,
  DatabaseTransferStatus: 332,
  CompleteDatabaseTransfer: 333,
  ReportSchemaVersion: 335,
  ClearDeviceChecksums: 336,
  ReportIPLProtocolVersion: 338,
  RequestTransferStatus: 339,
  GoToLoadState: 340,
  RequestDeviceTransferStatus: 341,
  ReportDeviceTransferStatus: 342,
  DatabaseSyncUri: 344,
  ReportDatabaseSyncInfo: 346,
  RequestDeviceNotInDatabase: 347,
  ReportDeviceNotInDatabase: 348,
  /** Not in the enum in Infrastructure.dll but observed on RA3: the
   * named-RPC wrapper carrying zlib-JSON payloads (e.g. RequestSetLEDState). */
  NamedRPCWrapper: 349,
  Init: 65532,
  TestPing: 65533,
  TestFullReset: 65534,
  Test: 65535,
  Debug: 39321,
  EmulatorResetCommand: 65280,
  EmulatorTopologyTransferCommand: 65281,
  EmulatorBehaviorDescriptionCommand: 65282,
  EmulatorStartCommand: 65283,
} as const;

/** Reverse lookup — opId to name (best-effort; not every opId has a class). */
export const CommandOpName: Record<number, string> = Object.fromEntries(
  Object.entries(CommandOp).map(([k, v]) => [v, k]),
);

/** Resolve an opId to a name using the right enum for the frame's MsgType. */
export function resolveOpName(msgType: MsgType, op: number): string {
  if (msgType === MsgType.Event) return EventOp[op] ?? `evt${op}`;
  if (msgType === MsgType.Telemetry) {
    return op === 1 ? "Runtime" : op === 2 ? "Configuration" : `tlm${op}`;
  }
  if (msgType === MsgType.Control) {
    return (
      { 1: "RequestResendOne", 2: "RequestResendMany", 3: "ResendNAK" }[op] ??
      `ctrl${op}`
    );
  }
  // Command / Response — ack has no opId
  return CommandOpName[op] ?? `op${op}`;
}

/** Telemetry.Operation (inside an LEIE frame). */
export const TelemetryOp = {
  Runtime: 1,
  Configuration: 2,
} as const;

/** Control.Operation (inside an LEID frame). */
export const ControlOp = {
  RequestResendOne: 1,
  RequestResendMany: 2,
  ResendNegativeAcknowledgment: 3,
} as const;

/** EventAction.ProcessorEventIdType (operationId of an LEIC frame). */
export const EventOp: Record<number, string> = {
  0: "ButtonPress",
  1: "ButtonRelease",
  2: "ButtonMultiTap",
  3: "ButtonHold",
  4: "LogEntry",
  5: "CriticalFailure",
  6: "OccupancyStateChange",
  7: "TimeClockExecute",
  8: "DeviceParameterVerification",
  9: "DeviceUploadProgress",
  10: "SceneSave",
  11: "DeviceUpdateError",
  12: "LinkUpdateComplete",
  13: "AfterHoursEvent",
  15: "BACnetEvent",
  16: "HyperionEvent",
  17: "HyperionEndOfDay",
  18: "AutoReplaceEvent",
  22: "InfraRedSensorEvent",
  34: "CordlessWakeupPressEvent",
  35: "CordlessWakeupReleaseEvent",
  47: "IPAnnouncementEvent",
  51: "DeviceUploadProgrammingError",
  52: "DeviceUploadCriticalError",
  60: "IntegrationCommandEvent",
};

/** ObjectType — the set used in IPL commands (only common members listed). */
export const ObjectType = {
  Area: 2,
  ControlStation: 4,
  ControlStationDevice: 5,
  Zone: 15,
  Sensor: 17,
  LinkNode: 32,
  Link: 34,
  Scene: 41,
  Preset: 43,
  PresetAssignment: 44,
  Processor: 46,
  ProcessorSystem: 49,
  Button: 57,
  ShadeGroup: 133,
  OccupancyGroup: 38,
  Led: 107,
  HVACZone: 218,
  ShadeZone: 198,
  VenetianBlindZone: 199,
} as const;

/** OriginatorFeature — who/what issued a level change. Designer uses GUI. */
export const OriginatorFeature = {
  Unknown: 0,
  Bacnet: 1,
  Integration: 6,
  Leap: 7,
  Keypad: 8,
  GUI: 9,
  TimeClock: 16,
} as const;

/** level16 = percent * 0xFEFF / 100, clamped [0, 0xFEFF]. */
export function pctToLevel16(pct: number): number {
  const v = Math.round((pct * 0xfeff) / 100);
  return Math.max(0, Math.min(0xfeff, v));
}

/** Inverse — level16 back to percent (rounded). */
export function level16ToPct(level: number): number {
  return Math.round((level * 100) / 0xfeff);
}

/** Seconds → quarter-second ticks used by fade/delay fields. */
export function secToQuarters(sec: number): number {
  return Math.max(0, Math.min(0xffff, Math.round(sec * 4)));
}

// ---------- Frame builder ----------

const MAGIC = Buffer.from("LEI", "ascii");
const VERSION3 = 0x40;

export interface FrameOpts {
  systemId?: number;
  senderId?: number;
  receiverId?: number;
  messageId?: number;
  /** Expect ReceiverProcessing.Normal (server sends acks). Defaults to true. */
  wantAck?: boolean;
}

/**
 * Build a full Version3 Command frame: header + payload-length prefix + body.
 * `body` is the operation-specific body bytes (no length prefix).
 */
export function buildCommandFrame(
  operationId: number,
  body: Buffer,
  opts: FrameOpts = {},
): Buffer {
  const wantAck = opts.wantAck ?? true;
  const packed = VERSION3 | (wantAck ? 0x10 : 0x00) | MsgType.Command;
  const header = Buffer.alloc(12);
  MAGIC.copy(header, 0);
  header[3] = packed;
  header.writeUInt16BE(opts.systemId ?? 1, 4);
  header[6] = opts.senderId ?? 1;
  header[7] = opts.receiverId ?? 0xff;
  header.writeUInt16BE(opts.messageId ?? 0, 8);
  header.writeUInt16BE(operationId, 10);
  const lenPrefix = Buffer.alloc(2);
  lenPrefix.writeUInt16BE(body.length, 0);
  return Buffer.concat([header, lenPrefix, body]);
}

// ---------- Body encoders ----------

/** GoToLevel (opId 13) — OUTPUT-path zone level set with fade/delay. */
export function bodyGoToLevel(
  objectId: number,
  pct: number,
  opts: {
    objectType?: number;
    originator?: number;
    fadeSec?: number;
    delaySec?: number;
  } = {},
): Buffer {
  const b = Buffer.alloc(14);
  b.writeUInt32BE(objectId, 0);
  b.writeUInt16BE(opts.objectType ?? ObjectType.Zone, 4);
  b.writeUInt16BE(pctToLevel16(pct), 6);
  b.writeUInt16BE(opts.originator ?? OriginatorFeature.GUI, 8);
  b.writeUInt16BE(secToQuarters(opts.fadeSec ?? 1), 10);
  b.writeUInt16BE(secToQuarters(opts.delaySec ?? 0), 12);
  return b;
}

/** GoToLoadState (opId 340) — advanced zone set with color, vibrancy, CCT. */
export function bodyGoToLoadState(args: {
  objectId: number;
  objectType?: number;
  fieldmask: number;
  pct: number;
  fadeSec?: number;
  delaySec?: number;
  chromaticityX?: number;
  chromaticityY?: number;
  vibrancy?: number;
  warmDimCurveId?: number;
  cct?: number;
}): Buffer {
  const b = Buffer.alloc(26);
  b.writeUInt32BE(args.objectId, 0);
  b.writeUInt16BE(args.objectType ?? ObjectType.Zone, 4);
  b.writeUInt16BE(OriginatorFeature.GUI, 6); // hardcoded in Designer
  b[8] = args.fieldmask;
  b.writeUInt16BE(pctToLevel16(args.pct), 9);
  b.writeUInt16BE(secToQuarters(args.fadeSec ?? 1), 11);
  b.writeUInt16BE(secToQuarters(args.delaySec ?? 0), 13);
  b.writeUInt16BE(args.chromaticityX ?? 0, 15);
  b.writeUInt16BE(args.chromaticityY ?? 0, 17);
  b[19] = args.vibrancy ?? 0;
  b.writeUInt32BE(args.warmDimCurveId ?? 0, 20);
  b.writeUInt16BE(args.cct ?? 0, 24);
  return b;
}

/** DeviceSetOutputLevel (opId 44) — DEVICE-path set, no fade. */
export function bodyDeviceSetOutputLevel(
  procNum: number,
  linkNum: number,
  serial: number,
  component: number,
  pct: number,
): Buffer {
  const b = Buffer.alloc(10);
  b[0] = procNum;
  b[1] = linkNum;
  b.writeUInt32BE(serial, 2);
  b.writeUInt16BE(component, 6);
  b.writeUInt16BE(pctToLevel16(pct), 8);
  return b;
}

/** RuntimeIdentify (opId 6) — blink a device/zone to locate it. */
export function bodyRuntimeIdentify(
  objectId: number,
  objectType: number,
  start: boolean,
  timeoutSec = 255,
): Buffer {
  const b = Buffer.alloc(8);
  b.writeUInt32BE(objectId, 0);
  b.writeUInt16BE(objectType, 4);
  b[6] = start ? 1 : 0;
  b[7] = timeoutSec;
  return b;
}

/** DeviceSetIdentifyState (opId 40) — blink a specific physical device. */
export function bodyDeviceSetIdentifyState(
  procNum: number,
  linkNum: number,
  serial: number,
  component: number,
  start: boolean,
): Buffer {
  const b = Buffer.alloc(9);
  b[0] = procNum;
  b[1] = linkNum;
  b.writeUInt32BE(serial, 2);
  b.writeUInt16BE(component, 6);
  b[8] = start ? 1 : 0;
  return b;
}

/** FactoryResetDevice (opId 284) — DANGEROUS: wipes a device's programming. */
export function bodyFactoryResetDevice(
  procNum: number,
  linkNum: number,
  serial: number,
  component: number,
): Buffer {
  const b = Buffer.alloc(8);
  b[0] = procNum;
  b[1] = linkNum;
  b.writeUInt32BE(serial, 2);
  b.writeUInt16BE(component, 6);
  return b;
}

// ---------- Frame parser ----------

export interface ParsedFrame {
  magic: string;
  typeByte: number;
  version: number; // 1..8
  msgType: MsgType;
  receiverProcessing: "Normal" | "NoAck";
  attempt: "Original" | "Resend";
  systemId: number;
  senderId: number;
  receiverId: number;
  messageId: number;
  operationId?: number;
  body: Buffer;
  /** Offset of next frame in the containing buffer. */
  nextOffset: number;
}

/**
 * Find and parse a single LEI-framed message starting at `buf[pos]` (or after
 * advancing to the next `LEI` magic). Returns null if no complete frame fits.
 */
export function parseFrame(buf: Buffer, pos = 0): ParsedFrame | null {
  const i = buf.indexOf("LEI", pos);
  if (i < 0 || i + 12 > buf.length) return null;
  const typeByte = buf[i + 3];
  const version = ((typeByte & 0xe0) >> 5) + 1;
  const msgType = (typeByte & 0x07) as MsgType;
  const rp = typeByte & 0x10 ? "Normal" : "NoAck";
  const attempt = typeByte & 0x08 ? "Resend" : "Original";
  const systemId = buf.readUInt16BE(i + 4);
  const senderId = buf[i + 6];
  const receiverId = buf[i + 7];
  const messageId = buf.readUInt16BE(i + 8);

  let cursor = i + 10;

  // requestedAcknowledgementSet (16 bytes) only on Resend
  if (attempt === "Resend") {
    if (cursor + 16 > buf.length) return null;
    cursor += 16;
  }

  let operationId: number | undefined;
  const hasOp = msgType !== MsgType.Acknowledgement;
  if (hasOp) {
    if (cursor + 2 > buf.length) return null;
    operationId = buf.readUInt16BE(cursor);
    cursor += 2;
  }

  let body: Buffer = Buffer.alloc(0);
  const hasPayload = msgType !== MsgType.Acknowledgement;
  if (hasPayload) {
    if (cursor + 2 > buf.length) return null;
    const payloadLen = buf.readUInt16BE(cursor);
    cursor += 2;
    if (cursor + payloadLen > buf.length) return null;
    body = Buffer.from(buf.subarray(cursor, cursor + payloadLen));
    cursor += payloadLen;
  }

  return {
    magic: "LEI",
    typeByte,
    version,
    msgType,
    receiverProcessing: rp,
    attempt,
    systemId,
    senderId,
    receiverId,
    messageId,
    operationId,
    body,
    nextOffset: cursor,
  };
}

/** Greedy parse — extract all complete frames; return parsed frames + leftover bytes. */
export function parseAllFrames(buf: Buffer): {
  frames: ParsedFrame[];
  remainder: Buffer;
} {
  const frames: ParsedFrame[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const f = parseFrame(buf, pos);
    if (!f) break;
    frames.push(f);
    pos = f.nextOffset;
  }
  const remainder = Buffer.allocUnsafe(buf.length - pos);
  buf.copy(remainder, 0, pos);
  return { frames, remainder };
}
