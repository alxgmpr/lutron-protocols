/** Values produced by JSON parsing and accepted by JSON serialization. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface NumberLookup<T> {
  readonly [key: number]: T;
}

export interface StringLookup<T> {
  readonly [key: string]: T;
}

/** Values supported by the CCX CBOR codecs. */
export type CborValue =
  | null
  | boolean
  | number
  | string
  | bigint
  | Uint8Array
  | CborValue[]
  | Map<CborValue, CborValue>
  | CborMap;

export interface CborMap {
  [key: string | number]: CborValue;
}

export function isNumber(
  value: CborValue | JsonValue | undefined,
): value is number {
  return typeof value === "number";
}

export function isString(
  value: CborValue | JsonValue | undefined,
): value is string {
  return typeof value === "string";
}

export function isBigInt(value: CborValue): value is bigint {
  return typeof value === "bigint";
}

export function isCborMap(value: CborValue): value is CborMap {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array) &&
    !(value instanceof Map)
  );
}

export function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
