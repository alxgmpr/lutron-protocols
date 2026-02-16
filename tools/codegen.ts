import { mkdirSync, readFileSync, writeFileSync } from "fs";
import yaml from "js-yaml";
import { join } from "path";

const YAML_PATH = join(import.meta.dir, "../protocol/cca.yaml");
const TS_OUTPUT_PATH = join(
  import.meta.dir,
  "../protocol/generated/typescript/protocol.ts",
);
const CPP_OUTPUT_PATH = join(
  import.meta.dir,
  "../firmware/src/cca/cca_types.h",
);

interface ProtocolDef {
  meta: {
    name: string;
    version: string;
    description: string;
    ecosystems: Record<string, any>;
  };
  id_schemas: Record<string, any>;
  rf: Record<string, any>;
  crc: Record<string, any>;
  framing: Record<string, any>;
  timing: Record<string, any>;
  sequence: Record<string, any>;
  lengths: Record<string, any>;
  enums: Record<string, any>;
  packet_types: Record<string, any>;
  sequences: Record<string, any>;
}

function toPascalCase(s: string): string {
  return s
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join("");
}

function generateTS(def: ProtocolDef) {
  let out =
    "/**\n * Auto-generated from protocol/cca.yaml\n * DO NOT EDIT - regenerate with: npm run codegen\n *\n";
  out += " * " + def.meta.name + " v" + def.meta.version + "\n */\n\n";

  // Meta & Ecosystems
  out +=
    "export const ECOSYSTEMS = " +
    JSON.stringify(def.meta.ecosystems, null, 2) +
    " as const;\n\n";
  out +=
    "export const ID_SCHEMAS = " +
    JSON.stringify(def.id_schemas, null, 2) +
    " as const;\n\n";

  // Constants
  const writeConst = (name: string, obj: Record<string, any>) => {
    out += "/** " + name.toLowerCase().replace("_", " ") + " constants */\n";
    out += "export const " + name + " = {\n";
    for (const [k, v] of Object.entries(obj)) {
      const key = k.toUpperCase();
      const val = typeof v === "number" ? v : JSON.stringify(v);
      out += "  " + key + ": " + val + ",\n";
    }
    out += "} as const;\n\n";
  };

  writeConst("RF", def.rf);
  writeConst("CRC", def.crc);
  writeConst("FRAMING", def.framing);
  writeConst("TIMING", def.timing);
  writeConst("SEQUENCE", def.sequence);
  writeConst("LENGTHS", def.lengths);

  // Enums
  for (const [name, enumDef] of Object.entries(def.enums)) {
    const enumName = toPascalCase(name);
    out += "/** " + enumDef.description + " */\n";
    out += "export const " + enumName + " = {\n";

    const entries = Object.entries(enumDef.values);
    const hasValues = entries.some(([_, v]: any) => v.value !== undefined);

    if (hasValues) {
      const sortedValues = entries.sort(
        (a: any, b: any) => (a[1].value || 0) - (b[1].value || 0),
      );
      for (const [k, v] of sortedValues as any) {
        if (v.description) out += "  /** " + v.description + " */\n";
        out += "  " + k + ": " + v.value + ",\n";
      }
      out += "} as const;\n\n";
      out +=
        "export type " +
        enumName +
        " = typeof " +
        enumName +
        "[keyof typeof " +
        enumName +
        "];\n\n";
      out += "export const " + enumName + "Names: Record<number, string> = {\n";
      for (const [k, v] of sortedValues as any) {
        out += "  [" + v.value + "]: '" + k + "',\n";
      }
      out += "};\n\n";
    } else {
      // String-based enum (like Category)
      for (const [k, v] of entries as any) {
        if (v.description) out += "  /** " + v.description + " */\n";
        out += "  " + k + ": '" + k + "',\n";
      }
      out += "} as const;\n\n";
      out +=
        "export type " +
        enumName +
        " = typeof " +
        enumName +
        "[keyof typeof " +
        enumName +
        "];\n\n";
    }
  }

  // Packet Types
  out += "/** Packet type codes */\n";
  out += "export const PacketType = {\n";
  const sortedTypes = Object.entries(def.packet_types).sort(
    (a: any, b: any) => (a[1] as any).value - (b[1] as any).value,
  );
  for (const [k, v] of sortedTypes as any) {
    if (v.description) out += "  /** " + v.description + " */\n";
    out += "  " + k + ": " + v.value + ",\n";
  }
  out += "} as const;\n\n";
  out +=
    "export type PacketType = typeof PacketType[keyof typeof PacketType];\n\n";

  out += "export interface PacketTypeInfo {\n";
  out += "  name: string;\n";
  out += "  length: number;\n";
  out += "  category: string;\n";
  out += "  description: string;\n";
  out += "  usesBigEndianDeviceId: boolean;\n";
  out += "  isVirtual: boolean;\n";
  out += "  ecosystems: string[];\n";
  out += "}\n\n";

  out += "export const PacketTypeInfo: Record<number, PacketTypeInfo> = {\n";
  for (const [k, v] of sortedTypes as any) {
    out += "  [" + v.value + "]: {\n";
    out += "    name: '" + k + "',\n";
    out += "    length: " + v.length + ",\n";
    out += "    category: '" + v.category + "',\n";
    out += "    description: '" + (v.description || "") + "',\n";
    out +=
      "    usesBigEndianDeviceId: " + (v.device_id_endian === "big") + ",\n";
    out += "    isVirtual: " + !!v.virtual + ",\n";
    out += "    ecosystems: " + JSON.stringify(v.ecosystems || []) + ",\n";
    out += "  },\n";
  }
  out += "};\n\n";

  // Packet Fields
  out += "/** Field format types */\n";
  out +=
    "export type FieldFormat = 'hex' | 'decimal' | 'device_id' | 'device_id_be' | 'level_byte' | 'level_16bit' | 'button' | 'action';\n\n";
  out += "export interface FieldDef {\n";
  out += "  name: string;\n";
  out += "  offset: number;\n";
  out += "  size: number;\n";
  out += "  format: FieldFormat;\n";
  out += "  description?: string;\n";
  out += "}\n\n";

  // Resolve inheritance: if a type has `inherits` but no `fields`, use parent's fields
  const resolvedFields: Record<string, any[]> = {};
  for (const [k, v] of Object.entries(def.packet_types) as any) {
    if (v.fields) {
      resolvedFields[k] = v.fields;
    } else if (v.inherits && def.packet_types[v.inherits]?.fields) {
      resolvedFields[k] = def.packet_types[v.inherits].fields;
    }
  }

  out += "/** Field definitions by packet type */\n";
  out += "export const PacketFields: Record<string, FieldDef[]> = {\n";
  for (const [k, fields] of Object.entries(resolvedFields)) {
    out += "  '" + k + "': [\n";
    for (const f of fields as any[]) {
      out += "    {\n";
      out += "      name: '" + f.name + "',\n";
      out += "      offset: " + f.offset + ",\n";
      out += "      size: " + f.size + ",\n";
      out += "      format: '" + f.format + "',\n";
      if (f.description)
        out += "      description: '" + f.description + "',\n";
      out += "    },\n";
    }
    out += "  ],\n";
  }
  out += "};\n\n";

  // Sequences
  out += "/** Sequence step definition */\n";
  out += "export interface SequenceStep {\n";
  out += "  packetType: string;\n";
  out += "  count: number | null;  // null = repeat until stopped\n";
  out += "  intervalMs: number;\n";
  out += "}\n\n";
  out += "/** Sequence definition */\n";
  out += "export interface Sequence {\n";
  out += "  name: string;\n";
  out += "  description: string;\n";
  out += "  steps: SequenceStep[];\n";
  out += "}\n\n";
  out += "/** Transmission sequences */\n";
  out += "export const Sequences: Record<string, Sequence> = {\n";
  for (const [k, v] of Object.entries(def.sequences) as any) {
    out += "  '" + k + "': {\n";
    out += "    name: '" + k + "',\n";
    out += "    description: '" + v.description + "',\n";
    out += "    steps: [\n";
    for (const s of v.steps) {
      out +=
        "      { packetType: '" +
        s.packet +
        "', count: " +
        s.count +
        ", intervalMs: " +
        (s.interval_ms || 0) +
        " },\n";
    }
    out += "    ],\n";
    out += "  },\n";
  }
  out += "};\n\n";

  // Helpers
  out += "/** Get packet type name from type code */\n";
  out += "export function getPacketTypeName(typeCode: number): string {\n";
  out += "  return PacketTypeInfo[typeCode]?.name ?? 'UNKNOWN';\n";
  out += "}\n\n";
  out += "/** Get expected packet length from type code */\n";
  out += "export function getPacketLength(typeCode: number): number {\n";
  out += "  return PacketTypeInfo[typeCode]?.length ?? 0;\n";
  out += "}\n\n";
  out += "/** Check if packet type is a button packet */\n";
  out += "export function isButtonPacket(typeCode: number): boolean {\n";
  out += "  return PacketTypeInfo[typeCode]?.category === 'BUTTON';\n";
  out += "}\n\n";
  out += "/** Check if packet type belongs to a category */\n";
  out +=
    "export function isPacketCategory(typeCode: number, category: string): boolean {\n";
  out += "  return PacketTypeInfo[typeCode]?.category === category;\n";
  out += "}\n\n";
  out += "/** Calculate next sequence number */\n";
  out += "export function nextSequence(seq: number): number {\n";
  out += "  return (seq + SEQUENCE.INCREMENT) % SEQUENCE.WRAP;\n";
  out += "}\n";

  return out;
}

