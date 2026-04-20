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
  /** Wraps a telnet-style ASCII string (`#DEVICE,id,btn,action\n` etc.) and
   * dispatches it through the processor's INTEGRATION_COMMAND_PROCESSOR.
   * The only path for simulating keypad button presses from an external IPL
   * client on RA3 (LEIC ButtonPress events are broadcast-only; telnet :23 is
   * closed). Verified on firmware v26.01.13f000. */
  IntegrationCommand: 60,
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
  /** Backing object for an OUTPUT zone — Level Telemetry from a Zone change is
   * delivered against the LoadController, not the Zone itself. Resolve via
   * `/loadcontroller/<id>` then follow `AssociatedZone.href`. */
  LoadController: 3,
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

/** OccupancyStatus values seen in OccupancyStatusChanged events / property 16. */
export const OccupancyStatus: Record<number, string> = {
  1: "Unknown",
  3: "Occupied",
  4: "Unoccupied",
  255: "Disabled",
};

/**
 * RuntimePropertyNumberEnum — the property number (1 byte) carried inside a
 * Telemetry/Runtime body or a SetRuntimePropertyCommand. ~160 entries; common
 * ones extracted below. Source:
 * Lutron.Gulliver.Infrastructure.RuntimeDomainObjectFramework.RuntimePropertyNumberEnum
 */
export const RuntimeProperty: Record<number, string> = {
  0: "Identify",
  1: "Level",
  2: "PowerAndEnergySavings",
  4: "CURRENT_LEVEL",
  9: "ContactClosureOutputState",
  10: "LastPresetActivated",
  12: "ContactClosureInputState",
  14: "CURRENT_SCENE",
  15: "SEQUENCE_STATUS",
  16: "OccupancyStatus",
  20: "BUTTON_PRESS_STATE",
  23: "LED_STATUS",
  28: "OccupancyActiveState",
  29: "DeviceDiagInfo",
  31: "HyperionEnableStateData",
  32: "HyperionReenableTime",
  38: "OccupiedLevel",
  39: "UnoccupiedLevel",
  40: "DaylightingTargetSetPoint",
  41: "HyperionModeData",
  42: "ActiveVariableState",
  43: "Tilt",
  45: "TILT_CURRENT_LEVEL",
  46: "BacklightIntensity",
  50: "SensorFaultState",
  51: "SHADE_PRESET",
  52: "SEQUENCE_STEP",
  53: "MONTH",
  54: "DAY_OF_WEEK",
  56: "PhotoValue",
  58: "TargetSetPoint",
  59: "TemporaryTargetSetPoint",
  62: "ShadowSensorReading",
  63: "SetupTempGroup",
  67: "SceneSelect",
  68: "Time",
  69: "Date",
  70: "DeviceState",
  71: "PartitionWallState",
  72: "DeviceResponseState",
  73: "CurrentLoadShedAmount",
  74: "LoadShedEnabled",
  75: "DeviceComponentState",
  76: "LinkDeviceBitMap",
  77: "UpdateProgress",
  78: "TimeclockEnableState",
  79: "DaliEmergencyTestResult",
  80: "HVAC_OPERATING_TEMPERATURE",
  81: "HVACEcoMode",
  82: "HVAC_FAN_MODE",
  83: "HVAC_OPERATING_MODE",
  86: "HVAC_SYSTEM_MODE",
  87: "HVAC_SCHEDULE_STATUS",
  88: "HVACCallStatus",
  89: "LampHoursUsed",
  90: "LampsNearingEndOfLife",
  91: "AreaLightingState",
  92: "AreaLightLevelMatch",
  94: "SwitchLegControllerErrorLevel",
  96: "HyperionThresholdMode",
  98: "DarkModulatedThreshold",
  99: "TimeclockEventEnableState",
  100: "DaylightingCapAtGainGroupLevel",
  101: "BrightnessThreshold",
  102: "HVAC_FAN_STATUS",
  103: "HVAC_FAULT_STATUS",
  104: "HyperionBrightOverridePosition",
  105: "HyperionDarkOverridePosition",
  106: "HyperionVisorPosition",
  107: "HyperionVisorThreshold",
  108: "TimeClockEventTime",
  109: "SunOnFacade",
  110: "StatusIntensity",
  112: "HVACRelativeHumidity",
  123: "MinimumLightLevel",
  125: "AreaBatteryStatus",
  126: "SystemBatteryStatus",
  127: "DeviceStatusChange",
  128: "RemainingBatteryLevel",
  129: "SystemTimeAccuracyStatus",
  130: "DaytimeNighttimeState",
  131: "ConnectionStatus",
  133: "TargetCIE1931Point",
  134: "CurrentCIE1931Point",
  135: "TargetVibrancy",
  136: "CurrentVibrancy",
  137: "TargetWarmDimCurveId",
  138: "CurrentWarmDimCurveId",
  139: "TargetCCT",
  140: "CurrentCCT",
  149: "RentedState",
  150: "MakeUpRoomRequestState",
  151: "DoNotDisturbRequestState",
  152: "AutomationEnabled",
  156: "PresenceStatus",
  211: "DoNotDisturbMode",
  212: "RoomAutomationState",
  213: "GPDRoomStatus",
  214: "HVACCalculatedCallstatus",
  215: "HVACPower",
  220: "CountdownTimeout",
  225: "LightState",
  226: "ControlStationState",
  227: "VariableStates",
  228: "KeypadButtonInfo",
  235: "LeafAlertCount",
  239: "SystemAlertCount",
  240: "AreaAlertCount",
  254: "AreaOnOff",
  255: "SavedPower",
};

