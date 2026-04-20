/**
 * CCX decoder unit tests
 *
 * Canned CBOR corpus for every decoded message type. Each test asserts:
 *   - known-field decoding (shape + values)
 *   - unknownKeys tracking catches synthetic extra keys
 *   - snapshot of decoded JSON so schema drift is visible in diffs
 *
 * The corpus is hex-encoded CBOR so it's both human-readable and
 * independent of the encoder — the decoder can regress without any
 * encoder change firing.
 */

import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { BodyKey, CCXMessageType } from "../ccx/constants";
import { decodeAndParse, decodeHex, parseMessage } from "../ccx/decoder";
import type {
  CCXAck,
  CCXButtonPress,
  CCXComponentCmd,
  CCXDeviceReport,
  CCXDeviceState,
  CCXDimHold,
  CCXDimStep,
  CCXLevelControl,
  CCXPresence,
  CCXSceneRecall,
  CCXStatus,
  CCXUnknown,
} from "../ccx/types";

// ── Hex corpus ────────────────────────────────────────────
// Each entry is hand-encoded CBOR. See ccx/decoder.ts for the decoder logic
// and protocol/ccx.protocol.ts for the body-key definitions.

/** LEVEL_CONTROL: zone=961, level=0xFEFF (full on), fade=1 (0.25s), seq=92 */
const HEX_LEVEL_FULL_ON = "8200a300a20019feff03010182101903c105185c";

/** LEVEL_CONTROL with CCT: zone=100, level=50%, fade=8, cct=3000K, seq=1 */
const HEX_LEVEL_CCT =
  "8200a300a30019" +
  "7f7f" + // level = 0x7F7F (~50%)
  "03" +
  "08" + // fade = 8
  "06" +
  "190bb8" + // cct = 3000
  "0182" +
  "1018" +
  "64" +
  "0501";

/** LEVEL_CONTROL with warm-dim + colorXy: zone=200, level=0x8000, seq=3 */
const HEX_LEVEL_WARMDIM_XY =
  "8200a3" +
  "00a4" + // command map(4)
  "00198000" + // level = 0x8000
  "0182" +
  "1927101927d0" + // color_xy [10000, 10192]
  "0301" + // fade = 1
  "0505" + // warm_dim_mode = 5
  "0182" +
  "1018" +
  "c8" + // zone [16, 200]
  "0503"; // seq = 3

/** BUTTON_PRESS: preset=0x1234 ('3a EF 20' layout), counters=[1,2,3], seq=42 */
const HEX_BUTTON_PRESS =
  "8201a200" +
  "a2" + // command inner map(2)
  "00" +
  "4412" +
  "34ef20" + // device_id = h'1234ef20'
  "01" +
  "83010203" + // counters [1,2,3]
  "05" +
  "182a"; // seq = 42

/** DIM_HOLD: RAISE (action=3), zone=961, seq=5 */
const HEX_DIM_HOLD =
  "8202a3" +
  "00a2" + // command map(2)
  "00" +
  "440300ef20" + // device_id
  "0103" + // action = 3 (RAISE)
  "0182101903c1" + // zone [16, 961]
  "0505"; // seq

/** DIM_STEP: LOWER (action=2), stepValue=200, zone=961, seq=7 */
const HEX_DIM_STEP =
  "8203a3" +
  "00a3" + // command map(3)
  "00" +
  "440300ef20" + // device_id
  "0102" + // action = 2 (LOWER)
  "02" +
  "18c8" + // step_value = 200
  "0182101903c1" + // zone
  "0507"; // seq

/** ACK: LEVEL_ACK (0x50), seq=1 */
const HEX_ACK_LEVEL =
  "8207a2" +
  "00a1" + // command map(1)
  "01a1" + // key 1 → inner map(1)
  "00" +
  "4150" + // key 0 → bstr(1) 0x50
  "0501"; // seq = 1

/** ACK: BUTTON_ACK (0x55), seq=11 */
const HEX_ACK_BUTTON = "8207a200a101a100415505" + "0b";

