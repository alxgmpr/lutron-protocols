# Migrate Remaining Commands to Job Builders — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate 15 fire-and-forget CCA commands from blocking `cca_cmd_execute()` to non-blocking `TdmaJobGroup` builders.

**Architecture:** Add `type_base` field and rename `retransmits` → `tx_count` in the TDMA engine structs. Extract packet-building from each `exec_*()` into `cca_tx_builder.h` helpers. Write `cca_jobs_*()` builders. Wire into `cca_cmd_to_jobs()` router. Delete dead blocking code.

**Tech Stack:** C/C++ (clang++ host tests), STM32 firmware

**Spec corrections:** The design spec listed Vive as 51-byte/0xA1 and save_fav as config — both are actually 22-byte short packets. Vive uses type_base 0x89. Save_fav is a 2-phase button-like command. The plan below reflects the actual code.

---

### Task 1: Engine changes — `type_base` field and `retransmits` → `tx_count` rename

**Files:**
- Modify: `firmware/src/cca/cca_tdma.h:105-115`
- Modify: `firmware/src/cca/cca_tdma.cpp:462-515`
- Modify: `firmware/src/cca/cca_commands.cpp:66-148`
- Modify: `firmware/tests/test_tdma_jobs.cpp`
- Modify: `firmware/tests/test_cmd_builders.cpp`

- [ ] **Step 1: Add `type_base` to `TdmaPacket` and rename `retransmits` → `tx_count`**

In `firmware/src/cca/cca_tdma.h`, replace the `TdmaPacket` and `TdmaPhase` structs:

```c
typedef struct {
    uint8_t data[53];    /* raw payload (pre-CRC, pre-8N1) */
    uint8_t len;         /* 22 (short) or 51 (long) */
    uint8_t type_rotate; /* 0=fixed type byte, 1=rotate from type_base */
    uint8_t type_base;   /* rotation base: 0x81 (short), 0xA1 (long), 0x89 (vive) */
} TdmaPacket;

typedef struct {
    TdmaPacket packet;
    uint8_t tx_count;       /* total packets to fire (e.g. 11 = 1 + 10 retransmissions) */
    uint16_t post_delay_ms; /* delay after phase completes before next (0=immediate) */
} TdmaPhase;
```

Replace the retry constants block (lines 40-46):

```c
/* TX counts: total packets fired (1 original + N retransmissions) */
#define CCA_TX_COUNT_BURST   2   /* short burst (button press, dim start) */
#define CCA_TX_COUNT_BEACON  6   /* beacon */
#define CCA_TX_COUNT_NORMAL 11   /* standard (1 + 10 retransmissions) */
```

- [ ] **Step 2: Update `fire_group_packet()` to use `type_base`**

In `firmware/src/cca/cca_tdma.cpp`, find the type rotation line inside `fire_group_packet()` (~line 474):

```c
    /* Rotate type byte if requested (0x81 → 0x82 → 0x83 → 0x81...) */
    if (phase->packet.type_rotate && phase->packet.len > 0) {
        pkt[0] = 0x81 + (uint8_t)(g->current_retransmit % 3);
    }
```

Replace with:

```c
    /* Rotate type byte from base (e.g. 0x81→82→83, 0xA1→A2→A3, 0x89→8A→8B) */
    if (phase->packet.type_rotate && phase->packet.len > 0) {
        pkt[0] = phase->packet.type_base + (uint8_t)(g->current_retransmit % 3);
    }
```

Also rename `retransmits` → `tx_count` in the completion check (~line 485):

```c
    if (g->current_retransmit >= phase->tx_count) {
```

- [ ] **Step 3: Update existing job builders**

In `firmware/src/cca/cca_commands.cpp`, update the 4 existing builders:

`cca_jobs_bridge_level` (~line 74-76): change `retransmits` → `tx_count`, set `type_base`:
```c
    g.phases[0].packet.type_base = 0x81;
    g.phases[0].packet.type_rotate = 1;
    g.phases[0].tx_count = CCA_TX_COUNT_NORMAL;
```

`cca_jobs_button` (~lines 103-111): change `retransmits` → `tx_count`, fix release count:
```c
    g.phases[0].packet.type_base = 0x81;
    g.phases[0].tx_count = CCA_TX_COUNT_BURST;

    g.phases[1].packet.type_base = 0x81;
    g.phases[1].tx_count = CCA_TX_COUNT_NORMAL;
```

`cca_jobs_beacon` (~line 128-129):
```c
    g.phases[0].tx_count = CCA_TX_COUNT_BEACON;
```

`cca_jobs_raw` (~line 144):
```c
    g.phases[0].tx_count = retransmits > 0 ? retransmits : CCA_TX_COUNT_NORMAL;
```

- [ ] **Step 4: Update tests**

In `firmware/tests/test_cmd_builders.cpp`, rename all `retransmits` → `tx_count` in assertions:
```c
// test cmd_bridge_level_group
ASSERT_EQ(g.phases[0].tx_count, CCA_TX_COUNT_NORMAL);

// test cmd_button_group_has_two_phases
ASSERT_EQ(g.phases[0].tx_count, CCA_TX_COUNT_BURST);
ASSERT_EQ(g.phases[1].tx_count, CCA_TX_COUNT_NORMAL);

// test cmd_beacon_group
ASSERT_EQ(g.phases[0].tx_count, CCA_TX_COUNT_BEACON);

// test cmd_raw_group
ASSERT_EQ(g.phases[0].tx_count, 10);
```

In `firmware/tests/test_tdma_jobs.cpp`, rename `retransmits` → `tx_count` in all helper functions and assertions:
```c
// make_test_group
g.phases[0].tx_count = retransmits;

// make_two_phase_group
g.phases[0].tx_count = r1;
g.phases[1].tx_count = r2;

// all ASSERT_EQ lines referencing retransmits
ASSERT_EQ(g.phases[0].tx_count, 5);
// etc.
```

- [ ] **Step 5: Build and run tests**

Run: `cd /Volumes/Secondary/lutron-tools/firmware && make test`
Expected: All tests pass (existing behavior preserved, just renamed fields + fixed button release count)

- [ ] **Step 6: Commit**

```bash
git add firmware/src/cca/cca_tdma.h firmware/src/cca/cca_tdma.cpp \
        firmware/src/cca/cca_commands.cpp firmware/tests/test_tdma_jobs.cpp \
        firmware/tests/test_cmd_builders.cpp
git commit -m "refactor: rename retransmits→tx_count, add type_base to TdmaPacket

Engine now supports per-packet rotation base (0x81/0xA1/0x89).
Fix button release from 12→11 packets (1+10 retransmissions)."
```

---

### Task 2: Short packet builders — pico_level, broadcast_level, scene_exec, state_report

**Files:**
- Modify: `firmware/src/cca/cca_tx_builder.h` (add 4 helpers)
- Modify: `firmware/src/cca/cca_commands.cpp` (add 4 job builders)
- Modify: `firmware/tests/test_cmd_builders.cpp` (add 4 tests)

- [ ] **Step 1: Add packet builder helpers to `cca_tx_builder.h`**

Append these after `cca_build_beacon()`:

