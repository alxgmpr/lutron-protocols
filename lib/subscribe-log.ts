import type { JsonObject, JsonValue } from "./data-values";

/** One frame observed after a SubscribeRequest, in arrival order. */
export type Frame = {
  seq: number;
  receivedMsAfterSubscribe: number;
  communiqueType: string;
  header: JsonObject;
  body?: JsonValue;
};

export type SubscribeLog = {
  url: string;
  /** ClientTag the SubscribeRequest was sent with. */
  requestTag: string;
  subscribeStatus: string;
  frames: Frame[];
};

/**
 * Does the processor echo the originating ClientTag on pushed frames?
 *
 * The published spec records this as unresolved: no captured push frame's
 * header existed anywhere to settle it. This classifier is the evidence.
 */
export function classifyTagReuse(
  log: SubscribeLog,
): "reuses" | "does-not-reuse" | "no-frames" {
  if (log.frames.length === 0) return "no-frames";
  const all = log.frames.every((f) => f.header?.ClientTag === log.requestTag);
  return all ? "reuses" : "does-not-reuse";
}