/** DEVICE_REPORT Format B (level tuples): serial=12345, level=0xFEFF, group=5, seq=100 */
const HEX_DEVICE_REPORT_B =
  "82181ba4" +
  "00a1" + // command map(1)
  "03" +
  "81" + // key 3 → array(1)
  "83" +
  "00" + // tuple[0] = 0
  "42feff" + // tuple[1] = h'FEFF'
  "02" + // tuple[2] = 2 (output type)
  "02" +
  "820119" +
  "3039" + // device [1, 12345]
  "03a1" +
  "0105" + // extra {1: 5}
  "05" +
  "1864"; // seq

/** DEVICE_REPORT Format A (8-bit level map): serial=999, level=0xFF, seq=101 */
const HEX_DEVICE_REPORT_A =
  "82181ba4" +
  "00a1" + // command map(1)
  "01a1" + // key 1 → inner map
  "00" +
  "18ff" + // inner {0: 255}
  "02" +
  "82" +
  "01" +
  "1903e7" + // device [1, 999]
  "03a1" +
  "0100" + // extra {1: 0}
  "05" +
  "1865"; // seq

/** DEVICE_STATE (34): state_type=5, state_value=1, data=h'000e', serial=777, seq=20 */
const HEX_DEVICE_STATE =
  "8218" +
  "22a3" + // msgType 34, body map(3)
  "00a3" +
  "0005" + // state_type = 5
  "0101" + // state_value = 1
  "02" +
  "42" +
  "000e" + // state_data h'000e'
  "02" +
  "8201" +
  "190309" + // device [1, 777]
  "05" +
  "14"; // seq = 20

/** SCENE_RECALL (36): recall_vector=[4,0,0,0,0,0,0], targets=[0], scene=7, params=[5,60], seq=12 */
const HEX_SCENE_RECALL =
  "8218" +
  "24a4" + // msgType 36, body map(4)
  "00a1" +
  "00" +
  "8704000000000000" + // command {0: [4,0,0,0,0,0,0]}
  "01" +
  "8100" + // targets [0]
  "03" +
  "a2" +
  "0007" + // extra {0: 7, 2: [5,60]}
  "02" +
  "8205" +
  "183c" +
  "05" +
  "0c"; // seq = 12

/** COMPONENT_CMD (40): command=0, targets=[0], group=100, params=[10,4800], seq=30 */
const HEX_COMPONENT_CMD =
  "8218" +
  "28a4" + // msgType 40, body map(4)
  "00" +
  "a100" +
  "00" + // command {0: 0}
  "01" +
  "8100" + // targets [0]
  "03" +
  "a2" +
  "00" +
  "1864" + // extra {0: 100,
  "02" +
  "820a" +
  "1912c0" + // 2: [10, 4800]}
  "05" +
  "181e"; // seq = 30

/** STATUS (41): payload=h'deadbeef', device=[1,12345], scene_family=5, seq=40 */
const HEX_STATUS =
  "8218" +
  "29a4" + // msgType 41, body map(4)
  "00a2" +
  "0001" + // command {0: 1,
  "0244" +
  "deadbeef" + //          2: h'deadbeef'}
  "02" +
  "8201" +
  "193039" + // device [1, 12345]
  "03a1" +
  "0105" + // extra {1: 5}
  "05" +
  "1828"; // seq = 40

/** PRESENCE (65535): status=1, seq=50 */
const HEX_PRESENCE = "8219ffff" + "a2" + "0401" + "05" + "1832";

/** UNKNOWN msgType=99, seq=77 */
const HEX_UNKNOWN = "82" + "1863" + "a1" + "05" + "184d";

// Which BodyKey / CCXMessageType values are exercised by the corpus.
// Updated as new fixtures are added so the coverage summary is accurate.
const CORPUS_MESSAGE_TYPES = new Set<number>([
  CCXMessageType.LEVEL_CONTROL,
  CCXMessageType.BUTTON_PRESS,
  CCXMessageType.DIM_HOLD,
  CCXMessageType.DIM_STEP,
  CCXMessageType.ACK,
  CCXMessageType.DEVICE_REPORT,
  CCXMessageType.DEVICE_STATE,
  CCXMessageType.SCENE_RECALL,
  CCXMessageType.COMPONENT_CMD,
  CCXMessageType.STATUS,
  CCXMessageType.PRESENCE,
]);