```cpp
/* -----------------------------------------------------------------------
 * Build pico level packet (format 0x0E, 22 bytes)
 * Pico-specific: fixed target bytes 0x0703C3C6, minimum fade 0.25s.
 * ----------------------------------------------------------------------- */
inline size_t cca_build_pico_level(uint8_t* pkt, uint32_t device_id, uint16_t level16)
{
    memset(pkt, 0x00, 22);

    pkt[0] = 0x81;
    cca_write_id_be(pkt + 2, device_id);

    pkt[6] = QS_PROTO_RADIO_TX;
    pkt[7] = QS_FMT_LEVEL;
    pkt[8] = 0x00;
    pkt[9] = 0x07;
    pkt[10] = 0x03;
    pkt[11] = 0xC3;
    pkt[12] = 0xC6;
    pkt[13] = QS_ADDR_COMPONENT;
    pkt[14] = QS_CLASS_LEVEL;
    pkt[15] = QS_TYPE_EXECUTE;
    pkt[16] = (level16 >> 8) & 0xFF;
    pkt[17] = level16 & 0xFF;
    pkt[18] = 0x00;
    pkt[19] = 0x01; /* fade: 0.25s minimum */

    return 22;
}

/* -----------------------------------------------------------------------
 * Build state report packet (format 0x08, 22 bytes)
 * Reports level as 8-bit value at bytes 11 and 15.
 * ----------------------------------------------------------------------- */
inline size_t cca_build_state_report(uint8_t* pkt, uint32_t device_id, uint8_t level_byte)
{
    memset(pkt, 0x00, 22);

    pkt[0] = 0x81;
    cca_write_id_be(pkt + 2, device_id);

    pkt[6] = 0x00;
    pkt[7] = QS_FMT_STATE;
    pkt[8] = 0x00;
    pkt[9] = QS_STATE_ENTITY_COMP;
    pkt[10] = 0x01;
    pkt[11] = level_byte;
    pkt[12] = 0x00;
    pkt[13] = QS_STATE_ENTITY_COMP;
    pkt[14] = QS_STATE_STATUS_FLAG;
    pkt[15] = level_byte;

    return 22;
}

/* -----------------------------------------------------------------------
 * Build scene execute packet (format 0x0E, 22 bytes)
 * Same as set_level but with QS_CLASS_SCENE instead of QS_CLASS_LEVEL.
 * ----------------------------------------------------------------------- */
inline size_t cca_build_scene_exec(uint8_t* pkt, uint32_t zone_id, uint32_t target_id,
                                   uint16_t level16, uint8_t fade_qs)
{
    memset(pkt, 0x00, 22);

    pkt[0] = 0x81;
    cca_write_id_be(pkt + 2, zone_id);

    pkt[6] = QS_PROTO_RADIO_TX;
    pkt[7] = QS_FMT_LEVEL;
    pkt[8] = 0x00;

    cca_write_id_be(pkt + 9, target_id);

    pkt[13] = QS_ADDR_COMPONENT;
    pkt[14] = QS_CLASS_SCENE;
    pkt[15] = QS_TYPE_EXECUTE;
    pkt[16] = (level16 >> 8) & 0xFF;
    pkt[17] = level16 & 0xFF;
    pkt[18] = 0x00;
    pkt[19] = fade_qs;

    return 22;
}
```

Note: `cca_build_set_level()` already handles broadcast_level — just pass `addr_mode=QS_ADDR_BROADCAST` and `target_id=0xFFFFFFFF`.

- [ ] **Step 2: Add job builders to `cca_commands.cpp`**

Add after `cca_jobs_raw()` (~line 148):

```cpp
TdmaJobGroup cca_jobs_pico_level(uint32_t device_id, uint8_t level_pct)
{
    TdmaJobGroup g = {};
    g.phase_count = 1;

    uint16_t level16 = cca_percent_to_level16(level_pct);
    cca_build_pico_level(g.phases[0].packet.data, device_id, level16);
    g.phases[0].packet.len = 22;
    g.phases[0].packet.type_base = 0x81;
    g.phases[0].packet.type_rotate = 1;
    g.phases[0].tx_count = CCA_TX_COUNT_NORMAL;

    printf("[cca] JOB pico_level dev=%08X %u%%\r\n", (unsigned)device_id, level_pct);
    return g;
}

TdmaJobGroup cca_jobs_broadcast_level(uint32_t zone_id, uint8_t level_pct, uint8_t fade_qs)
{
    TdmaJobGroup g = {};
    g.phase_count = 1;

    uint16_t level16 = cca_percent_to_level16(level_pct);
    cca_build_set_level(g.phases[0].packet.data, zone_id, 0xFFFFFFFF,
                        QS_ADDR_BROADCAST, level16, fade_qs, 0x81);
    g.phases[0].packet.len = 22;
    g.phases[0].packet.type_base = 0x81;
    g.phases[0].packet.type_rotate = 1;
    g.phases[0].tx_count = CCA_TX_COUNT_NORMAL;

    printf("[cca] JOB broadcast_level zone=%08X %u%% fade=%uqs\r\n",
           (unsigned)zone_id, level_pct, fade_qs);
    return g;
}

TdmaJobGroup cca_jobs_scene_exec(uint32_t zone_id, uint32_t target_id, uint8_t level_pct, uint8_t fade_qs)
{
    TdmaJobGroup g = {};
    g.phase_count = 1;

    uint16_t level16 = cca_percent_to_level16(level_pct);
    cca_build_scene_exec(g.phases[0].packet.data, zone_id, target_id, level16, fade_qs);
    g.phases[0].packet.len = 22;
    g.phases[0].packet.type_base = 0x81;
    g.phases[0].packet.type_rotate = 1;
    g.phases[0].tx_count = CCA_TX_COUNT_NORMAL;

    printf("[cca] JOB scene zone=%08X target=%08X %u%% fade=%uqs\r\n",
           (unsigned)zone_id, (unsigned)target_id, level_pct, fade_qs);
    return g;
}

TdmaJobGroup cca_jobs_state_report(uint32_t device_id, uint8_t level_pct)
{
    TdmaJobGroup g = {};
    g.phase_count = 1;

    uint8_t level_byte;
    if (level_pct >= 100) level_byte = QS_LEVEL_MAX_8;
    else level_byte = (uint8_t)((uint32_t)level_pct * 254 / 100);

    cca_build_state_report(g.phases[0].packet.data, device_id, level_byte);
    g.phases[0].packet.len = 22;
    g.phases[0].packet.type_base = 0x81;
    g.phases[0].packet.type_rotate = 1;
    g.phases[0].tx_count = CCA_TX_COUNT_NORMAL;

    printf("[cca] JOB state_report dev=%08X %u%%\r\n", (unsigned)device_id, level_pct);
    return g;
}
```

- [ ] **Step 3: Declare new builders in `cca_commands.h`**

Add after existing builder declarations (~line 105):

```c
TdmaJobGroup cca_jobs_pico_level(uint32_t device_id, uint8_t level_pct);
TdmaJobGroup cca_jobs_broadcast_level(uint32_t zone_id, uint8_t level_pct, uint8_t fade_qs);
TdmaJobGroup cca_jobs_scene_exec(uint32_t zone_id, uint32_t target_id, uint8_t level_pct, uint8_t fade_qs);
TdmaJobGroup cca_jobs_state_report(uint32_t device_id, uint8_t level_pct);
```

- [ ] **Step 4: Write tests**

Add to `firmware/tests/test_cmd_builders.cpp`:

```cpp
TEST(cmd_pico_level_group)
{
    TdmaJobGroup g = cca_jobs_pico_level(0x08692D70, 50);
    ASSERT_EQ(g.phase_count, 1);
    ASSERT_EQ(g.phases[0].tx_count, CCA_TX_COUNT_NORMAL);
    ASSERT_EQ(g.phases[0].packet.type_rotate, 1);
    ASSERT_EQ(g.phases[0].packet.type_base, 0x81);
    ASSERT_EQ(g.phases[0].packet.len, 22);
    ASSERT_EQ(g.phases[0].packet.data[7], QS_FMT_LEVEL);
    ASSERT_EQ(g.phases[0].packet.data[9], 0x07);  /* pico-specific */
    ASSERT_EQ(g.phases[0].packet.data[14], QS_CLASS_LEVEL);
    /* 50% = 50 * 65279 / 100 = 32639 = 0x7F7F */
    ASSERT_EQ(g.phases[0].packet.data[16], 0x7F);
    ASSERT_EQ(g.phases[0].packet.data[17], 0x7F);
}

TEST(cmd_broadcast_level_group)
{
    TdmaJobGroup g = cca_jobs_broadcast_level(0x00010002, 100, 4);
    ASSERT_EQ(g.phase_count, 1);
    ASSERT_EQ(g.phases[0].tx_count, CCA_TX_COUNT_NORMAL);
    ASSERT_EQ(g.phases[0].packet.type_base, 0x81);
    ASSERT_EQ(g.phases[0].packet.data[13], QS_ADDR_BROADCAST);
    ASSERT_EQ(g.phases[0].packet.data[16], 0xFE);
    ASSERT_EQ(g.phases[0].packet.data[17], 0xFF);
}

TEST(cmd_scene_exec_group)
{
    TdmaJobGroup g = cca_jobs_scene_exec(0x00010002, 0x00030004, 75, 8);
    ASSERT_EQ(g.phase_count, 1);
    ASSERT_EQ(g.phases[0].tx_count, CCA_TX_COUNT_NORMAL);
    ASSERT_EQ(g.phases[0].packet.data[14], QS_CLASS_SCENE);
    ASSERT_EQ(g.phases[0].packet.data[15], QS_TYPE_EXECUTE);
    ASSERT_EQ(g.phases[0].packet.data[19], 8);
}

TEST(cmd_state_report_group)
{
    TdmaJobGroup g = cca_jobs_state_report(0x08692D70, 100);
    ASSERT_EQ(g.phase_count, 1);
    ASSERT_EQ(g.phases[0].tx_count, CCA_TX_COUNT_NORMAL);
    ASSERT_EQ(g.phases[0].packet.data[7], QS_FMT_STATE);
    ASSERT_EQ(g.phases[0].packet.data[9], QS_STATE_ENTITY_COMP);
    ASSERT_EQ(g.phases[0].packet.data[11], QS_LEVEL_MAX_8);
    ASSERT_EQ(g.phases[0].packet.data[15], QS_LEVEL_MAX_8);
}
```

- [ ] **Step 5: Build and run tests**

Run: `cd /Volumes/Secondary/lutron-tools/firmware && make test`
Expected: All tests pass including the 4 new ones.

- [ ] **Step 6: Commit**

```bash
git add firmware/src/cca/cca_tx_builder.h firmware/src/cca/cca_commands.h \
        firmware/src/cca/cca_commands.cpp firmware/tests/test_cmd_builders.cpp
git commit -m "feat: add job builders for pico_level, broadcast_level, scene_exec, state_report"
```

---

### Task 3: Short packet builders — unpair (2-phase) and save_fav (2-phase)

**Files:**
- Modify: `firmware/src/cca/cca_tx_builder.h` (add unpair helpers)
- Modify: `firmware/src/cca/cca_commands.h` (declare builders)
- Modify: `firmware/src/cca/cca_commands.cpp` (add builders)
- Modify: `firmware/tests/test_cmd_builders.cpp` (add tests)

- [ ] **Step 1: Add unpair packet builder helpers to `cca_tx_builder.h`**

```cpp
/* -----------------------------------------------------------------------
 * Build unpair prepare packet (format 0x09, 22 bytes)
 * Phase 1 of unpair: device control / prepare.
 * ----------------------------------------------------------------------- */
inline size_t cca_build_unpair_prepare(uint8_t* pkt, uint32_t zone_id, uint32_t target_id)
{
    memset(pkt, 0x00, 22);

    pkt[0] = 0x81;
    cca_write_id_be(pkt + 2, zone_id);

    pkt[6] = QS_PROTO_RADIO_TX;
    pkt[7] = QS_FMT_CTRL;
    pkt[8] = 0x00;

    cca_write_id_be(pkt + 9, target_id);
    pkt[13] = QS_ADDR_COMPONENT;

    return 22;
}

/* -----------------------------------------------------------------------
 * Build unpair beacon packet (format 0x0C, 22 bytes)
 * Phase 2 of unpair: beacon with target address.
 * ----------------------------------------------------------------------- */
inline size_t cca_build_unpair_beacon(uint8_t* pkt, uint32_t zone_id, uint32_t target_id)
{
    memset(pkt, 0x00, 22);

    pkt[0] = 0x81;
    cca_write_id_be(pkt + 2, zone_id);

    pkt[6] = QS_PROTO_RADIO_TX;
    pkt[7] = QS_FMT_BEACON;
    pkt[8] = 0x00;

    cca_write_id_be(pkt + 9, target_id);
    pkt[13] = QS_ADDR_COMPONENT;

    return 22;
}
```

- [ ] **Step 2: Add job builders to `cca_commands.cpp`**

```cpp
TdmaJobGroup cca_jobs_unpair(uint32_t zone_id, uint32_t target_id)
{
    TdmaJobGroup g = {};

    /* Phase 0: prepare (format 0x09) */
    cca_build_unpair_prepare(g.phases[0].packet.data, zone_id, target_id);
    g.phases[0].packet.len = 22;
    g.phases[0].packet.type_base = 0x81;
    g.phases[0].packet.type_rotate = 1;
    g.phases[0].tx_count = CCA_TX_COUNT_BURST;
    g.phases[0].post_delay_ms = 800;

    /* Phase 1: unpair beacon (format 0x0C) */
    cca_build_unpair_beacon(g.phases[1].packet.data, zone_id, target_id);
    g.phases[1].packet.len = 22;
    g.phases[1].packet.type_base = 0x81;
    g.phases[1].packet.type_rotate = 1;
    g.phases[1].tx_count = CCA_TX_COUNT_NORMAL;
    g.phases[1].post_delay_ms = 0;

    g.phase_count = 2;

    printf("[cca] JOB unpair zone=%08X target=%08X\r\n", (unsigned)zone_id, (unsigned)target_id);
    return g;
}

TdmaJobGroup cca_jobs_save_fav(uint32_t device_id)
{
    TdmaJobGroup g = {};

    /* A/B alternation (shared with button) */
    static bool alt = false;
    uint8_t short_type = alt ? PKT_BTN_SHORT_B : PKT_BTN_SHORT_A;
    uint8_t long_type = alt ? PKT_BTN_LONG_B : PKT_BTN_LONG_A;
    alt = !alt;

    /* Phase 0: SHORT format save press */
    cca_build_button_short(g.phases[0].packet.data, device_id, BTN_FAVORITE,
                           ACTION_SAVE, QS_FMT_TAP, short_type);
    g.phases[0].packet.len = 22;
    g.phases[0].packet.type_rotate = 0; /* fixed type */
    g.phases[0].tx_count = CCA_TX_COUNT_BURST;
    g.phases[0].post_delay_ms = 0;

    /* Phase 1: LONG format save release */
    cca_build_button_long(g.phases[1].packet.data, device_id, BTN_FAVORITE, long_type);
    /* Override action to SAVE (button_long sets ACTION_RELEASE) */
    g.phases[1].packet.data[11] = ACTION_SAVE;
    g.phases[1].packet.len = 22;
    g.phases[1].packet.type_rotate = 0; /* fixed type */
    g.phases[1].tx_count = CCA_TX_COUNT_NORMAL;
    g.phases[1].post_delay_ms = 0;

    g.phase_count = 2;

    printf("[cca] JOB save_fav dev=%08X\r\n", (unsigned)device_id);
    return g;
}
```

- [ ] **Step 3: Declare in `cca_commands.h`**

```c
TdmaJobGroup cca_jobs_unpair(uint32_t zone_id, uint32_t target_id);
TdmaJobGroup cca_jobs_save_fav(uint32_t device_id);
```

- [ ] **Step 4: Write tests**

Add to `firmware/tests/test_cmd_builders.cpp`:

```cpp
TEST(cmd_unpair_group_two_phases)
{
    TdmaJobGroup g = cca_jobs_unpair(0x00010002, 0x00030004);
    ASSERT_EQ(g.phase_count, 2);
    /* Phase 0: prepare */
    ASSERT_EQ(g.phases[0].tx_count, CCA_TX_COUNT_BURST);
    ASSERT_EQ(g.phases[0].packet.data[7], QS_FMT_CTRL);
    ASSERT_EQ(g.phases[0].post_delay_ms, 800);
    /* Phase 1: unpair beacon */
    ASSERT_EQ(g.phases[1].tx_count, CCA_TX_COUNT_NORMAL);
    ASSERT_EQ(g.phases[1].packet.data[7], QS_FMT_BEACON);
    ASSERT_EQ(g.phases[1].packet.data[13], QS_ADDR_COMPONENT);
}

TEST(cmd_save_fav_group_two_phases)
{
    TdmaJobGroup g = cca_jobs_save_fav(0x08692D70);
    ASSERT_EQ(g.phase_count, 2);
    ASSERT_EQ(g.phases[0].tx_count, CCA_TX_COUNT_BURST);
    ASSERT_EQ(g.phases[0].packet.data[10], BTN_FAVORITE);
    ASSERT_EQ(g.phases[0].packet.data[11], ACTION_SAVE);
    ASSERT_EQ(g.phases[1].tx_count, CCA_TX_COUNT_NORMAL);
    ASSERT_EQ(g.phases[1].packet.data[10], BTN_FAVORITE);
    ASSERT_EQ(g.phases[1].packet.data[11], ACTION_SAVE);
}
```

- [ ] **Step 5: Build and run tests**

Run: `cd /Volumes/Secondary/lutron-tools/firmware && make test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add firmware/src/cca/cca_tx_builder.h firmware/src/cca/cca_commands.h \
        firmware/src/cca/cca_commands.cpp firmware/tests/test_cmd_builders.cpp
git commit -m "feat: add job builders for unpair (2-phase) and save_fav (2-phase)"
```

---

### Task 4: Long packet builders — config commands (LED, fade, trim, phase, dim)

**Files:**
- Modify: `firmware/src/cca/cca_tx_builder.h` (add 5 config helpers)
- Modify: `firmware/src/cca/cca_commands.h` (declare builders)
- Modify: `firmware/src/cca/cca_commands.cpp` (add 5 builders)
- Modify: `firmware/tests/test_cmd_builders.cpp` (add 5 tests)

- [ ] **Step 1: Add config packet builder helpers to `cca_tx_builder.h`**

```cpp
/* -----------------------------------------------------------------------
 * Build LED config packet (format 0x11, 51 bytes)
 * LED mode: 0=both off, 1=both on, 2=on-when-on, 3=on-when-off
 * LED state bytes at [23-24].
 * ----------------------------------------------------------------------- */
inline size_t cca_build_led_config(uint8_t* pkt, uint32_t zone_id, uint32_t target_id, uint8_t led_mode)
{
    memset(pkt, 0x00, 51);

    uint8_t led_off = 0x00, led_on = 0x00;
    switch (led_mode) {
    case 1: led_off = 0xFF; led_on = 0xFF; break;
    case 2: led_on = 0xFF; break;
    case 3: led_off = 0xFF; break;
    }

    pkt[0] = 0xA1;
    cca_write_id_be(pkt + 2, zone_id);
    pkt[6] = QS_PROTO_RADIO_TX;
    pkt[7] = QS_FMT_LED;
    pkt[8] = 0x00;
    cca_write_id_be(pkt + 9, target_id);
    pkt[13] = QS_ADDR_COMPONENT;
    pkt[23] = led_off;
    pkt[24] = led_on;

    return 51;
}

/* -----------------------------------------------------------------------
 * Build fade config packet (format 0x1C, 51 bytes)
 * Fade times in quarter-seconds, LE16 at [23-26].
 * ----------------------------------------------------------------------- */
inline size_t cca_build_fade_config(uint8_t* pkt, uint32_t zone_id, uint32_t target_id,
                                    uint16_t fade_on_qs, uint16_t fade_off_qs)
{
    memset(pkt, 0x00, 51);

    pkt[0] = 0xA1;
    cca_write_id_be(pkt + 2, zone_id);
    pkt[6] = QS_PROTO_RADIO_TX;
    pkt[7] = QS_FMT_FADE;
    pkt[8] = 0x00;
    cca_write_id_be(pkt + 9, target_id);
    pkt[13] = QS_ADDR_COMPONENT;
    pkt[23] = fade_on_qs & 0xFF;
    pkt[24] = (fade_on_qs >> 8) & 0xFF;
    pkt[25] = fade_off_qs & 0xFF;
    pkt[26] = (fade_off_qs >> 8) & 0xFF;

    return 51;
}

/* -----------------------------------------------------------------------
 * Build trim config packet (format 0x15, 51 bytes)
 * Trim values as percentages, converted to 0x00-0xFE scale at [20-21].
 * ----------------------------------------------------------------------- */
inline size_t cca_build_trim_config(uint8_t* pkt, uint32_t zone_id, uint32_t target_id,
                                    uint8_t high_trim, uint8_t low_trim)
{
    memset(pkt, 0x00, 51);

    uint8_t high_val = (high_trim >= 100) ? 0xFE : (uint8_t)((uint32_t)high_trim * 254 / 100);
    uint8_t low_val = (low_trim >= 100) ? 0xFE : (uint8_t)((uint32_t)low_trim * 254 / 100);

    pkt[0] = 0xA1;
    cca_write_id_be(pkt + 2, zone_id);
    pkt[6] = QS_PROTO_RADIO_TX;
    pkt[7] = QS_FMT_TRIM;
    pkt[8] = 0x00;
    cca_write_id_be(pkt + 9, target_id);
    pkt[13] = QS_ADDR_COMPONENT;
    pkt[20] = high_val;
    pkt[21] = low_val;

    return 51;
}

/* -----------------------------------------------------------------------
 * Build phase config packet (format 0x15, 51 bytes)
 * Neutral trim values at [20-21], phase byte at [22].
 * ----------------------------------------------------------------------- */
inline size_t cca_build_phase_config(uint8_t* pkt, uint32_t zone_id, uint32_t target_id,
                                     uint8_t phase_byte)
{
    memset(pkt, 0x00, 51);

    pkt[0] = 0xA1;
    cca_write_id_be(pkt + 2, zone_id);
    pkt[6] = QS_PROTO_RADIO_TX;
    pkt[7] = QS_FMT_TRIM;
    pkt[8] = 0x00;
    cca_write_id_be(pkt + 9, target_id);
    pkt[13] = QS_ADDR_COMPONENT;
    pkt[20] = QS_LEVEL_MAX_8; /* high trim = 100% */
    pkt[21] = 0x03;           /* low trim ~1% */
    pkt[22] = phase_byte;

    return 51;
}

/* -----------------------------------------------------------------------
 * Build dimming config packet (format 0x13, 51 bytes)
 * Config payload bytes starting at [16].
 * ----------------------------------------------------------------------- */
inline size_t cca_build_dim_config(uint8_t* pkt, uint32_t zone_id, uint32_t target_id,
                                   const uint8_t* config_bytes, uint8_t config_len)
{
    memset(pkt, 0x00, 51);

    pkt[0] = 0xA1;
    cca_write_id_be(pkt + 2, zone_id);
    pkt[6] = QS_PROTO_RADIO_TX;
    pkt[7] = QS_FMT_DIM_CAP;
    pkt[8] = 0x00;
    cca_write_id_be(pkt + 9, target_id);
    pkt[13] = QS_ADDR_COMPONENT;
    pkt[14] = QS_CLASS_LEGACY;
    pkt[15] = QS_TYPE_DIM_CONFIG;

    size_t max_payload = 51 - 16;
    size_t copy_len = config_len < max_payload ? config_len : max_payload;
    if (copy_len > 0) {
        memcpy(pkt + 16, config_bytes, copy_len);
    }

    return 51;
}
```

- [ ] **Step 2: Add job builders to `cca_commands.cpp`**

