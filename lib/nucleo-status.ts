/**
 * Nucleo status blob (0xFE response) — parser.
 *
 * Wire layout mirrors send_status_response() in firmware/src/net/stream.cpp.
 * The counters are append-only there and nothing links the two sides at compile
 * time, so test/nucleo-status.test.ts reads that file and asserts these offsets
 * against it — a new or renumbered counter fails the test instead of silently
 * decoding as garbage.
 */

/** Core counters, present on every firmware that answers a status query. */
export const STATUS_BLOB_V1_SIZE = 48;
/** Core counters plus the extended radio telemetry. */
export const STATUS_BLOB_V2_SIZE = 112;

/** Byte offset of every field in the blob. Pinned against stream.cpp by test. */
export const STATUS_FIELD_OFFSETS = {
  uptimeMs: 0,
  ccaRx: 4,
  ccaTx: 8,
  ccaDrop: 12,
  ccaCrcFail: 16,
  ccaN81Err: 20,
  cc1101Overflow: 24,
  cc1101Runt: 28,
  ccxRx: 32,
  ccxTx: 36,
  ccxThreadJoined: 40,
  ccxThreadRole: 41,
  ethLinkUp: 42,
  numClients: 43,
  heapFree: 44,
  rxRestartTimeout: 48,
  rxRestartOverflow: 52,
  rxRestartManual: 56,
  rxRestartPacket: 60,
  syncHit: 64,
  syncMiss: 68,
  ringMaxOccupancy: 72,
  ringBytesIn: 76,
  ringBytesDropped: 80,
  ccaAck: 84,
  ccaCrcOptional: 88,
  ccaIrq: 92,
  isrLatencyMinUs: 96,
  isrLatencyP95Us: 100,
  isrLatencyMaxUs: 104,
  isrLatencySamples: 108,
} as const;

const F = STATUS_FIELD_OFFSETS;

export interface NucleoStatus {
  uptimeMs: number;
  ccaRx: number;
  ccaTx: number;
  ccaDrop: number;
  ccaCrcFail: number;
  ccaN81Err: number;
  cc1101Overflow: number;
  cc1101Runt: number;
  ccxRx: number;
  ccxTx: number;
  ccxThreadJoined: boolean;
  ccxThreadRole: number;
  ethLinkUp: boolean;
  numClients: number;
  heapFree: number;
  /** Extended telemetry, or null when the firmware predates the v2 blob. */
  radio: NucleoRadioTelemetry | null;
}

/**
 * CC1101 and CCA ISR telemetry. These are the counters that separate an RF
 * explanation for packet loss from a code one: sync misses and ring drops are
 * ours, a clean sheet here with packets still missing is the air.
 */
export interface NucleoRadioTelemetry {
  rxRestartTimeout: number;
  rxRestartOverflow: number;
  rxRestartManual: number;
  rxRestartPacket: number;
  syncHit: number;
  syncMiss: number;
  ringMaxOccupancy: number;
  ringBytesIn: number;
  ringBytesDropped: number;
  ccaAck: number;
  ccaCrcOptional: number;
  ccaIrq: number;
  isrLatencyMinUs: number;
  isrLatencyP95Us: number;
  isrLatencyMaxUs: number;
  isrLatencySamples: number;
}

export function parseNucleoStatus(blob: Buffer): NucleoStatus | null {
  if (blob.length < STATUS_BLOB_V1_SIZE) return null;

  return {
    uptimeMs: blob.readUInt32LE(F.uptimeMs),
    ccaRx: blob.readUInt32LE(F.ccaRx),
    ccaTx: blob.readUInt32LE(F.ccaTx),
    ccaDrop: blob.readUInt32LE(F.ccaDrop),
    ccaCrcFail: blob.readUInt32LE(F.ccaCrcFail),
    ccaN81Err: blob.readUInt32LE(F.ccaN81Err),
    cc1101Overflow: blob.readUInt32LE(F.cc1101Overflow),
    cc1101Runt: blob.readUInt32LE(F.cc1101Runt),
    ccxRx: blob.readUInt32LE(F.ccxRx),
    ccxTx: blob.readUInt32LE(F.ccxTx),
    ccxThreadJoined: blob[F.ccxThreadJoined] !== 0,
    ccxThreadRole: blob[F.ccxThreadRole],
    ethLinkUp: blob[F.ethLinkUp] !== 0,
    numClients: blob[F.numClients],
    heapFree: blob.readUInt32LE(F.heapFree),
    radio: parseRadioTelemetry(blob),
  };
}

function parseRadioTelemetry(blob: Buffer): NucleoRadioTelemetry | null {
  if (blob.length < STATUS_BLOB_V2_SIZE) return null;

  return {
    rxRestartTimeout: blob.readUInt32LE(F.rxRestartTimeout),
    rxRestartOverflow: blob.readUInt32LE(F.rxRestartOverflow),
    rxRestartManual: blob.readUInt32LE(F.rxRestartManual),
    rxRestartPacket: blob.readUInt32LE(F.rxRestartPacket),
    syncHit: blob.readUInt32LE(F.syncHit),
    syncMiss: blob.readUInt32LE(F.syncMiss),
    ringMaxOccupancy: blob.readUInt32LE(F.ringMaxOccupancy),
    ringBytesIn: blob.readUInt32LE(F.ringBytesIn),
    ringBytesDropped: blob.readUInt32LE(F.ringBytesDropped),
    ccaAck: blob.readUInt32LE(F.ccaAck),
    ccaCrcOptional: blob.readUInt32LE(F.ccaCrcOptional),
    ccaIrq: blob.readUInt32LE(F.ccaIrq),
    isrLatencyMinUs: blob.readUInt32LE(F.isrLatencyMinUs),
    isrLatencyP95Us: blob.readUInt32LE(F.isrLatencyP95Us),
    isrLatencyMaxUs: blob.readUInt32LE(F.isrLatencyMaxUs),
    isrLatencySamples: blob.readUInt32LE(F.isrLatencySamples),
  };
}
