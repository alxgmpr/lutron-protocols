/**
 * CCX message corpus — hand-encoded CBOR, one entry per decoded message type.
 *
 * Hex rather than encoder output on purpose: the decoder can then regress
 * without any encoder change firing. Shared by test/ccx-decoder.test.ts and
 * the decode benchmarks, so both measure the same traffic.
 */

/** LEVEL_CONTROL: zone=961, level=0xFEFF (full on), fade=1 (0.25s), seq=92 */
export const HEX_LEVEL_FULL_ON = "8200a300a20019feff03010182101903c105185c";

/** LEVEL_CONTROL with CCT: zone=100, level=50%, fade=8, cct=3000K, seq=1 */
export const HEX_LEVEL_CCT =
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
export const HEX_LEVEL_WARMDIM_XY =
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
export const HEX_BUTTON_PRESS =
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
export const HEX_DIM_HOLD =
  "8202a3" +
  "00a2" + // command map(2)
  "00" +
  "440300ef20" + // device_id
  "0103" + // action = 3 (RAISE)
  "0182101903c1" + // zone [16, 961]
  "0505"; // seq

/** DIM_STEP: LOWER (action=2), stepValue=200, zone=961, seq=7 */
export const HEX_DIM_STEP =
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
export const HEX_ACK_LEVEL =
  "8207a2" +
  "00a1" + // command map(1)
  "01a1" + // key 1 → inner map(1)
  "00" +
  "4150" + // key 0 → bstr(1) 0x50
  "0501"; // seq = 1

/** ACK: BUTTON_ACK (0x55), seq=11 */
export const HEX_ACK_BUTTON = "8207a200a101a100415505" + "0b";

/** DEVICE_REPORT Format B (level tuples): serial=12345, level=0xFEFF, group=5, seq=100 */
export const HEX_DEVICE_REPORT_B =
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
export const HEX_DEVICE_REPORT_A =
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
export const HEX_DEVICE_STATE =
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
export const HEX_SCENE_RECALL =
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
export const HEX_COMPONENT_CMD =
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
export const HEX_STATUS =
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
export const HEX_PRESENCE = "8219ffff" + "a2" + "0401" + "05" + "1832";

/** UNKNOWN msgType=99, seq=77 */
export const HEX_UNKNOWN = "82" + "1863" + "a1" + "05" + "184d";

/** Every fixture, for callers that want to sweep the whole corpus. */
export const CCX_HEX_CORPUS: readonly string[] = [
  HEX_LEVEL_FULL_ON,
  HEX_LEVEL_CCT,
  HEX_LEVEL_WARMDIM_XY,
  HEX_BUTTON_PRESS,
  HEX_DIM_HOLD,
  HEX_DIM_STEP,
  HEX_ACK_LEVEL,
  HEX_ACK_BUTTON,
  HEX_DEVICE_REPORT_B,
  HEX_DEVICE_REPORT_A,
  HEX_DEVICE_STATE,
  HEX_SCENE_RECALL,
  HEX_COMPONENT_CMD,
  HEX_STATUS,
  HEX_PRESENCE,
  HEX_UNKNOWN,
];