```cpp
TdmaJobGroup cca_jobs_led_config(uint32_t zone_id, uint32_t target_id, uint8_t led_mode)
{
    TdmaJobGroup g = {};
    g.phase_count = 1;

    cca_build_led_config(g.phases[0].packet.data, zone_id, target_id, led_mode);
    g.phases[0].packet.len = 51;
    g.phases[0].packet.type_base = 0xA1;
    g.phases[0].packet.type_rotate = 1;
    g.phases[0].tx_count = CCA_TX_COUNT_NORMAL;

    printf("[cca] JOB led_config zone=%08X target=%08X mode=%u\r\n",
           (unsigned)zone_id, (unsigned)target_id, led_mode);
    return g;
}

TdmaJobGroup cca_jobs_fade_config(uint32_t zone_id, uint32_t target_id,
                                  uint16_t fade_on_qs, uint16_t fade_off_qs)
{
    TdmaJobGroup g = {};
    g.phase_count = 1;

    cca_build_fade_config(g.phases[0].packet.data, zone_id, target_id, fade_on_qs, fade_off_qs);
    g.phases[0].packet.len = 51;
    g.phases[0].packet.type_base = 0xA1;
    g.phases[0].packet.type_rotate = 1;
    g.phases[0].tx_count = CCA_TX_COUNT_NORMAL;

    printf("[cca] JOB fade_config zone=%08X target=%08X on=%uqs off=%uqs\r\n",
           (unsigned)zone_id, (unsigned)target_id, fade_on_qs, fade_off_qs);
    return g;
}

TdmaJobGroup cca_jobs_trim_config(uint32_t zone_id, uint32_t target_id,
                                  uint8_t high_trim, uint8_t low_trim)
{
    TdmaJobGroup g = {};
    g.phase_count = 1;

    cca_build_trim_config(g.phases[0].packet.data, zone_id, target_id, high_trim, low_trim);
    g.phases[0].packet.len = 51;
    g.phases[0].packet.type_base = 0xA1;
    g.phases[0].packet.type_rotate = 1;
    g.phases[0].tx_count = CCA_TX_COUNT_NORMAL;

    printf("[cca] JOB trim_config zone=%08X target=%08X high=%u%% low=%u%%\r\n",
           (unsigned)zone_id, (unsigned)target_id, high_trim, low_trim);
    return g;
}

TdmaJobGroup cca_jobs_phase_config(uint32_t zone_id, uint32_t target_id, uint8_t phase_byte)
{
    TdmaJobGroup g = {};
    g.phase_count = 1;

    cca_build_phase_config(g.phases[0].packet.data, zone_id, target_id, phase_byte);
    g.phases[0].packet.len = 51;
    g.phases[0].packet.type_base = 0xA1;
    g.phases[0].packet.type_rotate = 1;
    g.phases[0].tx_count = CCA_TX_COUNT_NORMAL;

    printf("[cca] JOB phase_config zone=%08X target=%08X phase=0x%02X\r\n",
           (unsigned)zone_id, (unsigned)target_id, phase_byte);
    return g;
}

TdmaJobGroup cca_jobs_dim_config(uint32_t zone_id, uint32_t target_id,
                                 const uint8_t* config_bytes, uint8_t config_len)
{
    TdmaJobGroup g = {};
    g.phase_count = 1;

    cca_build_dim_config(g.phases[0].packet.data, zone_id, target_id, config_bytes, config_len);
    g.phases[0].packet.len = 51;
    g.phases[0].packet.type_base = 0xA1;
    g.phases[0].packet.type_rotate = 1;
    g.phases[0].tx_count = CCA_TX_COUNT_NORMAL;

    printf("[cca] JOB dim_config zone=%08X target=%08X\r\n",
           (unsigned)zone_id, (unsigned)target_id);
    return g;
}
```

- [ ] **Step 3: Declare in `cca_commands.h`**

```c
TdmaJobGroup cca_jobs_led_config(uint32_t zone_id, uint32_t target_id, uint8_t led_mode);
TdmaJobGroup cca_jobs_fade_config(uint32_t zone_id, uint32_t target_id, uint16_t fade_on_qs, uint16_t fade_off_qs);
TdmaJobGroup cca_jobs_trim_config(uint32_t zone_id, uint32_t target_id, uint8_t high_trim, uint8_t low_trim);
TdmaJobGroup cca_jobs_phase_config(uint32_t zone_id, uint32_t target_id, uint8_t phase_byte);
TdmaJobGroup cca_jobs_dim_config(uint32_t zone_id, uint32_t target_id, const uint8_t* config_bytes, uint8_t config_len);
```

- [ ] **Step 4: Write tests**

Add to `firmware/tests/test_cmd_builders.cpp`:

```cpp
TEST(cmd_led_config_group)
{
    TdmaJobGroup g = cca_jobs_led_config(0x00010002, 0x00030004, 2);
    ASSERT_EQ(g.phase_count, 1);
    ASSERT_EQ(g.phases[0].tx_count, CCA_TX_COUNT_NORMAL);
    ASSERT_EQ(g.phases[0].packet.len, 51);
    ASSERT_EQ(g.phases[0].packet.type_base, 0xA1);
    ASSERT_EQ(g.phases[0].packet.type_rotate, 1);
    ASSERT_EQ(g.phases[0].packet.data[7], QS_FMT_LED);
    /* Mode 2 = on-when-on: off=0x00, on=0xFF */
    ASSERT_EQ(g.phases[0].packet.data[23], 0x00);
    ASSERT_EQ(g.phases[0].packet.data[24], 0xFF);
}

TEST(cmd_fade_config_group)
{
    TdmaJobGroup g = cca_jobs_fade_config(0x00010002, 0x00030004, 0x0040, 0x0080);
    ASSERT_EQ(g.phase_count, 1);
    ASSERT_EQ(g.phases[0].packet.len, 51);
    ASSERT_EQ(g.phases[0].packet.data[7], QS_FMT_FADE);
    /* LE16: 0x0040 → [40, 00], 0x0080 → [80, 00] */
    ASSERT_EQ(g.phases[0].packet.data[23], 0x40);
    ASSERT_EQ(g.phases[0].packet.data[24], 0x00);
    ASSERT_EQ(g.phases[0].packet.data[25], 0x80);
    ASSERT_EQ(g.phases[0].packet.data[26], 0x00);
}

TEST(cmd_trim_config_group)
{
    TdmaJobGroup g = cca_jobs_trim_config(0x00010002, 0x00030004, 100, 10);
    ASSERT_EQ(g.phase_count, 1);
    ASSERT_EQ(g.phases[0].packet.len, 51);
    ASSERT_EQ(g.phases[0].packet.data[7], QS_FMT_TRIM);
    ASSERT_EQ(g.phases[0].packet.data[20], 0xFE); /* 100% */
    ASSERT_EQ(g.phases[0].packet.data[21], 25);   /* 10 * 254 / 100 = 25 */
}

TEST(cmd_phase_config_group)
{
    TdmaJobGroup g = cca_jobs_phase_config(0x00010002, 0x00030004, 0x42);
    ASSERT_EQ(g.phase_count, 1);
    ASSERT_EQ(g.phases[0].packet.len, 51);
    ASSERT_EQ(g.phases[0].packet.data[7], QS_FMT_TRIM);
    ASSERT_EQ(g.phases[0].packet.data[20], QS_LEVEL_MAX_8);
    ASSERT_EQ(g.phases[0].packet.data[21], 0x03);
    ASSERT_EQ(g.phases[0].packet.data[22], 0x42);
}

TEST(cmd_dim_config_group)
{
    uint8_t cfg[] = {0x01, 0x02, 0x03};
    TdmaJobGroup g = cca_jobs_dim_config(0x00010002, 0x00030004, cfg, 3);
    ASSERT_EQ(g.phase_count, 1);
    ASSERT_EQ(g.phases[0].packet.len, 51);
    ASSERT_EQ(g.phases[0].packet.data[7], QS_FMT_DIM_CAP);
    ASSERT_EQ(g.phases[0].packet.data[14], QS_CLASS_LEGACY);
    ASSERT_EQ(g.phases[0].packet.data[15], QS_TYPE_DIM_CONFIG);
    ASSERT_EQ(g.phases[0].packet.data[16], 0x01);
    ASSERT_EQ(g.phases[0].packet.data[17], 0x02);
    ASSERT_EQ(g.phases[0].packet.data[18], 0x03);
}
```

- [ ] **Step 5: Build and run tests**

Run: `cd /Volumes/Secondary/lutron-tools/firmware && make test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add firmware/src/cca/cca_tx_builder.h firmware/src/cca/cca_commands.h \
        firmware/src/cca/cca_commands.cpp firmware/tests/test_cmd_builders.cpp
git commit -m "feat: add job builders for LED, fade, trim, phase, dim config commands"
```

