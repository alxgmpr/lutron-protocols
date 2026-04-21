/**
 * CCX Thread addressing helpers.
 *
 * The STABLE address form for a CCX device is the secondary ML-EID on the
 * processor-advertised on-mesh prefix (fd00::/64). Its interface identifier
 * is the modified EUI-64 form of the device's hardware MAC — i.e. byte 0 of
 * the EUI-64 with the universal/local (U/L) bit flipped (XOR 0x02). Because
 * the IID is derived from the hardware MAC, this address is stable across
 * reboots and pairings. Contrast with the primary ML-EID (fd0d::random-IID),
 * which rotates, and the RLOC-EID (fd0d:...ff:fe00:<rloc16>), which is only
 * valid for the device's current role.
 */

const EUI_RE = /^[0-9a-f]{2}(?:[:-]?[0-9a-f]{2}){5,7}$/i;

function parseEuiBytes(input: string): Buffer {
  const trimmed = input.trim().toLowerCase();
  if (!EUI_RE.test(trimmed)) {
    throw new Error(`Invalid EUI/MAC: ${input}`);
  }
  const hex = trimmed.replace(/[:-]/g, "");
  if (hex.length !== 12 && hex.length !== 16) {
    throw new Error(`EUI/MAC must be 48 or 64 bits, got ${hex.length * 4}`);
  }
  const raw = Buffer.from(hex, "hex");
  if (raw.length === 8) return raw;
  // 48-bit MAC → insert ff:fe between OUI and device ID (RFC 4291)
  return Buffer.concat([
    raw.subarray(0, 3),
    Buffer.from([0xff, 0xfe]),
    raw.subarray(3),
  ]);
}

/**
 * Compute the secondary ML-EID (`fd00::<modified-EUI-64>`) from an EUI-64 or
 * 48-bit MAC. Accepts colons, hyphens, or bare hex; mixed case OK.
 */
export function eui64ToSecondaryMleid(eui: string): string {
  const bytes = Buffer.from(parseEuiBytes(eui));
  bytes[0] ^= 0x02; // flip U/L bit for the IPv6 IID
  const groups: string[] = [];
  for (let i = 0; i < 8; i += 2) {
    groups.push(
      ((bytes[i] << 8) | bytes[i + 1])
        .toString(16)
        .padStart(4, "0")
        .replace(/^0+(?=.)/, ""),
    );
  }
  return `fd00::${groups.join(":")}`;
}

/**
 * Recover an 8-byte EUI-64 (colon form) from a secondary ML-EID (fd00::…).
 * Inverse of `eui64ToSecondaryMleid`: XORs byte 0 of the IID with 0x02.
 */
export function secondaryMleidToEui64(addr: string): string {
  const full = expandIpv6(addr);
  const parts = full.split(":");
  const iidHex = parts.slice(4).join("");
  if (iidHex.length !== 16) {
    throw new Error(`Cannot extract 8-byte IID from ${addr}`);
  }
  const iid = Buffer.from(iidHex, "hex");
  iid[0] ^= 0x02;
  return Array.from(iid)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(":");
}

/** Expand an IPv6 address to its full colon-separated 8-group form. */
export function expandIpv6(addr: string): string {
  const stripped = addr.trim().split("%")[0];
  if (!stripped) throw new Error("Empty IPv6");
  if (stripped.includes("::")) {
    if (stripped.indexOf("::") !== stripped.lastIndexOf("::")) {
      throw new Error(`Invalid IPv6 (multiple ::): ${addr}`);
    }
    const [head, tail] = stripped.split("::");
    const headParts = head ? head.split(":") : [];
    const tailParts = tail ? tail.split(":") : [];
    const missing = 8 - (headParts.length + tailParts.length);
    if (missing < 0) {
      throw new Error(`Invalid IPv6 (too many segments): ${addr}`);
    }
    const parts = [...headParts, ...Array(missing).fill("0"), ...tailParts];
    return parts.map((p) => p.padStart(4, "0").toLowerCase()).join(":");
  }
  const parts = stripped.split(":");
  if (parts.length !== 8) {
    throw new Error(`Invalid IPv6 (expected 8 segments): ${addr}`);
  }
  return parts.map((p) => p.padStart(4, "0").toLowerCase()).join(":");
}

/**
 * Produce a canonical IPv6 form: lower-cased, leading zeros stripped per group,
 * longest run of all-zero groups collapsed to `::`.
 */
export function canonicalizeIpv6(addr: string): string {
  const full = expandIpv6(addr);
  const groups = full.split(":").map((g) => g.replace(/^0+(?=.)/, ""));
  // Find the longest run of "0" groups to collapse
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i < groups.length; i++) {
    if (groups[i] === "0") {
      if (curStart === -1) curStart = i;
      curLen++;
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }
  if (bestLen < 2) return groups.join(":");
  const head = groups.slice(0, bestStart).join(":");
  const tail = groups.slice(bestStart + bestLen).join(":");
  return `${head}::${tail}`;
}
