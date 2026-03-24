/**
 * Protocol Codegen — Generate C headers from TypeScript protocol definitions.
 *
 * Reads: protocol/cca.protocol.ts, protocol/ccx.protocol.ts
 * Writes: firmware/src/cca/cca_generated.h, firmware/src/ccx/ccx_generated.h
 *
 * No YAML parsing — TypeScript definitions ARE the source of truth.
 */

import { writeFileSync } from "fs";
import { join } from "path";
import { CCA } from "../protocol/cca.protocol";
import { CCX } from "../protocol/ccx.protocol";
import type { ConstantGroup, PacketTypeDef } from "../protocol/dsl";

const CCA_OUTPUT = join(import.meta.dir, "../firmware/src/cca/cca_generated.h");
const CCX_OUTPUT = join(import.meta.dir, "../firmware/src/ccx/ccx_generated.h");

// ============================================================================
// Helpers
// ============================================================================

function hex(v: number, width = 2): string {
  return "0x" + v.toString(16).toUpperCase().padStart(width, "0");
}

function cType(group: ConstantGroup): string {
  return group.cType ?? "uint8_t";
}

// ============================================================================
// CCA Header Generation
// ============================================================================

/** C constant name mapping: TS packet name → C name */
const CCA_NAME_MAP: Record<string, string> = {
  BTN_SHORT_A: "PKT_BTN_SHORT_A",
  BTN_LONG_A: "PKT_BTN_LONG_A",
  BTN_SHORT_B: "PKT_BTN_SHORT_B",
  BTN_LONG_B: "PKT_BTN_LONG_B",
  STATE_RPT_81: "PKT_STATE_REPORT_81",
  STATE_RPT_82: "PKT_STATE_REPORT_82",
  STATE_RPT_83: "PKT_STATE_REPORT_83",
  STATE_80: "PKT_STATE_REPORT_80",
  CONFIG_A1: "PKT_CONFIG_A1",
  SET_LEVEL: "PKT_LEVEL",
  BEACON_91: "PKT_BEACON_91",
  BEACON_92: "PKT_BEACON_STOP",
  BEACON_93: "PKT_BEACON_93",
  PAIR_B0: "PKT_PAIRING_B0",
  PAIR_B8: "PKT_PAIRING_B8",
  PAIR_B9: "PKT_PAIRING_B9",
  PAIR_BA: "PKT_PAIRING_BA",
  PAIR_BB: "PKT_PAIRING_BB",
  PAIR_RESP_C0: "PKT_PAIR_RESP_C0",
  UNPAIR: "PKT_UNPAIR",
  UNPAIR_PREP: "PKT_UNPAIR_PREP",
  LED_CONFIG: "PKT_LED_CONFIG",
  ZONE_BIND: "PKT_ZONE_BIND",
  DIM_CONFIG: "PKT_DIM_CONFIG",
  FUNC_MAP: "PKT_FUNC_MAP",
  TRIM_CONFIG: "PKT_TRIM_CONFIG",
  SCENE_CONFIG: "PKT_SCENE_CONFIG",
  FADE_CONFIG: "PKT_FADE_CONFIG",
  ZONE_ASSIGN: "PKT_ZONE_ASSIGN",
};

function getCName(tsName: string, pkt: PacketTypeDef): string {
  if (pkt.cName) return pkt.cName;
  return CCA_NAME_MAP[tsName] ?? "PKT_" + tsName;
}

