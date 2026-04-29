/**
 * Synth-OTA-TX builders — TS mirror of firmware/src/cca/cca_ota_tx.h.
 *
 * Emits on-air OTA packets that match captured Caseta Pro REP2 → DVRF-6L OTA
 * traffic byte-for-byte. Packets are pre-CRC; CRC-16/0xCA0F is added by
 * the Nucleo's N81 framer downstream when these packets are sent over the
 * stream protocol's STREAM_CMD_TX_RAW_CCA path.
 *
 * Layout (live-capture confirmed 2026-04-29; see
 * docs/firmware-re/cca-ota-live-capture.md):
 *
 *   [0]      type            0x91/92 short unicast, 0xB1/B2/B3 long unicast
 *   [1]      sequence        TDMA-engine-set; builder writes 0x00
 *   [2]      flags           0xA1 retx
 *   [3-4]    subnet          BE 16-bit; 0xFFFF for unpaired/factory devices
 *   [5]      pair_flag       0x00 normal
 *   [6]      proto           0x21 = QS_PROTO_RADIO_TX
 *   [7]      body length sig 0x0C/0x0E (short) / 0x2B (long)
 *   [8]      0x00
 *   [9-12]   device serial   BE 4-byte
 *   [13]     0xFE            unicast marker
 *   [14-15]  06 nn           sub-opcode (OTAOnAirSubOpcode)
 *   [16+]    payload
 */

const QS_PROTO_RADIO_TX = 0x21;

const OTA_SUB_BEGIN_TRANSFER = 0x00;
const OTA_SUB_CHANGE_ADDRESS_OFF = 0x01;
const OTA_SUB_TRANSFER_DATA = 0x02;

const OTA_TYPE_BEGIN_TRANSFER = 0x92;
const OTA_TYPE_CHANGE_ADDR_OFF = 0x91;

const OTA_BODY_LEN_SIG_BEGIN = 0x0e;
const OTA_BODY_LEN_SIG_CHADDR = 0x0c;
const OTA_BODY_LEN_SIG_LONG = 0x2b;

export const OTA_CHUNK_SIZE = 31;
export const OTA_PAGE_SIZE = 0x10000;

function writeHeader(
  pkt: Uint8Array,
  typeByte: number,
  bodyLenSig: number,
  subnet: number,
  targetSerial: number,
): void {
  pkt[0] = typeByte;
  pkt[1] = 0x00; // seq — TDMA engine sets
  pkt[2] = 0xa1; // flags: retx-class for cmd packets
  pkt[3] = (subnet >> 8) & 0xff;
  pkt[4] = subnet & 0xff;
  pkt[5] = 0x00; // pair_flag normal
  pkt[6] = QS_PROTO_RADIO_TX;
  pkt[7] = bodyLenSig;
  pkt[8] = 0x00;
  pkt[9] = (targetSerial >>> 24) & 0xff;
  pkt[10] = (targetSerial >>> 16) & 0xff;
  pkt[11] = (targetSerial >>> 8) & 0xff;
  pkt[12] = targetSerial & 0xff;
  pkt[13] = 0xfe; // unicast marker
}

/**
 * BeginTransfer (type 0x92, sub-op 06 00, payload `02 20 00 00 00 1F`).
 *
 * Emitted once at OTA session start. Trailing `1F` of the payload is the
 * chunk size (31 bytes). The leading 5 bytes are copied verbatim from the
 * captured Caseta REP2 → DVRF-6L OTA — meaning is open.
 *
 * Returns the 22-byte pre-CRC packet.
 */
export function buildBeginTransfer(
  subnet: number,
  targetSerial: number,
): Uint8Array {
  const pkt = new Uint8Array(22);
  writeHeader(
    pkt,
    OTA_TYPE_BEGIN_TRANSFER,
    OTA_BODY_LEN_SIG_BEGIN,
    subnet,
    targetSerial,
  );
  pkt[14] = 0x06;
  pkt[15] = OTA_SUB_BEGIN_TRANSFER;
  pkt[16] = 0x02;
  pkt[17] = 0x20;
  pkt[18] = 0x00;
  pkt[19] = 0x00;
  pkt[20] = 0x00;
  pkt[21] = 0x1f;
  return pkt;
}

/**
 * ChangeAddressOffset (type 0x91, sub-op 06 01, payload `00 PREV 00 NEW`).
 *
 * Emitted at each 64 KB page boundary. `prevPage`/`nextPage` are 16-bit BE
 * page indices (page 0 = first 64 KB, page 1 = second, etc.). Body padding
 * bytes 20..21 = 0xCC (matches captured OTA filler).
 *
 * Returns the 22-byte pre-CRC packet.
 */
export function buildChangeAddressOffset(
  subnet: number,
  targetSerial: number,
  prevPage: number,
  nextPage: number,
): Uint8Array {
  const pkt = new Uint8Array(22).fill(0xcc);
  writeHeader(
    pkt,
    OTA_TYPE_CHANGE_ADDR_OFF,
    OTA_BODY_LEN_SIG_CHADDR,
    subnet,
    targetSerial,
  );
  pkt[14] = 0x06;
  pkt[15] = OTA_SUB_CHANGE_ADDRESS_OFF;
  pkt[16] = (prevPage >> 8) & 0xff;
  pkt[17] = prevPage & 0xff;
  pkt[18] = (nextPage >> 8) & 0xff;
  pkt[19] = nextPage & 0xff;
  return pkt;
}