/** Inverse — property name → number, for building SetRuntimeProperty commands. */
export const RuntimePropertyByName: Record<string, number> = Object.fromEntries(
  Object.entries(RuntimeProperty).map(([k, v]) => [v, Number(k)]),
);

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

/**
 * Build a Version3 Event frame (LEIC, MsgType=3). Same header as a Command
 * frame but MsgType bits = 3. Used to inject simulated button-press events
 * (opId 0 = ButtonPress, 1 = ButtonRelease) from an integration client; the
 * processor routes them through the same programming-model path as a real
 * keypad press.
 *
 * `body` for button events is 6 bytes:
 *   u32 BE objectId   (button object id from LEAP, e.g. /button/494 → 494)
 *   u16 BE objectType (57 = ObjectType.Button)
 */
export function buildEventFrame(
  operationId: number,
  body: Buffer,
  opts: FrameOpts = {},
): Buffer {
  const wantAck = opts.wantAck ?? false;
  const packed = VERSION3 | (wantAck ? 0x10 : 0x00) | MsgType.Event;
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

/**
 * Button event body (LEIC events ButtonPress=0 / ButtonRelease=1) — 6 bytes:
 * `[buttonObjectId:u32][ObjectType.Button=57:u16]`. Observed on RA3 as the
 * outgoing LEIC payload when a real keypad button is pressed. Sending this
 * frame INBOUND to the processor is ignored for programming-model routing —
 * use `bodyIntegrationCommand` with op 60 for that path instead.
 */
export function bodyButtonEvent(buttonObjectId: number): Buffer {
  const b = Buffer.alloc(6);
  b.writeUInt32BE(buttonObjectId, 0);
  b.writeUInt16BE(ObjectType.Button, 4);
  return b;
}

/**
 * IntegrationCommand body (Command opId 60) — ASCII string payload accepted
 * by the processor's INTEGRATION_COMMAND_PROCESSOR, which registers telnet-
 * style handlers (`#DEVICE`, `#OUTPUT`, `#AREA`, `#SHADEGRP`, `#TIMECLOCK`,
 * `#SYSTEM`, `#SYSVAR`, `#PARTITIONWALL`, `#EMULATE`, `#MONITORING`, and the
 * `?` query variants of each) plus a `?HELP` dispatcher.
 *
 * Verified on RA3 firmware v26.01.13f000: sending `"#DEVICE,<devObjId>,<btn>,
 * <action>\n"` as a Command opId 60 body routes through the same code path
 * as the legacy RA2/HWQS telnet integration port (closed on RA3), which runs
 * the keypad's programming model (toggle presets, raise/lower, etc.).
 *
 * Action codes for `#DEVICE`:
 *   3 = Press
 *   4 = Release
 *   5 = Hold
 *   6 = MultiTap
 *   9 = LED state query/set (needs extra arg)
 *
 * The trailing newline terminates the line for the string parser.
 */
export function bodyIntegrationCommand(text: string): Buffer {
  const s = text.endsWith("\n") ? text : `${text}\n`;
  return Buffer.from(s, "ascii");
}

/** Convenience: `#DEVICE,<deviceObjectId>,<buttonNumber>,<action>\n`. */
export function bodyDevicePress(
  deviceObjectId: number,
  buttonNumber: number,
  action: 3 | 4 | 5 | 6 = 3,
): Buffer {
  return bodyIntegrationCommand(
    `#DEVICE,${deviceObjectId},${buttonNumber},${action}`,
  );
}

/**
 * `#OUTPUT` action codes (opId 60 IntegrationCommand). Numbers extracted from
 * the jump table in `sub_118aef8` (lutron-core v26.01.13f000), at file address
 * 0x118b1fc with bound `cmp r0, #34` after a `sub r0, r9, #1` (so codes are
 * 1-based, 1..35).
 *
 *   Implemented:    1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
 *                   19, 20, 21, 31, 35
 *   Falls through to "Command not yet supported\n":  7, 8, 22-30, 32, 33, 34
 *
 * Only the wire-verified actions are exported as named encoders below; the
 * rest can be reached via `bodyIntegrationCommand("#OUTPUT,<id>,<n>,...")`.
 */
export const OutputAction = {
  SetLevel: 1,
  StartRaising: 2,
  StartLowering: 3,
  StopRaiseLower: 4,
  StartFlash: 5,
  PulseTime: 6,
  SetTilt: 9,
} as const;

/**
 * `#OUTPUT,<intID>,1,<level>[,<fade>[,<delay>]]` — set a zone's output level.
 *
 * `intId` is the **Designer-assigned Integration ID**, NOT a LEAP object id.
 * `level` is 0-100 (the dispatcher also accepts decimal). `fadeSec` and
 * `delaySec` are integer seconds (the dispatcher also accepts `MM:SS` or
 * `HH:MM:SS` strings — pass via `bodyIntegrationCommand` if needed).
 *
 * Per the firmware arg-count check (`(argc-4) <= 2`), `delaySec` requires
 * `fadeSec` — passing only `delaySec` will be ignored.
 *
 * Verified 2026-04-19 on RA3 firmware v26.01.13f000: `#OUTPUT,5,1,50` against
 * integration ID 5 produced Level Telemetry on LEAP zone 10508.
 */
export function bodyOutputSetLevel(
  intId: number,
  level: number,
  opts: { fadeSec?: number; delaySec?: number } = {},
): Buffer {
  let s = `#OUTPUT,${intId},1,${level}`;
  if (opts.fadeSec !== undefined) s += `,${opts.fadeSec}`;
  if (opts.delaySec !== undefined) s += `,${opts.delaySec}`;
  return bodyIntegrationCommand(s);
}

/** `#OUTPUT,<intID>,2` — start a continuous raise at the zone's programmed rate. */
export function bodyOutputStartRaising(intId: number): Buffer {
  return bodyIntegrationCommand(`#OUTPUT,${intId},2`);
}

/** `#OUTPUT,<intID>,3` — start a continuous lower at the zone's programmed rate. */
export function bodyOutputStartLowering(intId: number): Buffer {
  return bodyIntegrationCommand(`#OUTPUT,${intId},3`);
}

/** `#OUTPUT,<intID>,4` — stop an in-progress raise/lower. */
export function bodyOutputStopRaiseLower(intId: number): Buffer {
  return bodyIntegrationCommand(`#OUTPUT,${intId},4`);
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

/**
 * GoToScene (opId 16) — fire a scene on an Area. Same 14-byte layout as
 * GoToLevel but with sceneNumber where level lives. Verified 2026-04-19 on
 * RA3 area 32: sn=0→0%, sn=1→100%, sn=2→75%, sn=3→49%, sn=4→24%; out-of-range
 * scene numbers are silently dropped.
 */
export function bodyGoToScene(
  areaId: number,
  sceneNumber: number,
  opts: {
    originator?: number;
    fadeSec?: number;
    delaySec?: number;
  } = {},
): Buffer {
  const b = Buffer.alloc(14);
  b.writeUInt32BE(areaId, 0);
  b.writeUInt16BE(ObjectType.Area, 4);
  b.writeUInt16BE(sceneNumber, 6);
  b.writeUInt16BE(opts.originator ?? OriginatorFeature.GUI, 8);
  b.writeUInt16BE(secToQuarters(opts.fadeSec ?? 1), 10);
  b.writeUInt16BE(secToQuarters(opts.delaySec ?? 0), 12);
  return b;
}

/**
 * Raise (opId 20) / Lower (opId 21) / StopRaiseLower (opId 22) — 12-byte body
 * shared across all three. Same layout as GoToLevel/GoToScene minus the
 * level/scene field. Targets an Area (ObjectType.Area = 2) — wire-tested
 * 2026-04-19 against RA3 area 32 with visible lighting response. Raise/Lower
 * begin a continuous ramp at the area's programmed rate; StopRaiseLower halts
 * an in-progress ramp.
 */
export function bodyRaiseLowerStop(
  areaId: number,
  opts: {
    objectType?: number;
    originator?: number;
    fadeSec?: number;
    delaySec?: number;
  } = {},
): Buffer {
  const b = Buffer.alloc(12);
  b.writeUInt32BE(areaId, 0);
  b.writeUInt16BE(opts.objectType ?? ObjectType.Area, 4);
  b.writeUInt16BE(opts.originator ?? OriginatorFeature.GUI, 6);
  b.writeUInt16BE(secToQuarters(opts.fadeSec ?? 0), 8);
  b.writeUInt16BE(secToQuarters(opts.delaySec ?? 0), 10);
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

/** PresetGoToLiftAndTiltLevels (opId 82) — for shades with separate lift+tilt. */
export const InvalidLiftLevel = 0xff00;
export const InvalidTiltLevel = 0xff00;
export function bodyPresetGoToLiftAndTiltLevels(args: {
  objectId: number;
  objectType?: number;
  liftPct?: number; // pass undefined → InvalidLiftLevel (skip lift)
  tiltPct?: number; // pass undefined → InvalidTiltLevel (skip tilt)
  delaySec?: number;
}): Buffer {
  const b = Buffer.alloc(12);
  b.writeUInt32BE(args.objectId, 0);
  b.writeUInt16BE(args.objectType ?? ObjectType.ShadeZone, 4);
  b.writeUInt16BE(
    args.liftPct === undefined ? InvalidLiftLevel : pctToLevel16(args.liftPct),
    6,
  );
  b.writeUInt16BE(
    args.tiltPct === undefined ? InvalidTiltLevel : pctToLevel16(args.tiltPct),
    8,
  );
  b.writeUInt16BE(secToQuarters(args.delaySec ?? 0), 10);
  return b;
}

/** DMXOutputFlash (opId 15) — flash a DMX output. flashRate is the FlashRate enum. */
export function bodyDMXOutputFlash(
  objectId: number,
  flashRate: number,
  objectType: number = ObjectType.Zone,
): Buffer {
  const b = Buffer.alloc(12);
  b.writeUInt32BE(objectId, 0);
  b.writeUInt16BE(objectType, 4);
  b.writeUInt16BE(flashRate, 6);
  b[8] = 255; // UpperFlashLevel
  b[9] = 0; //   LowerFlashLevel
  b.writeUInt16BE(0, 10); // Delay+Options would extend, but Designer only writes 12B effectively
  // (Designer writes Delay(2 BE) + Options(2 BE) — 14 bytes total. Pad up:)
  return Buffer.concat([b, Buffer.from([0, 0])]);
}

/** PingLinkDevice (opId 279) — round-trip latency probe to a specific device. */
export function bodyPingLinkDevice(
  objectId: number,
  objectType: number,
): Buffer {
  const b = Buffer.alloc(6);
  b.writeUInt32BE(objectId, 0);
  b.writeUInt16BE(objectType, 4);
  return b;
}

/** ShadeIdentifyOnInterfaceAddress (opId 320) — Next/Previous/Stop = 0/1/2. */
export function bodyShadeIdentifyOnInterfaceAddress(
  procNum: number,
  linkNum: number,
  interfaceAddress: number,
  cmd: 0 | 1 | 2,
): Buffer {
  return Buffer.from([procNum, linkNum, interfaceAddress, cmd]);
}

/**
 * SetRuntimeProperty (opId 7) — generic property write. Body matches
 * RuntimePropertyCommand.MarshalPayload + the property value bytes serialised
 * by RuntimePropertyConverter (we caller-provide the value bytes).
 *
 * NOTE: opId is 6 (RuntimeIdentify) when propertyNumber == 0, else 7.
 *
 *   uint32 BE objectId
 *   uint16 BE objectType
 *   [byte propertyNumber]    -- only when propertyNumber != 0
 *   [byte updateImmediately] -- only when propertyNumber != 0
 *   <valueBytes>
 */
export function bodySetRuntimeProperty(
  objectId: number,
  objectType: number,
  propertyNumber: number,
  valueBytes: Buffer,
  updateImmediately = true,
): Buffer {
  if (propertyNumber === 0) {
    const head = Buffer.alloc(6);
    head.writeUInt32BE(objectId, 0);
    head.writeUInt16BE(objectType, 4);
    return Buffer.concat([head, valueBytes]);
  }
  const head = Buffer.alloc(8);
  head.writeUInt32BE(objectId, 0);
  head.writeUInt16BE(objectType, 4);
  head[6] = propertyNumber;
  head[7] = updateImmediately ? 1 : 0;
  return Buffer.concat([head, valueBytes]);
}

/** GetRuntimeProperty (opId 9) — same as SetRuntimeProperty header, no value bytes. */
export function bodyGetRuntimeProperty(
  objectId: number,
  objectType: number,
  propertyNumber: number,
): Buffer {
  if (propertyNumber === 0) {
    const b = Buffer.alloc(6);
    b.writeUInt32BE(objectId, 0);
    b.writeUInt16BE(objectType, 4);
    return b;
  }
  const b = Buffer.alloc(7);
  b.writeUInt32BE(objectId, 0);
  b.writeUInt16BE(objectType, 4);
  b[6] = propertyNumber;
  return b;
}

/** ProcessorSetDateTime (opId 25) — sync the processor clock to wallclock. */
export function bodyProcessorSetDateTime(d = new Date()): Buffer {
  const b = Buffer.alloc(10);
  b[0] = 0xff;
  b[1] = 0xff;
  b[2] = 0xff;
  b[3] = d.getDate();
  b[4] = d.getMonth() + 1;
  // Year is written low-byte-first in the source (`bytes[1], bytes[0]` from
  // BitConverter.GetBytes((ushort)Year)) which means **big-endian** ushort.
  b.writeUInt16BE(d.getFullYear(), 5);
  b[7] = d.getHours();
  b[8] = d.getMinutes();
  b[9] = d.getSeconds();
  return b;
}

// ---------- Body decoders (incoming Telemetry/Event payloads) ----------

export interface RuntimePropertyUpdate {
  objectId: number;
  objectType: number;
  propertyNumber: number;
  /** Human-readable property name, if known. */
  propertyName: string;
  /** Raw bytes after the header. RuntimePropertyConverter format depends on prop. */
  value: Buffer;
}

/**
 * Decode a Telemetry/Runtime (opId 1) body — single property update.
 * Format per RuntimeTelemetry.MarshalPayload:
 *   uint32 BE objectId
 *   uint16 BE objectType
 *   byte     propertyNumber
 *   N bytes  property value (per-property encoding via RuntimePropertyConverter)
 */
export function decodeRuntimeTelemetry(
  body: Buffer,
): RuntimePropertyUpdate | null {
  if (body.length < 7) return null;
  const objectId = body.readUInt32BE(0);
  const objectType = body.readUInt16BE(4);
  const propertyNumber = body[6];
  return {
    objectId,
    objectType,
    propertyNumber,
    propertyName: RuntimeProperty[propertyNumber] ?? `prop${propertyNumber}`,
    value: Buffer.from(body.subarray(7)),
  };
}

export interface EventBody {
  objectId: number;
  objectType: number;
  /** Event-id specific bytes after the header. */
  rest: Buffer;
}

/** Common Event header decoder — every event starts with objectId(4) + objectType(2). */
export function decodeEventHeader(body: Buffer): EventBody | null {
  if (body.length < 6) return null;
  return {
    objectId: body.readUInt32BE(0),
    objectType: body.readUInt16BE(4),
    rest: Buffer.from(body.subarray(6)),
  };
}

/** OccupancyStateChange (event op 6) — header + 1 byte status. */
export function decodeOccupancyEvent(body: Buffer): {
  objectId: number;
  objectType: number;
  status: number;
  statusName: string;
} | null {
  const h = decodeEventHeader(body);
  if (!h || h.rest.length < 1) return null;
  const s = h.rest[0];
  return {
    objectId: h.objectId,
    objectType: h.objectType,
    status: s,
    statusName: OccupancyStatus[s] ?? `unk${s}`,
  };
}

/** IPAnnouncement (event op 47) — header + ip(4) + serial(4). */
export function decodeIPAnnouncementEvent(body: Buffer): {
  objectId: number;
  objectType: number;
  ip: string;
  serialHex: string;
} | null {
  const h = decodeEventHeader(body);
  if (!h || h.rest.length < 8) return null;
  return {
    objectId: h.objectId,
    objectType: h.objectType,
    ip: `${h.rest[0]}.${h.rest[1]}.${h.rest[2]}.${h.rest[3]}`,
    serialHex: h.rest.subarray(4, 8).toString("hex"),
  };
}

/** DeviceUploadProgress (event op 9) — header + componentNumber(2) + status(1) + uploadType(1). */
export function decodeDeviceUploadProgressEvent(body: Buffer): {
  objectId: number;
  componentNumber: number;
  status: number;
  uploadType: number;
} | null {
  const h = decodeEventHeader(body);
  if (!h || h.rest.length < 4) return null;
  return {
    objectId: h.objectId,
    componentNumber: h.rest.readUInt16BE(0),
    status: h.rest[2],
    uploadType: h.rest[3],
  };
}

/** DiagnosticBeacon (Command op 28) incoming — variable-length 36/40/49 byte body. */
export function decodeDiagnosticBeacon(body: Buffer): {
  serialHex: string;
  databaseGuid: string;
  os: string;
  boot: string;
  raw: number;
} | null {
  if (body.length < 22) return null;
  return {
    serialHex: body.subarray(0, 4).toString("hex"),
    databaseGuid: body.subarray(4, 20).toString("hex"),
    os: `${body.readUInt16BE(20)}.${body.readUInt16BE(22)}.${body.readUInt16BE(24)}`,
    boot: `${body.readUInt16BE(26)}.${body.readUInt16BE(28)}.${body.readUInt16BE(30)}`,
    raw: body.length,
  };
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