---

### Task 5: Vive builders (22-byte, type_base 0x89)

**Files:**
- Modify: `firmware/src/cca/cca_tx_builder.h` (add 3 helpers)
- Modify: `firmware/src/cca/cca_commands.h` (declare builders)
- Modify: `firmware/src/cca/cca_commands.cpp` (add builders)
- Modify: `firmware/tests/test_cmd_builders.cpp` (add tests)

- [ ] **Step 1: Add Vive packet builder helpers to `cca_tx_builder.h`**

```cpp
/* -----------------------------------------------------------------------
 * Build Vive level packet (format 0x0E, 22 bytes, type 0x89+)
 * Hub ID at [2-5] BE, zone byte at [12], addr_mode=GROUP.
 * ----------------------------------------------------------------------- */
inline size_t cca_build_vive_level(uint8_t* pkt, uint32_t hub_id, uint8_t zone_byte,
                                   uint16_t level16, uint8_t fade_qs)
{
    memset(pkt, 0x00, 22);

    pkt[0] = 0x89;
    cca_write_id_be(pkt + 2, hub_id);

    pkt[6] = QS_PROTO_RADIO_TX;
    pkt[7] = QS_FMT_LEVEL;
    pkt[12] = zone_byte;
    pkt[13] = QS_ADDR_GROUP;
    pkt[14] = QS_CLASS_LEVEL;
    pkt[15] = QS_TYPE_EXECUTE;
    pkt[16] = (level16 >> 8) & 0xFF;
    pkt[17] = level16 & 0xFF;
    pkt[18] = 0x00;
    pkt[19] = fade_qs;

    return 22;
}

/* -----------------------------------------------------------------------
 * Build Vive dim start packet (format 0x09, 22 bytes, type 0x89+)
 * Hold-start: CLASS_DIM + TYPE_HOLD + direction.
 * ----------------------------------------------------------------------- */
inline size_t cca_build_vive_dim_start(uint8_t* pkt, uint32_t hub_id,
                                       uint8_t zone_byte, uint8_t direction)
{
    memset(pkt, 0x00, 22);

    pkt[0] = 0x89;
    cca_write_id_be(pkt + 2, hub_id);

    pkt[6] = QS_PROTO_RADIO_TX;
    pkt[7] = QS_FMT_CTRL;
    pkt[12] = zone_byte;
    pkt[13] = QS_ADDR_GROUP;
    pkt[14] = QS_CLASS_DIM;
    pkt[15] = QS_TYPE_HOLD;
    pkt[16] = direction;

    return 22;
}

/* -----------------------------------------------------------------------
 * Build Vive dim stop packet (format 0x0B, 22 bytes, type 0x89+)
 * Dim-step: CLASS_DIM + TYPE_EXECUTE + direction.
 * ----------------------------------------------------------------------- */
inline size_t cca_build_vive_dim_stop(uint8_t* pkt, uint32_t hub_id,
                                      uint8_t zone_byte, uint8_t direction)
{
    memset(pkt, 0x00, 22);

    pkt[0] = 0x89;
    cca_write_id_be(pkt + 2, hub_id);

    pkt[6] = QS_PROTO_RADIO_TX;
    pkt[7] = QS_FMT_DIM_STEP;
    pkt[12] = zone_byte;
    pkt[13] = QS_ADDR_GROUP;
    pkt[14] = QS_CLASS_DIM;
    pkt[15] = QS_TYPE_EXECUTE;
    pkt[16] = direction;

    return 22;
}
```

- [ ] **Step 2: Add job builders to `cca_commands.cpp`**

```cpp
TdmaJobGroup cca_jobs_vive_level(uint32_t hub_id, uint8_t zone_byte,
                                 uint8_t level_pct, uint8_t fade_qs)
{
    TdmaJobGroup g = {};
    g.phase_count = 1;

    uint16_t level16 = cca_percent_to_level16(level_pct);
    cca_build_vive_level(g.phases[0].packet.data, hub_id, zone_byte, level16, fade_qs);
    g.phases[0].packet.len = 22;
    g.phases[0].packet.type_base = 0x89;
    g.phases[0].packet.type_rotate = 1;
    g.phases[0].tx_count = CCA_TX_COUNT_NORMAL;

    printf("[cca] JOB vive_level hub=%08X zone=0x%02X %u%% fade=%uqs\r\n",
           (unsigned)hub_id, zone_byte, level_pct, fade_qs);
    return g;
}

TdmaJobGroup cca_jobs_vive_dim(uint32_t hub_id, uint8_t zone_byte, uint8_t direction)
{
    TdmaJobGroup g = {};

    /* Phase 0: hold-start (short burst) */
    cca_build_vive_dim_start(g.phases[0].packet.data, hub_id, zone_byte, direction);
    g.phases[0].packet.len = 22;
    g.phases[0].packet.type_base = 0x89;
    g.phases[0].packet.type_rotate = 1;
    g.phases[0].tx_count = CCA_TX_COUNT_BURST;
    g.phases[0].post_delay_ms = 50;

    /* Phase 1: dim-step (full burst) */
    cca_build_vive_dim_stop(g.phases[1].packet.data, hub_id, zone_byte, direction);
    g.phases[1].packet.len = 22;
    g.phases[1].packet.type_base = 0x89;
    g.phases[1].packet.type_rotate = 1;
    g.phases[1].tx_count = CCA_TX_COUNT_NORMAL;
    g.phases[1].post_delay_ms = 0;

    g.phase_count = 2;

    printf("[cca] JOB vive_dim hub=%08X zone=0x%02X dir=%s\r\n",
           (unsigned)hub_id, zone_byte, direction == 0x03 ? "raise" : "lower");
    return g;
}
```

- [ ] **Step 3: Declare in `cca_commands.h`**

```c
TdmaJobGroup cca_jobs_vive_level(uint32_t hub_id, uint8_t zone_byte, uint8_t level_pct, uint8_t fade_qs);
TdmaJobGroup cca_jobs_vive_dim(uint32_t hub_id, uint8_t zone_byte, uint8_t direction);
```

- [ ] **Step 4: Write tests**

Add to `firmware/tests/test_cmd_builders.cpp`:

```cpp
TEST(cmd_vive_level_group)
{
    TdmaJobGroup g = cca_jobs_vive_level(0xDEADBEEF, 0x03, 50, 4);
    ASSERT_EQ(g.phase_count, 1);
    ASSERT_EQ(g.phases[0].tx_count, CCA_TX_COUNT_NORMAL);
    ASSERT_EQ(g.phases[0].packet.type_base, 0x89);
    ASSERT_EQ(g.phases[0].packet.type_rotate, 1);
    ASSERT_EQ(g.phases[0].packet.len, 22);
    ASSERT_EQ(g.phases[0].packet.data[7], QS_FMT_LEVEL);
    ASSERT_EQ(g.phases[0].packet.data[12], 0x03);
    ASSERT_EQ(g.phases[0].packet.data[13], QS_ADDR_GROUP);
    ASSERT_EQ(g.phases[0].packet.data[19], 4);
}

TEST(cmd_vive_dim_group_two_phases)
{
    TdmaJobGroup g = cca_jobs_vive_dim(0xDEADBEEF, 0x03, 0x03);
    ASSERT_EQ(g.phase_count, 2);
    /* Phase 0: hold-start */
    ASSERT_EQ(g.phases[0].tx_count, CCA_TX_COUNT_BURST);
    ASSERT_EQ(g.phases[0].packet.type_base, 0x89);
    ASSERT_EQ(g.phases[0].packet.data[7], QS_FMT_CTRL);
    ASSERT_EQ(g.phases[0].packet.data[15], QS_TYPE_HOLD);
    ASSERT_EQ(g.phases[0].packet.data[16], 0x03);
    ASSERT_EQ(g.phases[0].post_delay_ms, 50);
    /* Phase 1: dim-step */
    ASSERT_EQ(g.phases[1].tx_count, CCA_TX_COUNT_NORMAL);
    ASSERT_EQ(g.phases[1].packet.data[7], QS_FMT_DIM_STEP);
    ASSERT_EQ(g.phases[1].packet.data[15], QS_TYPE_EXECUTE);
    ASSERT_EQ(g.phases[1].packet.data[16], 0x03);
}
```