function generateCCAHeader(): string {
  let out = "#pragma once\n\n";
  out +=
    "/**\n * Auto-generated from protocol/cca.protocol.ts\n * DO NOT EDIT - regenerate with: npm run codegen\n */\n\n";
  out +=
    "#include <cstdint>\n#include <cstddef>\n#include <cstdio>\n#include <cstring>\n\n";
  out += '#ifdef __cplusplus\nextern "C" {\n#endif\n\n';

  // Packet length constants
  out += "// Maximum raw packet size\n";
  out += "static const size_t CCA_MAX_PACKET_LEN = 64;\n";
  out +=
    "static const size_t CCA_PKT_STANDARD_LEN = " +
    CCA.constantGroups.lengths.values.STANDARD.value +
    ";\n";
  out +=
    "static const size_t CCA_PKT_PAIRING_LEN = " +
    CCA.constantGroups.lengths.values.PAIRING.value +
    ";\n\n";

  // Packet type constants
  out += "// Packet type constants\n";
  const sortedPkts = Object.entries(CCA.packetTypes).sort(
    ([, a], [, b]) => a.value - b.value,
  );
  // Virtual types reuse type bytes — exclude from switch statements to avoid duplicate cases
  const nonVirtualPkts = sortedPkts.filter(([, p]) => !p.isVirtual);
  for (const [name, pkt] of sortedPkts) {
    const cName = getCName(name, pkt);
    out += "static const uint8_t " + cName + " = " + hex(pkt.value) + ";\n";
    // Emit PKT_SET_LEVEL alias for backward compat
    if (name === "SET_LEVEL") {
      out += "static const uint8_t PKT_SET_LEVEL = 0xA2;\n";
    }
  }

  // Button codes
  out += "\n// Button codes\n";
  for (const [k, v] of Object.entries(CCA.enums.button.values)) {
    out += "static const uint8_t BTN_" + k + " = " + hex(v.value) + ";\n";
  }

  // Action codes
  out += "\n// Action codes\n";
  for (const [k, v] of Object.entries(CCA.enums.action.values)) {
    out += "static const uint8_t ACTION_" + k + " = " + hex(v.value) + ";\n";
  }

  // Packet structure offsets
  out += "\n// Common Packet structure offsets\n";
  out += "static const uint8_t PKT_OFFSET_TYPE = 0;\n";
  out += "static const uint8_t PKT_OFFSET_SEQ = 1;\n";
  out += "static const uint8_t PKT_OFFSET_DEVICE_ID = 2;\n";
  out += "static const uint8_t PKT_OFFSET_FORMAT = 7;\n";
  out += "static const uint8_t PKT_OFFSET_BUTTON = 10;\n";
  out += "static const uint8_t PKT_OFFSET_ACTION = 11;\n";
  out += "static const uint8_t PKT_OFFSET_LEVEL = 11;\n";
  out += "static const uint8_t PKT_OFFSET_CRC_24 = 22;\n";
  out += "static const uint8_t PKT_OFFSET_CRC_53 = 51;\n\n";

  // CRC polynomial
  out += "// CRC polynomial\n";
  out +=
    "static const uint16_t LUTRON_CRC_POLY = " +
    hex(CCA.constantGroups.crc.values.POLYNOMIAL.value, 4) +
    ";\n\n";

  // QS Link protocol constants (from cca_protocol.h)
  out += "// QS Link protocol constants\n";
  const qsGroups = [
    "qsProto",
    "qsAddr",
    "qsClass",
    "qsType",
    "qsComp",
    "qsFormat",
    "qsPico",
    "qsLevelMax",
    "qsLevelMax8",
    "qsState",
    "qsPreset",
    "qsPadding",
    "qsSensor",
  ] as const;
  for (const groupName of qsGroups) {
    const group = CCA.constantGroups[groupName];
    if (!group) continue;
    out += "\n// " + group.description + "\n";
    const ct = cType(group);
    for (const [k, v] of Object.entries(group.values)) {
      const constName = group.cPrefix + k;
      const desc = v.description ? "  /* " + v.description + " */" : "";
      out +=
        "static const " +
        ct +
        " " +
        constName +
        " = " +
        hex(v.value, ct === "uint16_t" ? 4 : 2) +
        ";" +
        desc +
        "\n";
    }
  }

  out += "\n#ifdef __cplusplus\n}\n#endif\n\n#ifdef __cplusplus\n\n";

  // Inline C++ functions
  out +=
    "// Get human-readable packet type name\ninline const char *cca_packet_type_name(uint8_t type_byte) {\n  switch (type_byte) {\n";
  for (const [name, pkt] of nonVirtualPkts) {
    out += "    case " + hex(pkt.value) + ': return "' + name + '";\n';
  }
  out += '    default: return "UNKNOWN";\n  }\n}\n\n';

  out +=
    "// Get expected packet length for a type byte.\ninline int cca_get_packet_length(uint8_t type_byte) {\n";
  out += "  if (type_byte == 0x0B) return 5;\n";
  out += "  if (type_byte >= 0x80 && type_byte <= 0x9F) return 24;\n";
  out += "  if (type_byte >= 0xA0 && type_byte <= 0xBF) return 53;\n";
  out +=
    "  if (type_byte >= 0xC0 && type_byte <= 0xEF) return 24;\n  return 0;\n}\n\n";

  out +=
    "// Check if type byte is a button press\ninline bool cca_is_button_type(uint8_t type_byte) {\n";
  out += "  return type_byte >= 0x88 && type_byte <= 0x8B;\n}\n\n";

  out +=
    "// Check if type byte is a pairing announcement\ninline bool cca_is_pairing_type(uint8_t type_byte) {\n";
  out +=
    "  return type_byte == 0xB0 || type_byte == 0xB8 || type_byte == 0xB9 ||\n         type_byte == 0xBA || type_byte == 0xBB;\n}\n\n";

  out +=
    "// Check if type byte is a handshake\ninline bool cca_is_handshake_type(uint8_t type_byte) {\n";
  out +=
    "  return (type_byte >= 0xC1 && type_byte <= 0xE0 && type_byte != 0xC0);\n}\n\n";

  out +=
    "// Check if type byte uses big-endian device ID\ninline bool cca_uses_be_device_id(uint8_t type_byte) {\n  switch (type_byte) {\n";
  for (const [, pkt] of nonVirtualPkts) {
    if (pkt.deviceIdEndian === "big") {
      out += "    case " + hex(pkt.value) + ":\n";
    }
  }
  out += "      return true;\n    default:\n      return false;\n  }\n}\n\n";

  out +=
    "// Get human-readable button name\ninline const char *cca_button_name(uint8_t button) {\n  switch (button) {\n";
  for (const [k, v] of Object.entries(CCA.enums.button.values)) {
    out += "    case " + hex(v.value) + ': return "' + k + '";\n';
  }
  out += '    default: return "?";\n  }\n}\n\n';

  out +=
    '// Format device ID as hex string (needs buffer of at least 9 bytes)\ninline void cca_format_device_id(uint32_t device_id, char *buffer, size_t buffer_len) {\n  if (buffer_len >= 9) {\n    snprintf(buffer, buffer_len, "%08X", (unsigned)device_id);\n  }\n}\n\n';

  out +=
    "// Decoded packet structure\nstruct DecodedPacket {\n  bool valid;\n  uint8_t type;\n  uint8_t type_byte;\n  uint8_t sequence;\n  uint32_t device_id;\n  uint8_t button;\n  uint8_t action;\n  uint8_t level;\n  uint32_t target_id;\n  uint8_t format_byte;\n  bool has_format;\n  uint16_t crc;\n  bool crc_valid;\n  uint8_t n81_errors;\n  uint8_t raw[64];\n  size_t raw_len;\n\n  void clear() {\n    valid = false;\n    type = 0xFF;\n    type_byte = 0;\n    sequence = 0;\n    device_id = 0;\n    button = 0;\n    action = 0;\n    level = 0;\n    target_id = 0;\n    format_byte = 0;\n    has_format = false;\n    crc = 0;\n    crc_valid = false;\n    n81_errors = 0;\n    raw_len = 0;\n    memset(raw, 0, sizeof(raw));\n  }\n};\n\n#endif\n";

  return out;
}