const CORPUS_BODY_KEYS = new Set<number>([
  BodyKey.COMMAND,
  BodyKey.ZONE,
  BodyKey.DEVICE,
  BodyKey.EXTRA,
  BodyKey.STATUS,
  BodyKey.SEQUENCE,
]);

// ── Tests: per-message-type known-field decoding ──────────

describe("decodeAndParse — LEVEL_CONTROL", () => {
  test("basic ON (full_on, fade=1)", () => {
    const msg = decodeAndParse(HEX_LEVEL_FULL_ON) as CCXLevelControl;
    assert.equal(msg.type, "LEVEL_CONTROL");
    assert.equal(msg.level, 0xfeff);
    assert.equal(msg.levelPercent, 100);
    assert.equal(msg.zoneType, 16);
    assert.equal(msg.zoneId, 961);
    assert.equal(msg.fade, 1);
    assert.equal(msg.delay, 0);
    assert.equal(msg.sequence, 92);
    assert.equal(msg.cct, undefined);
    assert.equal(msg.colorXy, undefined);
    assert.equal(msg.warmDimMode, undefined);
    assert.equal(msg.unknownKeys, undefined);
  });

  test("with CCT", () => {
    const msg = decodeAndParse(HEX_LEVEL_CCT) as CCXLevelControl;
    assert.equal(msg.cct, 3000);
    assert.equal(msg.fade, 8);
    assert.equal(msg.zoneId, 100);
    assert.equal(msg.warmDimMode, undefined);
  });

  test("with warm-dim and color_xy", () => {
    const msg = decodeAndParse(HEX_LEVEL_WARMDIM_XY) as CCXLevelControl;
    assert.equal(msg.level, 0x8000);
    assert.equal(msg.warmDimMode, 5);
    assert.deepEqual(msg.colorXy, [10000, 10192]);
    assert.equal(msg.zoneId, 200);
    assert.equal(msg.sequence, 3);
  });
});

describe("decodeAndParse — BUTTON_PRESS", () => {
  test("decodes device_id, button zone, counters", () => {
    const msg = decodeAndParse(HEX_BUTTON_PRESS) as CCXButtonPress;
    assert.equal(msg.type, "BUTTON_PRESS");
    assert.deepEqual(Array.from(msg.deviceId), [0x12, 0x34, 0xef, 0x20]);
    assert.equal(msg.cmdType, 0x12);
    assert.equal(msg.buttonZone, 0x34);
    assert.deepEqual(msg.counters, [1, 2, 3]);
    assert.equal(msg.sequence, 42);
    assert.equal(msg.unknownKeys, undefined);
  });
});

describe("decodeAndParse — DIM_HOLD", () => {
  test("RAISE action=3, zone 961", () => {
    const msg = decodeAndParse(HEX_DIM_HOLD) as CCXDimHold;
    assert.equal(msg.type, "DIM_HOLD");
    assert.equal(msg.action, 3);
    assert.equal(msg.direction, "RAISE");
    assert.equal(msg.zoneId, 961);
    assert.equal(msg.sequence, 5);
  });
});

describe("decodeAndParse — DIM_STEP", () => {
  test("LOWER action=2, stepValue=200", () => {
    const msg = decodeAndParse(HEX_DIM_STEP) as CCXDimStep;
    assert.equal(msg.type, "DIM_STEP");
    assert.equal(msg.action, 2);
    assert.equal(msg.direction, "LOWER");
    assert.equal(msg.stepValue, 200);
    assert.equal(msg.zoneId, 961);
    assert.equal(msg.sequence, 7);
  });
});

describe("decodeAndParse — ACK", () => {
  test("LEVEL_ACK (0x50)", () => {
    const msg = decodeAndParse(HEX_ACK_LEVEL) as CCXAck;
    assert.equal(msg.type, "ACK");
    assert.equal(msg.responseCode, 0x50);
    assert.equal(msg.responseLabel, "LEVEL_ACK");
    assert.equal(msg.sequence, 1);
  });

  test("BUTTON_ACK (0x55)", () => {
    const msg = decodeAndParse(HEX_ACK_BUTTON) as CCXAck;
    assert.equal(msg.responseCode, 0x55);
    assert.equal(msg.responseLabel, "BUTTON_ACK");
    assert.equal(msg.sequence, 11);
  });
});