- [ ] **Step 5: Build and run tests**

Run: `cd /Volumes/Secondary/lutron-tools/firmware && make test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add firmware/src/cca/cca_tx_builder.h firmware/src/cca/cca_commands.h \
        firmware/src/cca/cca_commands.cpp firmware/tests/test_cmd_builders.cpp
git commit -m "feat: add job builders for vive_level and vive_dim (2-phase)"
```

---

### Task 6: QS Link builders — identify and query

**Files:**
- Modify: `firmware/src/cca/cca_tx_builder.h` (add 2 helpers)
- Modify: `firmware/src/cca/cca_commands.h` (declare builders)
- Modify: `firmware/src/cca/cca_commands.cpp` (add builders)
- Modify: `firmware/tests/test_cmd_builders.cpp` (add tests)

- [ ] **Step 1: Add QS Link packet builder helpers to `cca_tx_builder.h`**

```cpp
/* -----------------------------------------------------------------------
 * Build identify packet (format 0x09, 22 bytes)
 * QS_CLASS_DEVICE + QS_TYPE_IDENTIFY — flashes device LED.
 * Uses target_id as both source and target (pretending to be processor).
 * ----------------------------------------------------------------------- */
inline size_t cca_build_identify(uint8_t* pkt, uint32_t target_id)
{
    memset(pkt, 0x00, 22);

    pkt[0] = 0x81;
    cca_write_id_be(pkt + 2, target_id);

    pkt[6] = QS_PROTO_RADIO_TX;
    pkt[7] = QS_FMT_CTRL;
    pkt[8] = 0x00;

    cca_write_id_be(pkt + 9, target_id);
    pkt[13] = QS_ADDR_COMPONENT;
    pkt[14] = QS_CLASS_DEVICE;
    pkt[15] = QS_TYPE_IDENTIFY;
    pkt[16] = 0x01;

    return 22;
}

/* -----------------------------------------------------------------------
 * Build query packet (format 0x09, 22 bytes)
 * QS_CLASS_SELECT + QS_TYPE_EXECUTE — requests component info.
 * ----------------------------------------------------------------------- */
inline size_t cca_build_query(uint8_t* pkt, uint32_t target_id)
{
    memset(pkt, 0x00, 22);

    pkt[0] = 0x81;
    cca_write_id_be(pkt + 2, target_id);

    pkt[6] = QS_PROTO_RADIO_TX;
    pkt[7] = QS_FMT_CTRL;
    pkt[8] = 0x00;

    cca_write_id_be(pkt + 9, target_id);
    pkt[13] = QS_ADDR_COMPONENT;
    pkt[14] = QS_CLASS_SELECT;
    pkt[15] = QS_TYPE_EXECUTE;
    pkt[16] = 0x0D;

    return 22;
}
```

- [ ] **Step 2: Add job builders to `cca_commands.cpp`**

```cpp
TdmaJobGroup cca_jobs_identify(uint32_t target_id)
{
    TdmaJobGroup g = {};
    g.phase_count = 1;

    cca_build_identify(g.phases[0].packet.data, target_id);
    g.phases[0].packet.len = 22;
    g.phases[0].packet.type_base = 0x81;
    g.phases[0].packet.type_rotate = 1;
    g.phases[0].tx_count = CCA_TX_COUNT_NORMAL;

    printf("[cca] JOB identify target=%08X\r\n", (unsigned)target_id);
    return g;
}

TdmaJobGroup cca_jobs_query(uint32_t target_id)
{
    TdmaJobGroup g = {};
    g.phase_count = 1;

    cca_build_query(g.phases[0].packet.data, target_id);
    g.phases[0].packet.len = 22;
    g.phases[0].packet.type_base = 0x81;
    g.phases[0].packet.type_rotate = 1;
    g.phases[0].tx_count = CCA_TX_COUNT_NORMAL;

    printf("[cca] JOB query target=%08X\r\n", (unsigned)target_id);
    return g;
}
```

- [ ] **Step 3: Declare in `cca_commands.h`**

```c
TdmaJobGroup cca_jobs_identify(uint32_t target_id);
TdmaJobGroup cca_jobs_query(uint32_t target_id);
```

- [ ] **Step 4: Write tests**

Add to `firmware/tests/test_cmd_builders.cpp`:

```cpp
TEST(cmd_identify_group)
{
    TdmaJobGroup g = cca_jobs_identify(0x00030004);
    ASSERT_EQ(g.phase_count, 1);
    ASSERT_EQ(g.phases[0].tx_count, CCA_TX_COUNT_NORMAL);
    ASSERT_EQ(g.phases[0].packet.type_base, 0x81);
    ASSERT_EQ(g.phases[0].packet.data[7], QS_FMT_CTRL);
    ASSERT_EQ(g.phases[0].packet.data[14], QS_CLASS_DEVICE);
    ASSERT_EQ(g.phases[0].packet.data[15], QS_TYPE_IDENTIFY);
    ASSERT_EQ(g.phases[0].packet.data[16], 0x01);
}

TEST(cmd_query_group)
{
    TdmaJobGroup g = cca_jobs_query(0x00030004);
    ASSERT_EQ(g.phase_count, 1);
    ASSERT_EQ(g.phases[0].tx_count, CCA_TX_COUNT_NORMAL);
    ASSERT_EQ(g.phases[0].packet.data[14], QS_CLASS_SELECT);
    ASSERT_EQ(g.phases[0].packet.data[15], QS_TYPE_EXECUTE);
    ASSERT_EQ(g.phases[0].packet.data[16], 0x0D);
}
```

- [ ] **Step 5: Build and run tests**

Run: `cd /Volumes/Secondary/lutron-tools/firmware && make test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add firmware/src/cca/cca_tx_builder.h firmware/src/cca/cca_commands.h \
        firmware/src/cca/cca_commands.cpp firmware/tests/test_cmd_builders.cpp
git commit -m "feat: add job builders for identify and query commands"
```

---

### Task 7: Wire routing and delete dead code

**Files:**
- Modify: `firmware/src/cca/cca_commands.cpp` (update router, delete exec functions)
- Modify: `firmware/tests/test_cmd_builders.cpp` (add routing tests)

- [ ] **Step 1: Update `cca_cmd_to_jobs()` router**

Replace the entire `cca_cmd_to_jobs()` function (~line 150):