function generateCPP(def: ProtocolDef) {
  let out = "#pragma once\n\n";
  out +=
    "/**\n * Auto-generated from protocol/cca.yaml\n * DO NOT EDIT - regenerate with: npm run codegen\n *\n";
  out += " * " + def.meta.name + " v" + def.meta.version + "\n */\n\n";

  out +=
    "#include <cstdint>\n#include <cstddef>\n#include <cstdio>\n#include <cstring>\n\n";
  out += '#ifdef __cplusplus\nextern "C" {\n#endif\n\n';

  out +=
    "// Maximum raw packet size\nstatic const size_t CCA_MAX_PACKET_LEN = 64;\n";
  out +=
    "static const size_t CCA_PKT_STANDARD_LEN = " +
    def.lengths.standard +
    ";\n";
  out +=
    "static const size_t CCA_PKT_PAIRING_LEN = " +
    def.lengths.pairing +
    ";\n\n";

  out += "// Packet type constants\n";

  const typeMap: Record<string, string> = {
    BTN_PRESS_A: "PKT_BUTTON_SHORT_A",
    BTN_RELEASE_A: "PKT_BUTTON_LONG_A",
    BTN_PRESS_B: "PKT_BUTTON_SHORT_B",
    BTN_RELEASE_B: "PKT_BUTTON_LONG_B",
    SET_LEVEL: "PKT_LEVEL",
    STATE_RPT_81: "PKT_STATE_REPORT_81",
    STATE_RPT_82: "PKT_STATE_REPORT_82",
    STATE_RPT_83: "PKT_STATE_REPORT_83",
    STATE_80: "PKT_STATE_REPORT_80",
    BEACON_91: "PKT_BEACON_91",
    BEACON_92: "PKT_BEACON_STOP",
    BEACON_93: "PKT_BEACON_93",
    CONFIG_A1: "PKT_CONFIG_A1",
    PAIR_B0: "PKT_PAIRING_B0",
    PAIR_B8: "PKT_PAIRING_B8",
    PAIR_B9: "PKT_PAIRING_B9",
    PAIR_BA: "PKT_PAIRING_BA",
    PAIR_BB: "PKT_PAIRING_BB",
    PAIR_RESP_C0: "PKT_PAIR_RESP_C0",
    UNPAIR: "PKT_UNPAIR",
    UNPAIR_PREP: "PKT_UNPAIR_PREP",
    LED_CONFIG: "PKT_LED_CONFIG",
  };

  for (const [k, v] of Object.entries(def.packet_types) as any) {
    const name = typeMap[k] || "PKT_" + k;
    out +=
      "static const uint8_t " +
      name +
      " = 0x" +
      v.value.toString(16).toUpperCase() +
      ";\n";
    if (k === "SET_LEVEL") {
      out += "static const uint8_t PKT_SET_LEVEL = 0xA2;\n";
    }
  }

  out += "\n// Button codes\n";
  for (const [k, v] of Object.entries(def.enums.button.values) as any) {
    out +=
      "static const uint8_t BTN_" +
      k +
      " = 0x" +
      v.value.toString(16).toUpperCase() +
      ";\n";
  }

  out += "\n// Action codes\n";
  for (const [k, v] of Object.entries(def.enums.action.values) as any) {
    out +=
      "static const uint8_t ACTION_" +
      k +
      " = 0x" +
      v.value.toString(16).toUpperCase() +
      ";\n";
  }

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

  out += "// CRC polynomial\n";
  out +=
    "static const uint16_t LUTRON_CRC_POLY = 0x" +
    def.crc.polynomial.toString(16).toUpperCase() +
    ";\n\n";

  out += "#ifdef __cplusplus\n}\n#endif\n\n#ifdef __cplusplus\n\n";

  out +=
    "// Get human-readable packet type name\ninline const char *cca_packet_type_name(uint8_t type_byte) {\n  switch (type_byte) {\n";
  for (const [k, v] of Object.entries(def.packet_types) as any) {
    out +=
      "    case 0x" +
      v.value.toString(16).toUpperCase() +
      ': return "' +
      k +
      '";\n';
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
  for (const [_k, v] of Object.entries(def.packet_types) as any) {
    if (v.device_id_endian === "big") {
      out += "    case 0x" + v.value.toString(16).toUpperCase() + ":\n";
    }
  }
  out += "      return true;\n    default:\n      return false;\n  }\n}\n\n";

  out +=
    "// Get human-readable button name\ninline const char *cca_button_name(uint8_t button) {\n  switch (button) {\n";
  for (const [k, v] of Object.entries(def.enums.button.values) as any) {
    out +=
      "    case 0x" +
      v.value.toString(16).toUpperCase() +
      ': return "' +
      k +
      '";\n';
  }
  out += '    default: return "?";\n  }\n}\n\n';

  out +=
    '// Format device ID as hex string (needs buffer of at least 9 bytes)\ninline void cca_format_device_id(uint32_t device_id, char *buffer, size_t buffer_len) {\n  if (buffer_len >= 9) {\n    snprintf(buffer, buffer_len, "%08X", (unsigned)device_id);\n  }\n}\n\n';

  out +=
    "// Decoded packet structure\nstruct DecodedPacket {\n  bool valid;\n  uint8_t type;\n  uint8_t type_byte;\n  uint8_t sequence;\n  uint32_t device_id;\n  uint8_t button;\n  uint8_t action;\n  uint8_t level;\n  uint32_t target_id;\n  uint8_t format_byte;\n  bool has_format;\n  uint16_t crc;\n  bool crc_valid;\n  uint8_t n81_errors;\n  uint8_t raw[64];\n  size_t raw_len;\n\n  void clear() {\n    valid = false;\n    type = 0xFF;\n    type_byte = 0;\n    sequence = 0;\n    device_id = 0;\n    button = 0;\n    action = 0;\n    level = 0;\n    target_id = 0;\n    format_byte = 0;\n    has_format = false;\n    crc = 0;\n    crc_valid = false;\n    n81_errors = 0;\n    raw_len = 0;\n    memset(raw, 0, sizeof(raw));\n  }\n};\n\n#endif\n";

  return out;
}

try {
  const yamlContent = readFileSync(YAML_PATH, "utf8");
  const def = yaml.load(yamlContent) as ProtocolDef;

  mkdirSync(join(import.meta.dir, "../protocol/generated/typescript"), {
    recursive: true,
  });
  writeFileSync(TS_OUTPUT_PATH, generateTS(def));
  console.log("Generated: " + TS_OUTPUT_PATH);

  writeFileSync(CPP_OUTPUT_PATH, generateCPP(def));
  console.log("Generated: " + CPP_OUTPUT_PATH);
} catch (e) {
  console.error("Codegen failed:", e);
  process.exit(1);
}