// ============================================================================
// CCX Header Generation
// ============================================================================

function generateCCXHeader(): string {
  let out = "#ifndef CCX_GENERATED_H\n#define CCX_GENERATED_H\n\n";
  out +=
    "/**\n * Auto-generated from protocol/ccx.protocol.ts\n * DO NOT EDIT - regenerate with: npm run codegen\n */\n\n";

  // Message type IDs
  out += "/* Message type IDs */\n";
  for (const [name, msg] of Object.entries(CCX.messageTypes)) {
    const val = msg.id > 255 ? hex(msg.id, 4) : String(msg.id);
    out += "#define CCX_MSG_" + name + " " + val + "\n";
  }

  // Body map keys
  out += "\n/* Body map keys */\n";
  for (const [name, entry] of Object.entries(CCX.bodyKeys)) {
    out += "#define CCX_KEY_" + name + " " + entry.key + "\n";
  }

  // Level constants
  out += "\n/* Level constants */\n";
  out += "#define CCX_LEVEL_FULL_ON 0xFEFF\n";
  out += "#define CCX_LEVEL_OFF     0x0000\n";

  // UDP port
  out += "\n/* UDP port */\n";
  out += "#define CCX_UDP_PORT 9190\n";

  // Zone type
  out += "\n/* Default zone type for dimmers */\n";
  out += "#define CCX_ZONE_TYPE_DIMMER 16\n";

  out += "\n#endif /* CCX_GENERATED_H */\n";
  return out;
}

// ============================================================================
// Main
// ============================================================================

try {
  writeFileSync(CCA_OUTPUT, generateCCAHeader());
  console.log("Generated: " + CCA_OUTPUT);

  writeFileSync(CCX_OUTPUT, generateCCXHeader());
  console.log("Generated: " + CCX_OUTPUT);
} catch (e) {
  console.error("Codegen failed:", e);
  process.exit(1);
}
