/**
 * CCX Protocol Constants — re-exported from protocol/ccx.protocol.ts
 *
 * This file is a thin re-export layer so that existing consumers
 * (encoder.ts, decoder.ts, etc.) don't need import path changes.
 */

export type { CCXMessageTypeId } from "../protocol/ccx.protocol";
export {
  BodyKey,
  CCX_UDP_PORT,
  CCXMessageType,
  CCXMessageTypeName,
  Level,
  levelToPercent,
  percentToLevel,
} from "../protocol/ccx.protocol";