```cpp
TdmaJobGroup cca_cmd_to_jobs(const CcaCmdItem* item)
{
    TdmaJobGroup empty = {};
    if (!item) return empty;

    switch (item->cmd) {
    case CCA_CMD_BUTTON:
        return cca_jobs_button(item->device_id, item->button);
    case CCA_CMD_BRIDGE_LEVEL:
        return cca_jobs_bridge_level(item->device_id, item->target_id,
                                     item->level_pct, item->fade_qs);
    case CCA_CMD_PICO_LEVEL:
        return cca_jobs_pico_level(item->device_id, item->level_pct);
    case CCA_CMD_STATE_REPORT:
        return cca_jobs_state_report(item->device_id, item->level_pct);
    case CCA_CMD_BEACON:
        return cca_jobs_beacon(item->device_id, 0x91);
    case CCA_CMD_UNPAIR:
        return cca_jobs_unpair(item->device_id, item->target_id);
    case CCA_CMD_LED_CONFIG:
        return cca_jobs_led_config(item->device_id, item->target_id, item->led_mode);
    case CCA_CMD_FADE_CONFIG:
        return cca_jobs_fade_config(item->device_id, item->target_id,
                                    item->fade_on_qs, item->fade_off_qs);
    case CCA_CMD_TRIM_CONFIG:
        return cca_jobs_trim_config(item->device_id, item->target_id,
                                    item->high_trim, item->low_trim);
    case CCA_CMD_PHASE_CONFIG:
        return cca_jobs_phase_config(item->device_id, item->target_id, item->phase_byte);
    case CCA_CMD_SAVE_FAV:
        return cca_jobs_save_fav(item->device_id);
    case CCA_CMD_VIVE_LEVEL:
        return cca_jobs_vive_level(item->device_id, item->zone_byte,
                                   item->level_pct, item->fade_qs);
    case CCA_CMD_VIVE_DIM:
        return cca_jobs_vive_dim(item->device_id, item->zone_byte, item->direction);
    case CCA_CMD_BROADCAST_LEVEL:
        return cca_jobs_broadcast_level(item->device_id, item->level_pct, item->fade_qs);
    case CCA_CMD_IDENTIFY:
        return cca_jobs_identify(item->target_id);
    case CCA_CMD_QUERY:
        return cca_jobs_query(item->target_id);
    case CCA_CMD_SCENE_EXEC:
        return cca_jobs_scene_exec(item->device_id, item->target_id,
                                   item->level_pct, item->fade_qs);
    case CCA_CMD_DIM_CONFIG:
        return cca_jobs_dim_config(item->device_id, item->target_id,
                                   item->raw_payload, item->raw_payload_len);
    case CCA_CMD_RAW:
        return cca_jobs_raw(item->raw_payload, item->raw_payload_len, item->raw_repeat);
    default:
        printf("[cca] JOB: unsupported cmd 0x%02X, falling back to blocking\r\n",
               item->cmd);
        return empty;
    }
}
```

- [ ] **Step 2: Shrink `cca_cmd_execute()` to pairing-only**

Replace the entire `cca_cmd_execute()` function:

```cpp
void cca_cmd_execute(const CcaCmdItem* item)
{
    switch (item->cmd) {
    case CCA_CMD_PICO_PAIR:
    case CCA_CMD_BRIDGE_PAIR:
    case CCA_CMD_VIVE_PAIR:
    case CCA_CMD_ANNOUNCE:
    case CCA_CMD_HYBRID_PAIR:
    case CCA_CMD_SUBNET_PAIR:
        cca_pairing_execute(item);
        break;
    case CCA_CMD_AUTO_PAIR:
        cca_auto_pair_start(item->device_id, item->target_id,
                            (uint16_t)((item->raw_payload[0] << 8) | item->raw_payload[1]),
                            item->zone_byte, item->duration_sec);
        break;
    case CCA_CMD_AUTO_PAIR_STOP:
        cca_auto_pair_stop();
        break;
    default:
        printf("[cca] Unknown command type: 0x%02X\r\n", item->cmd);
        break;
    }
}
```

- [ ] **Step 3: Delete dead exec functions**

Delete these static functions from `cca_commands.cpp` (they are no longer called):
- `exec_button()` and all helpers (exec_bridge_level, etc.)
- `exec_pico_level()`
- `exec_state_report()`
- `exec_beacon()`
- `exec_unpair()`
- `exec_led_config()`
- `exec_fade_config()`
- `exec_trim_config()`
- `exec_phase_config()`
- `exec_save_fav()`
- `exec_vive_level()`
- `exec_vive_dim()`
- `exec_broadcast_level()`
- `exec_identify()`
- `exec_query()`
- `exec_raw_cmd()`
- `exec_scene_execute()`
- `exec_dim_config()`
- `transmit_one()` (if only used by exec functions — check first)
- `vive_cmd_seq_` static variable
- `type_alternate_` static variable (if only used by deleted exec functions)

Keep: `cmd_queue`, `cca_cmd_queue_init()`, `cca_cmd_enqueue()`, `cca_cmd_queue_handle()`, `cca_cmd_tx_count()`, all `cca_jobs_*()` builders, `cca_cmd_to_jobs()`, `cca_cmd_execute()` (pairing-only version).

Note: `transmit_one()` may still be used by `cca_tdma.cpp` — check with grep before deleting. If it's used by both, keep it.

- [ ] **Step 4: Add routing tests**

Add to `firmware/tests/test_cmd_builders.cpp`:

```cpp
TEST(cmd_to_jobs_routes_all_commands)
{
    /* Verify all 19 packet-based commands return non-empty groups */
    uint8_t cmds[] = {
        CCA_CMD_BUTTON, CCA_CMD_BRIDGE_LEVEL, CCA_CMD_PICO_LEVEL,
        CCA_CMD_STATE_REPORT, CCA_CMD_BEACON, CCA_CMD_UNPAIR,
        CCA_CMD_LED_CONFIG, CCA_CMD_FADE_CONFIG, CCA_CMD_TRIM_CONFIG,
        CCA_CMD_PHASE_CONFIG, CCA_CMD_SAVE_FAV, CCA_CMD_VIVE_LEVEL,
        CCA_CMD_VIVE_DIM, CCA_CMD_BROADCAST_LEVEL, CCA_CMD_IDENTIFY,
        CCA_CMD_QUERY, CCA_CMD_RAW, CCA_CMD_SCENE_EXEC, CCA_CMD_DIM_CONFIG,
    };
    for (size_t i = 0; i < sizeof(cmds); i++) {
        CcaCmdItem item = {};
        item.cmd = cmds[i];
        item.device_id = 0x00010002;
        item.target_id = 0x00030004;
        item.level_pct = 50;
        item.fade_qs = 4;
        item.zone_byte = 0x01;
        item.direction = 0x03;
        item.raw_payload_len = 4;
        item.raw_repeat = 5;
        TdmaJobGroup g = cca_cmd_to_jobs(&item);
        ASSERT_TRUE(g.phase_count > 0);
    }
}

TEST(cmd_to_jobs_pairing_returns_empty)
{
    /* Pairing commands should still return empty (handled by blocking path) */
    uint8_t pairing_cmds[] = {
        CCA_CMD_PICO_PAIR, CCA_CMD_BRIDGE_PAIR, CCA_CMD_VIVE_PAIR,
        CCA_CMD_ANNOUNCE, CCA_CMD_HYBRID_PAIR, CCA_CMD_SUBNET_PAIR,
    };
    for (size_t i = 0; i < sizeof(pairing_cmds); i++) {
        CcaCmdItem item = {};
        item.cmd = pairing_cmds[i];
        TdmaJobGroup g = cca_cmd_to_jobs(&item);
        ASSERT_EQ(g.phase_count, 0);
    }
}
```

- [ ] **Step 5: Build and run tests**

Run: `cd /Volumes/Secondary/lutron-tools/firmware && make test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add firmware/src/cca/cca_commands.cpp firmware/tests/test_cmd_builders.cpp
git commit -m "feat: wire all 19 commands through job router, delete blocking exec functions

Only pairing commands (GLAB-67) remain on the blocking cca_cmd_execute() path."
```

---

### Task 8: Cross-compile and final verification

**Files:** None modified — verification only.

- [ ] **Step 1: Run host tests one final time**

Run: `cd /Volumes/Secondary/lutron-tools/firmware && make test`
Expected: All tests pass (should be ~90+ tests now).

- [ ] **Step 2: Cross-compile for STM32**

Run: `cd /Volumes/Secondary/lutron-tools/firmware && cmake -B build -DCMAKE_TOOLCHAIN_FILE=cmake/arm-none-eabi.cmake && make -C build -j8`
Expected: Clean build, no warnings.

- [ ] **Step 3: Run full CI checks**

Run: `cd /Volumes/Secondary/lutron-tools && npm run lint && npm run typecheck && npm run codegen:check`
Expected: All pass (firmware changes don't affect TS, but verify no regressions).

- [ ] **Step 4: Verify test count**

Check the test runner output shows the expected count. Should be original count + 17 new tests (4 short + 2 multi-phase + 5 config + 2 vive + 2 qs-link + 2 routing).

- [ ] **Step 5: Update GLAB-64 in Linear**

Update the issue description to reflect completed migration. The "remaining gaps" section should now only list:
1. Format coverage expansion (~15/43 format codes parsed)
2. Device type correction (0x2F)
