/**
 * Device identity, shared by every source that observes controls.
 *
 * A control's id is its wire device id — the 4-byte serial the radio carries —
 * namespaced by the transport that saw it. Two properties matter, and they are
 * why this is one small module rather than a string concatenation in each
 * source:
 *
 * 1. **It is stable.** The wire id is provisioned into the device, so it
 *    survives a rename (names live in LEAP/Designer, not on the wire) and a
 *    restart (nothing here is bridge-local state). It becomes a Home Assistant
 *    `unique_id`, and changing that later orphans every entity built on it.
 * 2. **It cannot collide across transports.** A CCX wire id and a CCA wire id
 *    are both four undifferentiated bytes. Without the namespace, two physical
 *    controls that happen to share four bytes become one HA entity.
 *
 * Deliberately NOT an address: see DeviceEvent.deviceId in ./types.ts for why a
 * rotating ML-EID cannot be used here.
 */

/** Transports that observe controls. `wiz` is an output, so it is not one. */
export type DeviceTransport = "ccx" | "cca";

const TRANSPORTS: DeviceTransport[] = ["ccx", "cca"];

/** Build the namespaced identity from a transport and a lowercase-hex wire id. */
export function deviceIdFor(
  transport: DeviceTransport,
  wireId: string,
): string {
  return `${transport}_${wireId}`;
}

/**
 * The wire id inside a namespaced identity.
 *
 * Lookups keyed on the raw wire bytes — the LEAP preset table, for one — need
 * the namespace off. An id carrying no known transport prefix is returned
 * unchanged rather than guessed at: an unprefixed id predates the namespace,
 * and an unrecognized prefix means something this function does not own.
 */
export function wireIdOf(deviceId: string): string {
  for (const transport of TRANSPORTS) {
    const prefix = `${transport}_`;
    if (deviceId.startsWith(prefix)) return deviceId.slice(prefix.length);
  }
  return deviceId;
}