describe("decodeAndParse — DEVICE_REPORT", () => {
  test("Format B tuple level (16-bit BE)", () => {
    const msg = decodeAndParse(HEX_DEVICE_REPORT_B) as CCXDeviceReport;
    assert.equal(msg.type, "DEVICE_REPORT");
    assert.equal(msg.deviceSerial, 12345);
    assert.equal(msg.level, 0xfeff);
    assert.equal(msg.levelPercent, 100);
    assert.equal(msg.outputType, 2);
    assert.equal(msg.groupId, 5);
    assert.equal(msg.sequence, 100);
  });

  test("Format A map level (8-bit scaled to 16-bit)", () => {
    const msg = decodeAndParse(HEX_DEVICE_REPORT_A) as CCXDeviceReport;
    assert.equal(msg.deviceSerial, 999);
    assert.equal(msg.level, 0xfeff); // 255 → 0xFEFF scaled
    assert.equal(msg.levelPercent, 100);
    assert.equal(msg.outputType, undefined);
    assert.equal(msg.sequence, 101);
  });
});

describe("decodeAndParse — DEVICE_STATE", () => {
  test("state_type/state_value/state_data", () => {
    const msg = decodeAndParse(HEX_DEVICE_STATE) as CCXDeviceState;
    assert.equal(msg.type, "DEVICE_STATE");
    assert.equal(msg.stateType, 5);
    assert.equal(msg.stateValue, 1);
    assert.ok(msg.stateData instanceof Uint8Array);
    assert.deepEqual(Array.from(msg.stateData!), [0x00, 0x0e]);
    assert.equal(msg.deviceSerial, 777);
    assert.equal(msg.sequence, 20);
  });
});