/**
 * TransferData (type 0xB1/B2/B3, sub-op 06 02, 31-byte chunk payload).
 *
 * Emitted ~3,300 times for a 102 KB LMJ body. The carrier byte cycles
 * through the 3-arm TDMA group (B1/B2/B3) — caller picks the carrier.
 * `subCounter` cycles 0..0x3F per chunk stream. `addrLo` is the 16-bit BE
 * chunk address within the current 64 KB page (advances by 31 per packet,
 * wraps at page boundary).
 *
 * Throws RangeError on invalid carrier or chunk length.
 * Returns the 51-byte pre-CRC packet.
 */
export function buildTransferData(
  carrierType: number,
  subnet: number,
  targetSerial: number,
  subCounter: number,
  addrLo: number,
  chunk: Uint8Array,
): Uint8Array {
  if (carrierType < 0xb1 || carrierType > 0xb3) {
    throw new RangeError(
      `carrier type 0x${carrierType.toString(16)} not in B1..B3`,
    );
  }
  if (chunk.length !== OTA_CHUNK_SIZE) {
    throw new RangeError(`chunk length ${chunk.length} != ${OTA_CHUNK_SIZE}`);
  }
  const pkt = new Uint8Array(51);
  writeHeader(pkt, carrierType, OTA_BODY_LEN_SIG_LONG, subnet, targetSerial);
  pkt[14] = 0x06;
  pkt[15] = OTA_SUB_TRANSFER_DATA;
  pkt[16] = subCounter & 0xff;
  pkt[17] = (addrLo >> 8) & 0xff;
  pkt[18] = addrLo & 0xff;
  pkt[19] = OTA_CHUNK_SIZE;
  pkt.set(chunk, 20);
  return pkt;
}

/**
 * Walks a firmware body in 31-byte chunks, tracking the (page, addrLo)
 * pair the TransferData packets need. Mirrors the C `OtaChunkIter` in
 * cca_ota_tx.h.
 */
export class OtaChunkIter {
  cursor = 0;
  addrLo = 0;
  page = 0;
  subCounter = 0;

  constructor(public readonly body: Uint8Array) {}

  done(): boolean {
    return this.cursor >= this.body.length;
  }

  /** Returns a 31-byte chunk; pads the final partial chunk with 0x00. */
  fill(): Uint8Array {
    const chunk = new Uint8Array(OTA_CHUNK_SIZE);
    const remaining = Math.max(0, this.body.length - this.cursor);
    const n = Math.min(remaining, OTA_CHUNK_SIZE);
    if (n > 0) chunk.set(this.body.subarray(this.cursor, this.cursor + n), 0);
    return chunk;
  }

  /** Advance cursor by 31 bytes. Returns true if a 64KB page boundary
   *  was crossed (caller should emit a ChangeAddressOffset before the
   *  next TransferData). */
  advance(): boolean {
    this.cursor += OTA_CHUNK_SIZE;
    this.subCounter = (this.subCounter + 1) & 0x3f;
    const next = this.addrLo + OTA_CHUNK_SIZE;
    if (next >= OTA_PAGE_SIZE) {
      this.page += 1;
      this.addrLo = next - OTA_PAGE_SIZE;
      return true;
    }
    this.addrLo = next;
    return false;
  }
}

/** One packet in an OTA TX sequence — labelled for diagnostics. */
export interface OtaPacket {
  label: string;
  pkt: Uint8Array;
}

/**
 * Generator that yields the full on-air packet sequence for an OTA TX:
 * 1× BeginTransfer, then TransferData per chunk (carriers cycle B1/B2/B3),
 * with ChangeAddressOffset injected at every 64 KB page wrap.
 *
 * Mirrors the firmware-side `cca_ota_full_tx_walk` in
 * firmware/src/cca/cca_ota_tx.h. Used by both the host-side OTA driver
 * and the loopback validator to know what packets to expect on the wire.
 */
export function* walkOtaPackets(
  body: Uint8Array,
  subnet: number,
  targetSerial: number,
): Generator<OtaPacket> {
  yield {
    label: "BeginTransfer",
    pkt: buildBeginTransfer(subnet, targetSerial),
  };

  const carriers = [0xb1, 0xb2, 0xb3];
  const it = new OtaChunkIter(body);
  let i = 0;
  while (!it.done()) {
    const carrier = carriers[i % carriers.length];
    const chunk = it.fill();
    yield {
      label: `TransferData[${i}]`,
      pkt: buildTransferData(
        carrier,
        subnet,
        targetSerial,
        it.subCounter,
        it.addrLo,
        chunk,
      ),
    };
    const wrapped = it.advance();
    if (wrapped && !it.done()) {
      yield {
        label: "ChangeAddrOff",
        pkt: buildChangeAddressOffset(
          subnet,
          targetSerial,
          it.page - 1,
          it.page,
        ),
      };
    }
    i++;
  }
}

/**
 * Byte-equal comparison ignoring the sequence byte at offset 1.
 *
 * The TDMA engine writes the sequence byte at TX time, so a packet built
 * with seq=0x00 and the same packet observed off-air with seq=0x07 are
 * functionally the same. Used by the loopback validator to match expected
 * packets against TX echoes and SDR-decoded packets.
 */
export function packetsEqualIgnoringSeq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (i === 1) continue;
    if (a[i] !== b[i]) return false;
  }
  return true;
}