describe("decodeAndParse — SCENE_RECALL", () => {
  test("multi-byte recall vector, scene=7", () => {
    const msg = decodeAndParse(HEX_SCENE_RECALL) as CCXSceneRecall;
    assert.equal(msg.type, "SCENE_RECALL");
    assert.deepEqual(msg.recallVector, [4, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(msg.targets, [0]);
    assert.equal(msg.sceneId, 7);
    assert.deepEqual(msg.params, [5, 60]);
    assert.equal(msg.sequence, 12);
  });
});

describe("decodeAndParse — COMPONENT_CMD", () => {
  test("shade/component set, group=100, params=[10,4800]", () => {
    const msg = decodeAndParse(HEX_COMPONENT_CMD) as CCXComponentCmd;
    assert.equal(msg.type, "COMPONENT_CMD");
    assert.equal(msg.command, 0);
    assert.deepEqual(msg.targets, [0]);
    assert.equal(msg.groupId, 100);
    assert.deepEqual(msg.params, [10, 4800]);
    assert.equal(msg.sequence, 30);
  });
});

describe("decodeAndParse — STATUS", () => {
  test("binary payload + scene_family_id", () => {
    const msg = decodeAndParse(HEX_STATUS) as CCXStatus;
    assert.equal(msg.type, "STATUS");
    assert.ok(msg.innerData instanceof Uint8Array);
    assert.deepEqual(Array.from(msg.innerData), [0xde, 0xad, 0xbe, 0xef]);
    assert.equal(msg.deviceId, 12345);
    assert.equal(msg.sceneFamilyId, 5);
    assert.equal(msg.sequence, 40);
  });
});

describe("decodeAndParse — PRESENCE", () => {
  test("heartbeat status=1", () => {
    const msg = decodeAndParse(HEX_PRESENCE) as CCXPresence;
    assert.equal(msg.type, "PRESENCE");
    assert.equal(msg.status, 1);
    assert.equal(msg.sequence, 50);
    assert.equal(msg.unknownKeys, undefined);
  });
});

describe("decodeAndParse — UNKNOWN", () => {
  test("falls through to UNKNOWN with raw body", () => {
    const msg = decodeAndParse(HEX_UNKNOWN) as CCXUnknown;
    assert.equal(msg.type, "UNKNOWN");
    assert.equal(msg.msgType, 99);
    assert.equal(msg.sequence, 77);
    assert.ok(msg.body);
  });
});

// ── Tests: collectUnknown() — synthetic unknown keys ──────

describe("collectUnknown — unknown key tracking", () => {
  test("PRESENCE with synthetic unknown top-level key is captured", () => {
    // PRESENCE normally has {4: status, 5: seq}. Add key 99 = 7.
    const hex = "8219ffff" + "a3" + "0401" + "05" + "1832" + "1863" + "07";
    const msg = decodeAndParse(hex) as CCXPresence;
    assert.equal(msg.type, "PRESENCE");
    assert.equal(msg.status, 1);
    assert.ok(msg.unknownKeys);
    assert.equal(msg.unknownKeys![99], 7);
  });

  test("LEVEL_CONTROL with synthetic inner unknown key is captured", () => {
    // Inner command normally has 0,1,2,3,4,5,6. Add key 42 = 99.
    const hex =
      "8200a3" +
      "00a3" + // inner map(3): level, fade, unknown 42
      "0019feff" +
      "0301" +
      "182a" +
      "1863" + // key 42 = 99
      "01821018" +
      "64" +
      "0501";
    const msg = decodeAndParse(hex) as CCXLevelControl;
    assert.equal(msg.level, 0xfeff);
    assert.ok(msg.unknownKeys);
    assert.equal(msg.unknownKeys![42], 99);
  });

  test("LEVEL_CONTROL with synthetic outer unknown key is captured", () => {
    // Body normally has 0,1,5. Add key 7 = 3.
    const hex =
      "8200a4" +
      "00a2" +
      "0019feff" +
      "0301" +
      "01821018" +
      "64" +
      "0501" +
      "0703"; // unknown top-level key 7 = 3
    const msg = decodeAndParse(hex) as CCXLevelControl;
    assert.ok(msg.unknownKeys);
    assert.equal(msg.unknownKeys![7], 3);
  });

  test("decoder does not throw on unknown msgType", () => {
    // msgType = 0xBEEF (unknown)
    const hex = "82" + "19beef" + "a1" + "0500";
    assert.doesNotThrow(() => decodeAndParse(hex));
    const msg = decodeAndParse(hex) as CCXUnknown;
    assert.equal(msg.type, "UNKNOWN");
    assert.equal(msg.msgType, 0xbeef);
  });

  test("decoder does not throw on empty body", () => {
    // LEVEL_CONTROL with empty body
    const hex = "8200a0";
    assert.doesNotThrow(() => decodeAndParse(hex));
    const msg = decodeAndParse(hex) as CCXLevelControl;
    assert.equal(msg.type, "LEVEL_CONTROL");
    assert.equal(msg.level, 0);
    assert.equal(msg.sequence, 0);
  });
});

// ── Tests: decoder robustness ─────────────────────────────

describe("decoder robustness", () => {
  test("decodeHex tolerates whitespace and 0x prefix", () => {
    const { msgType } = decodeHex("0x 82 00 a1 05 01");
    assert.equal(msgType, CCXMessageType.LEVEL_CONTROL);
  });

  test("parseMessage directly on synthetic body still produces shape", () => {
    const msg = parseMessage(CCXMessageType.PRESENCE, {
      4: 0,
      5: 123,
    }) as CCXPresence;
    assert.equal(msg.status, 0);
    assert.equal(msg.sequence, 123);
  });

  test("invalid CBOR (not an array) throws a clear error", () => {
    // `a0` is an empty CBOR map — not an array
    assert.throws(() => decodeAndParse("a0"), /expected CBOR array/);
  });
});

// ── Tests: schema drift — snapshot decoded JSON shape ─────
// Not a full snapshot file; we assert the exact decoded-key set so any
// new field added/removed surfaces in a PR diff here.

describe("decoded JSON shape (schema-drift canary)", () => {
  const fixtures: Array<{ name: string; hex: string; keys: string[] }> = [
    {
      name: "LEVEL_CONTROL",
      hex: HEX_LEVEL_FULL_ON,
      keys: [
        "type",
        "level",
        "levelPercent",
        "zoneType",
        "zoneId",
        "colorXy",
        "vibrancy",
        "fade",
        "delay",
        "cct",
        "warmDimMode",
        "sequence",
        "rawBody",
        "unknownKeys",
      ],
    },
    {
      name: "BUTTON_PRESS",
      hex: HEX_BUTTON_PRESS,
      keys: [
        "type",
        "deviceId",
        "buttonZone",
        "cmdType",
        "counters",
        "sequence",
        "rawBody",
        "unknownKeys",
      ],
    },
    {
      name: "DIM_HOLD",
      hex: HEX_DIM_HOLD,
      keys: [
        "type",
        "deviceId",
        "buttonZone",
        "cmdType",
        "action",
        "direction",
        "zoneType",
        "zoneId",
        "sequence",
        "rawBody",
        "unknownKeys",
      ],
    },
    {
      name: "DIM_STEP",
      hex: HEX_DIM_STEP,
      keys: [
        "type",
        "deviceId",
        "buttonZone",
        "cmdType",
        "action",
        "direction",
        "stepValue",
        "zoneType",
        "zoneId",
        "sequence",
        "rawBody",
        "unknownKeys",
      ],
    },
    {
      name: "ACK",
      hex: HEX_ACK_LEVEL,
      keys: [
        "type",
        "responseCode",
        "response",
        "responseLabel",
        "sequence",
        "rawBody",
        "unknownKeys",
      ],
    },
    {
      name: "DEVICE_REPORT",
      hex: HEX_DEVICE_REPORT_B,
      keys: [
        "type",
        "deviceType",
        "deviceSerial",
        "groupId",
        "innerData",
        "level",
        "levelPercent",
        "outputType",
        "sequence",
        "rawBody",
        "unknownKeys",
      ],
    },
    {
      name: "DEVICE_STATE",
      hex: HEX_DEVICE_STATE,
      keys: [
        "type",
        "deviceType",
        "deviceSerial",
        "stateType",
        "stateValue",
        "stateData",
        "sequence",
        "rawBody",
        "unknownKeys",
      ],
    },
    {
      name: "SCENE_RECALL",
      hex: HEX_SCENE_RECALL,
      keys: [
        "type",
        "command",
        "recallVector",
        "targets",
        "sceneId",
        "params",
        "sequence",
        "rawBody",
        "unknownKeys",
      ],
    },
    {
      name: "COMPONENT_CMD",
      hex: HEX_COMPONENT_CMD,
      keys: [
        "type",
        "command",
        "targets",
        "groupId",
        "params",
        "sequence",
        "rawBody",
        "unknownKeys",
      ],
    },
    {
      name: "STATUS",
      hex: HEX_STATUS,
      keys: [
        "type",
        "innerData",
        "deviceType",
        "deviceId",
        "sceneFamilyId",
        "extra",
        "sequence",
        "rawBody",
      ],
    },
    {
      name: "PRESENCE",
      hex: HEX_PRESENCE,
      keys: ["type", "status", "sequence", "rawBody", "unknownKeys"],
    },
    {
      name: "UNKNOWN",
      hex: HEX_UNKNOWN,
      keys: ["type", "msgType", "body", "sequence", "rawBody"],
    },
  ];

  for (const f of fixtures) {
    test(`${f.name} decoded key set is stable`, () => {
      const msg = decodeAndParse(f.hex);
      const actual = Object.keys(msg).sort();
      const expected = [...f.keys].sort();
      assert.deepEqual(
        actual,
        expected,
        `${f.name} decoded shape drifted — update the fixture`,
      );
    });
  }
});

// ── Coverage summary ──────────────────────────────────────

describe("coverage summary", () => {
  test("every CCXMessageType has at least one fixture", () => {
    const missing: string[] = [];
    for (const [name, id] of Object.entries(CCXMessageType)) {
      if (!CORPUS_MESSAGE_TYPES.has(id)) missing.push(`${name} (${id})`);
    }
    assert.deepEqual(
      missing,
      [],
      `Missing decoder fixture for: ${missing.join(", ")}`,
    );
  });

  test("every BodyKey is exercised by the corpus", () => {
    const missing: string[] = [];
    for (const [name, key] of Object.entries(BodyKey)) {
      if (!CORPUS_BODY_KEYS.has(key)) missing.push(`${name} (${key})`);
    }
    assert.deepEqual(missing, [], `BodyKey not covered: ${missing.join(", ")}`);
  });
});
