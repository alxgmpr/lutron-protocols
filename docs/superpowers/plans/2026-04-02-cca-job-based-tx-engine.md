# CCA Job-Based TX Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace blocking CCA TX with a non-blocking, TDMA-scheduled job group engine so RX is never interrupted for more than ~2ms.

**Architecture:** Commands decompose into `TdmaJobGroup` structs (phases of retransmitting packets). The TDMA engine fires one packet per poll cycle in the assigned slot. The CCA task main loop becomes: check RX, poll TDMA, dequeue commands.

**Tech Stack:** C++17, FreeRTOS, STM32H723 HAL, clang++ host tests

**Spec:** `docs/superpowers/specs/2026-04-02-cca-job-based-tx-engine-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `firmware/src/cca/cca_tdma.h` | Modify | Add TdmaJobGroup structs, new API declarations |
| `firmware/src/cca/cca_tdma.cpp` | Modify | Replace single-job engine with group-based engine |
| `firmware/src/cca/cca_commands.h` | Modify | Add `cca_jobs_*` builder declarations |
| `firmware/src/cca/cca_commands.cpp` | Rewrite | Replace blocking execute with job builders + submit |
| `firmware/src/cca/cca_task.cpp` | Modify | Simplify main loop, remove immediate queue |
| `firmware/tests/test_tdma_jobs.cpp` | Create | Job group lifecycle unit tests |
| `firmware/tests/test_cmd_builders.cpp` | Create | Command builder unit tests |
| `firmware/Makefile` | Modify | Add new test files to compilation |

---

### Task 1: Add TdmaJobGroup data structures to cca_tdma.h

**Files:**
- Modify: `firmware/src/cca/cca_tdma.h`

- [ ] **Step 1: Add new structs after the existing `CcaTdmaTxRequest` typedef (line ~90)**

Add these structs before the `/* Public API */` section:

```c
/* -----------------------------------------------------------------------
 * Job group — multi-phase TX command (non-blocking)
 *
 * A command (button, level, pairing) decomposes into phases.
 * Each phase is a packet retransmitted N times at one-frame intervals.
 * The TDMA engine fires one packet per poll cycle per group.
 * ----------------------------------------------------------------------- */
#define TDMA_MAX_PHASES 8
#define TDMA_MAX_GROUPS 4

typedef struct {
    uint8_t data[53];     /* raw payload (pre-CRC, pre-8N1) */
    uint8_t len;          /* 22 (short) or 51 (long) */
    uint8_t type_rotate;  /* 0=fixed type byte, 1=rotate 81/82/83 per retransmit */
} TdmaPacket;

typedef struct {
    TdmaPacket packet;
    uint8_t retransmits;     /* frames to repeat (5=normal, 10=pairing) */
    uint16_t post_delay_ms;  /* delay after phase completes before next (0=immediate) */
} TdmaPhase;

typedef struct TdmaJobGroup {
    TdmaPhase phases[TDMA_MAX_PHASES];
    uint8_t phase_count;

    /* Managed by engine — caller does not set these: */
    uint8_t slot;
    uint8_t current_phase;
    uint8_t current_retransmit;
    uint32_t next_fire_ms;
    bool active;

    void (*on_complete)(void* ctx);
    void* ctx;
} TdmaJobGroup;
```

- [ ] **Step 2: Add new API declarations after `cca_tdma_submit` (line ~113)**

Add these after the existing `cca_tdma_cancel` declaration:

```c
/**
 * Submit a job group for TDMA-scheduled multi-phase transmission.
 * The engine copies the group. Returns true on success, false if full.
 */
bool cca_tdma_submit_group(const TdmaJobGroup* group);

/** Cancel all active job groups. */
void cca_tdma_cancel_groups(void);

/** Check if all job groups are idle (no active TX). */
bool cca_tdma_is_idle(void);
```

- [ ] **Step 3: Verify compilation**

Run: `make -C firmware test`
Expected: 65 passed, 0 failed (structs added, no logic changes yet)

- [ ] **Step 4: Commit**

```bash
git add firmware/src/cca/cca_tdma.h
git commit -m "cca: add TdmaJobGroup structs and API declarations"
```

---

### Task 2: Write job group lifecycle tests

**Files:**
- Create: `firmware/tests/test_tdma_jobs.cpp`
- Modify: `firmware/Makefile`

- [ ] **Step 1: Create test file with group lifecycle tests**

Create `firmware/tests/test_tdma_jobs.cpp`:

```cpp
/**
 * TDMA job group engine tests — group submission, phase advancement, completion.
 *
 * These test the job group state machine in isolation using mock tick values.
 * No hardware stubs needed — pure logic tests on the TdmaJobGroup struct.
 */

#include <cstdint>
#include <cstdio>
#include <cstring>

#include "cca_tdma.h"
#include "cca_tx_builder.h"

extern int test_pass_count;
extern int test_fail_count;
extern void test_registry_add(const char *name, void (*func)());

#define TEST(name) \
    static void test_##name(); \
    static struct test_reg_##name { \
        test_reg_##name() { test_registry_add(#name, test_##name); } \
    } test_reg_inst_##name; \
    static void test_##name()

#define ASSERT_TRUE(expr) do { \
    if (!(expr)) { \
        printf("  FAIL: %s:%d: %s\n", __FILE__, __LINE__, #expr); \
        test_fail_count++; \
        return; \
    } \
} while (0)

#define ASSERT_EQ(a, b) do { \
    auto _a = (a); auto _b = (b); \
    if (_a != _b) { \
        printf("  FAIL: %s:%d: %s == %lld, expected %lld\n", \
               __FILE__, __LINE__, #a, (long long)_a, (long long)_b); \
        test_fail_count++; \
        return; \
    } \
} while (0)

/* --- Helper: build a simple single-phase group for testing --- */
static TdmaJobGroup make_test_group(uint8_t retransmits, uint16_t post_delay_ms)
{
    TdmaJobGroup g = {};
    g.phase_count = 1;
    g.phases[0].packet.len = 22;
    g.phases[0].packet.data[0] = 0x81; /* type byte */
    g.phases[0].retransmits = retransmits;
    g.phases[0].post_delay_ms = post_delay_ms;
    g.on_complete = nullptr;
    g.ctx = nullptr;
    return g;
}

static TdmaJobGroup make_two_phase_group(uint8_t r1, uint16_t delay1, uint8_t r2)
{
    TdmaJobGroup g = {};
    g.phase_count = 2;

    g.phases[0].packet.len = 22;
    g.phases[0].packet.data[0] = 0x89; /* BTN_LONG_A */
    g.phases[0].retransmits = r1;
    g.phases[0].post_delay_ms = delay1;

    g.phases[1].packet.len = 22;
    g.phases[1].packet.data[0] = 0x88; /* BTN_SHORT_A */
    g.phases[1].retransmits = r2;
    g.phases[1].post_delay_ms = 0;

    g.on_complete = nullptr;
    g.ctx = nullptr;
    return g;
}

/* --- Tests --- */

TEST(job_group_struct_constants)
{
    ASSERT_EQ(TDMA_MAX_PHASES, 8);
    ASSERT_EQ(TDMA_MAX_GROUPS, 4);
    /* Structs must hold payload data */
    ASSERT_TRUE(sizeof(TdmaPacket) >= 55);  /* 53 data + len + type_rotate */
    ASSERT_TRUE(sizeof(TdmaJobGroup) > sizeof(TdmaPhase));
}

TEST(job_group_single_phase_init)
{
    TdmaJobGroup g = make_test_group(5, 0);
    ASSERT_EQ(g.phase_count, 1);
    ASSERT_EQ(g.phases[0].retransmits, 5);
    ASSERT_EQ(g.phases[0].post_delay_ms, 0);
    ASSERT_EQ(g.phases[0].packet.len, 22);
    ASSERT_EQ(g.phases[0].packet.data[0], 0x81);
    ASSERT_EQ(g.active, false);
}

TEST(job_group_two_phase_init)
{
    TdmaJobGroup g = make_two_phase_group(2, 75, 7);
    ASSERT_EQ(g.phase_count, 2);
    ASSERT_EQ(g.phases[0].retransmits, 2);
    ASSERT_EQ(g.phases[0].post_delay_ms, 75);
    ASSERT_EQ(g.phases[0].packet.data[0], 0x89);
    ASSERT_EQ(g.phases[1].retransmits, 7);
    ASSERT_EQ(g.phases[1].post_delay_ms, 0);
    ASSERT_EQ(g.phases[1].packet.data[0], 0x88);
}

TEST(job_group_level_builder)
{
    /* Verify cca_build_set_level produces correct bytes */
    uint8_t pkt[22];
    size_t len = cca_build_set_level(pkt, 0x00010002, 0xFFFFFFFF,
                                     QS_ADDR_BROADCAST, 0xFEFF, 4, 0x81);
    ASSERT_EQ(len, (size_t)22);
    ASSERT_EQ(pkt[0], 0x81);                /* type */
    ASSERT_EQ(pkt[7], QS_FMT_LEVEL);        /* format 0x0E */
    ASSERT_EQ(pkt[13], QS_ADDR_BROADCAST);   /* broadcast */
    ASSERT_EQ(pkt[14], QS_CLASS_LEVEL);      /* class */
    ASSERT_EQ(pkt[15], QS_TYPE_EXECUTE);     /* execute */
    ASSERT_EQ(pkt[16], 0xFE);               /* level high */
    ASSERT_EQ(pkt[17], 0xFF);               /* level low */
    ASSERT_EQ(pkt[19], 4);                  /* fade 4qs */
}

TEST(job_group_beacon_builder)
{
    uint8_t pkt[22];
    size_t len = cca_build_beacon(pkt, 0xAABBCCDD, 0x91);
    ASSERT_EQ(len, (size_t)22);
    ASSERT_EQ(pkt[0], 0x91);
    ASSERT_EQ(pkt[2], 0xAA);
    ASSERT_EQ(pkt[3], 0xBB);
    ASSERT_EQ(pkt[4], 0xCC);
    ASSERT_EQ(pkt[5], 0xDD);
    ASSERT_EQ(pkt[7], QS_FMT_BEACON);
}
```

- [ ] **Step 2: Add test file to Makefile**

In `firmware/Makefile`, modify the `test` target to include the new file. Change:

```makefile
	    tests/test_main.cpp tests/test_crc.cpp tests/test_n81.cpp \
	    tests/test_decoder.cpp tests/test_cbor.cpp \
	    tests/test_tdma.cpp tests/test_encoder.cpp \
```

To:

```makefile
	    tests/test_main.cpp tests/test_crc.cpp tests/test_n81.cpp \
	    tests/test_decoder.cpp tests/test_cbor.cpp \
	    tests/test_tdma.cpp tests/test_encoder.cpp \
	    tests/test_tdma_jobs.cpp \
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `make -C firmware test`
Expected: 70+ passed (65 existing + 5 new), 0 failed

- [ ] **Step 4: Commit**

```bash
git add firmware/tests/test_tdma_jobs.cpp firmware/Makefile
git commit -m "test: add TDMA job group struct and builder tests"
```

---

### Task 3: Implement group-based engine in cca_tdma.cpp

**Files:**
- Modify: `firmware/src/cca/cca_tdma.cpp`

This is the core change. We add a `TdmaJobGroup groups_[]` array alongside the existing `jobs_[]` array, then implement `submit_group`, `poll` for groups, and `cancel_groups`. The existing single-job `cca_tdma_submit`/`fire_job` stays — it still works and pairing uses it during the transition.

- [ ] **Step 1: Add group array and helpers after the module state block (line ~97)**

After `static bool initialized_ = false;` add:

```cpp
static TdmaJobGroup groups_[TDMA_MAX_GROUPS] = {};
```

- [ ] **Step 2: Add fire_group_packet function after fire_job (line ~456)**

```cpp
/**
 * Fire one packet from a job group: update seq/type, TX, advance state.
 * Called from cca_tdma_poll when a group's next_fire_ms is due.
 */
static void fire_group_packet(TdmaJobGroup* g, uint32_t now_ms)
{
    TdmaPhase* phase = &g->phases[g->current_phase];
    uint8_t pkt[53];
    memcpy(pkt, phase->packet.data, phase->packet.len);

    /* Set sequence byte: low bits = slot, upper bits = counter */
    if (phase->packet.len > 1) {
        pkt[1] = g->slot + (uint8_t)(g->current_retransmit * frame_.slot_count);
    }

    /* Rotate type byte if requested (0x81 → 0x82 → 0x83 → 0x81...) */
    if (phase->packet.type_rotate && phase->packet.len > 0) {
        pkt[0] = 0x81 + (uint8_t)(g->current_retransmit % 3);
    }

    /* Stop RX, transmit, restart RX */
    cc1101_stop_rx();
    transmit_one(pkt, phase->packet.len);
    cc1101_start_rx();

    g->current_retransmit++;

    if (g->current_retransmit >= phase->retransmits) {
        /* Phase complete — advance to next */
        g->current_phase++;
        g->current_retransmit = 0;

        if (g->current_phase >= g->phase_count) {
            /* All phases done */
            if (g->on_complete) {
                g->on_complete(g->ctx);
            }
            g->active = false;
            return;
        }

        /* Apply post-delay if specified */
        if (phase->post_delay_ms > 0) {
            g->next_fire_ms = now_ms + phase->post_delay_ms;
        }
        else {
            g->next_fire_ms = next_slot_time(g->slot, now_ms);
        }
    }
    else {
        /* Schedule next retransmit one frame period later */
        uint32_t next = g->next_fire_ms + frame_.period_ms;
        if ((int32_t)(next - now_ms) < 2 || (int32_t)(next - now_ms) > (int32_t)frame_.period_ms) {
            next = next_slot_time(g->slot, now_ms);
        }
        g->next_fire_ms = next;
    }
}
```

- [ ] **Step 3: Implement cca_tdma_submit_group after cca_tdma_cancel (line ~569)**

```cpp
bool cca_tdma_submit_group(const TdmaJobGroup* group)
{
    if (!initialized_ || !group || group->phase_count == 0) return false;

    /* Find free group slot */
    TdmaJobGroup* g = nullptr;
    for (size_t i = 0; i < TDMA_MAX_GROUPS; i++) {
        if (!groups_[i].active) {
            g = &groups_[i];
            break;
        }
    }
    if (!g) {
        printf("[tdma] Job group queue full\r\n");
        return false;
    }

    uint32_t now = HAL_GetTick();

    /* Pick slot if we don't have one yet */
    if (!frame_.our_slot_valid) {
        frame_.our_slot = pick_tx_slot(now);
        frame_.our_slot_valid = true;
    }

    /* Copy group and initialize engine-managed fields */
    memcpy(g, group, sizeof(TdmaJobGroup));
    g->slot = frame_.our_slot;
    g->current_phase = 0;
    g->current_retransmit = 0;
    g->next_fire_ms = next_slot_time(g->slot, now);
    g->active = true;

    return true;
}

void cca_tdma_cancel_groups(void)
{
    for (size_t i = 0; i < TDMA_MAX_GROUPS; i++) {
        groups_[i].active = false;
    }
}

bool cca_tdma_is_idle(void)
{
    for (size_t i = 0; i < TDMA_MAX_GROUPS; i++) {
        if (groups_[i].active) return false;
    }
    for (size_t i = 0; i < CCA_TDMA_MAX_JOBS; i++) {
        if (jobs_[i].active) return false;
    }
    return true;
}
```

- [ ] **Step 4: Add group polling to cca_tdma_poll (modify line ~578)**

In `cca_tdma_poll`, after the existing job firing loop, add:

```cpp
    /* Fire due job group packets */
    for (size_t i = 0; i < TDMA_MAX_GROUPS; i++) {
        TdmaJobGroup* g = &groups_[i];
        if (!g->active) continue;

        int32_t until = (int32_t)(g->next_fire_ms - now_ms);
        if (until <= 0) {
            fire_group_packet(g, now_ms);
            break; /* at most one TX per poll cycle */
        }
    }
```

- [ ] **Step 5: Update should_hot_poll to include groups (modify line ~462)**

Add at the start of `should_hot_poll`, before the existing job loop:

```cpp
    for (size_t i = 0; i < TDMA_MAX_GROUPS; i++) {
        if (!groups_[i].active) continue;
        int32_t until = (int32_t)(groups_[i].next_fire_ms - now_ms);
        if (until >= -2 && until <= 7) return true;
    }
```

- [ ] **Step 6: Update telemetry to include groups**

In `cca_tdma_get_state`, update the active_jobs count to include groups:

```cpp
    uint8_t active_jobs = 0;
    for (size_t i = 0; i < CCA_TDMA_MAX_JOBS; i++) {
        if (jobs_[i].active) active_jobs++;
    }
    for (size_t i = 0; i < TDMA_MAX_GROUPS; i++) {
        if (groups_[i].active) active_jobs++;
    }
    out->active_jobs = active_jobs;
```

In `cca_tdma_reset`, add:

```cpp
    for (size_t i = 0; i < TDMA_MAX_GROUPS; i++) {
        groups_[i].active = false;
    }
```

- [ ] **Step 7: Verify compilation and tests pass**

Run: `make -C firmware test`
Expected: All tests pass (new engine code added but not yet called from commands)

- [ ] **Step 8: Commit**

```bash
git add firmware/src/cca/cca_tdma.cpp
git commit -m "cca: implement group-based TDMA engine (submit, poll, fire)"
```

---

### Task 4: Write command builder functions

**Files:**
- Modify: `firmware/src/cca/cca_commands.h`
- Modify: `firmware/src/cca/cca_commands.cpp`

- [ ] **Step 1: Add builder declarations to cca_commands.h**

Add before the closing `#ifdef __cplusplus` / `}`:

```c
/* -----------------------------------------------------------------------
 * Job group builders — decompose commands into TDMA-scheduled phases.
 * Each returns a TdmaJobGroup ready for cca_tdma_submit_group().
 * ----------------------------------------------------------------------- */
TdmaJobGroup cca_jobs_button(uint32_t device_id, uint8_t button);
TdmaJobGroup cca_jobs_bridge_level(uint32_t zone_id, uint32_t target_id,
                                    uint8_t level_pct, uint8_t fade_qs);
TdmaJobGroup cca_jobs_beacon(uint32_t zone_id, uint8_t type_byte);
TdmaJobGroup cca_jobs_raw(const uint8_t* payload, uint8_t len, uint8_t retransmits);

/** Convert a CcaCmdItem to a TdmaJobGroup. Returns group with phase_count=0 on error. */
TdmaJobGroup cca_cmd_to_jobs(const CcaCmdItem* item);
```

- [ ] **Step 2: Implement cca_jobs_bridge_level in cca_commands.cpp**

Add after the existing includes, before `exec_button`:

```cpp
#include "cca_tdma.h"
#include "cca_tx_builder.h"

/* -----------------------------------------------------------------------
 * Job group builders — non-blocking command decomposition
 * ----------------------------------------------------------------------- */

TdmaJobGroup cca_jobs_bridge_level(uint32_t zone_id, uint32_t target_id,
                                    uint8_t level_pct, uint8_t fade_qs)
{
    TdmaJobGroup g = {};
    g.phase_count = 1;

    uint16_t level16 = cca_percent_to_level16(level_pct);
    cca_build_set_level(g.phases[0].packet.data, zone_id, target_id,
                        QS_ADDR_COMPONENT, level16, fade_qs, 0x81);
    g.phases[0].packet.len = 22;
    g.phases[0].packet.type_rotate = 1; /* rotate 81/82/83 */
    g.phases[0].retransmits = CCA_TDMA_RETRIES_LEVEL;
    g.phases[0].post_delay_ms = 0;

    printf("[cca] JOB bridge_level zone=%08X target=%08X %u%% fade=%uqs\r\n",
           (unsigned)zone_id, (unsigned)target_id, level_pct, fade_qs);
    return g;
}
```

- [ ] **Step 3: Implement cca_jobs_button**

```cpp
TdmaJobGroup cca_jobs_button(uint32_t device_id, uint8_t button)
{
    TdmaJobGroup g = {};

    /* A/B alternation */
    static bool alt = false;
    uint8_t press_type = alt ? PKT_BTN_LONG_B : PKT_BTN_LONG_A;
    uint8_t release_type = alt ? PKT_BTN_SHORT_A : PKT_BTN_SHORT_B;
    alt = !alt;

    /* Map 5-btn raise/lower to 4-btn codes */
    bool is_dimming = (button == BTN_RAISE || button == BTN_LOWER);
    if (button == BTN_RAISE) button = 0x09;
    if (button == BTN_LOWER) button = 0x0A;

    uint8_t press_fmt = is_dimming ? QS_FMT_BEACON : QS_FMT_TAP;

    /* Phase 0: PRESS (short format) */
    cca_build_button_short(g.phases[0].packet.data, device_id, button,
                           ACTION_PRESS, press_fmt, press_type);
    g.phases[0].packet.len = 22;
    g.phases[0].packet.type_rotate = 0;
    g.phases[0].retransmits = 2;
    g.phases[0].post_delay_ms = 0; /* TDMA handles inter-frame timing */

    /* Phase 1: RELEASE (long format) */
    cca_build_button_long(g.phases[1].packet.data, device_id, button, release_type);
    g.phases[1].packet.len = 22;
    g.phases[1].packet.type_rotate = 0;
    g.phases[1].retransmits = 12;
    g.phases[1].post_delay_ms = 0;

    g.phase_count = 2;

    printf("[cca] JOB button dev=%08X btn=%s\r\n",
           (unsigned)device_id, cca_button_name(button));
    return g;
}
```

- [ ] **Step 4: Implement cca_jobs_beacon and cca_jobs_raw**

```cpp
TdmaJobGroup cca_jobs_beacon(uint32_t zone_id, uint8_t type_byte)
{
    TdmaJobGroup g = {};
    g.phase_count = 1;

    cca_build_beacon(g.phases[0].packet.data, zone_id, type_byte);
    g.phases[0].packet.len = 22;
    g.phases[0].packet.type_rotate = 0;
    g.phases[0].retransmits = CCA_TDMA_RETRIES_NORMAL;
    g.phases[0].post_delay_ms = 0;

    printf("[cca] JOB beacon zone=%08X type=0x%02X\r\n",
           (unsigned)zone_id, type_byte);
    return g;
}

TdmaJobGroup cca_jobs_raw(const uint8_t* payload, uint8_t len, uint8_t retransmits)
{
    TdmaJobGroup g = {};
    if (len == 0 || len > 53) return g;

    g.phase_count = 1;
    memcpy(g.phases[0].packet.data, payload, len);
    g.phases[0].packet.len = len;
    g.phases[0].packet.type_rotate = 0;
    g.phases[0].retransmits = retransmits > 0 ? retransmits : CCA_TDMA_RETRIES_NORMAL;
    g.phases[0].post_delay_ms = 0;

    return g;
}
```

- [ ] **Step 5: Implement cca_cmd_to_jobs dispatcher**

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
    case CCA_CMD_BEACON:
        return cca_jobs_beacon(item->device_id, 0x91);
    case CCA_CMD_RAW:
        return cca_jobs_raw(item->raw_payload, item->raw_payload_len,
                           item->raw_repeat);
    default:
        printf("[cca] JOB: unsupported cmd 0x%02X, falling back to blocking\r\n",
               item->cmd);
        return empty; /* phase_count=0 signals fallback */
    }
}
```

- [ ] **Step 6: Verify compilation**

Run: `make -C firmware test`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add firmware/src/cca/cca_commands.h firmware/src/cca/cca_commands.cpp
git commit -m "cca: add non-blocking job group builders for button/level/beacon/raw"
```

---

### Task 5: Write command builder tests

**Files:**
- Create: `firmware/tests/test_cmd_builders.cpp`
- Modify: `firmware/Makefile`

- [ ] **Step 1: Create test file**

Create `firmware/tests/test_cmd_builders.cpp`:

```cpp
/**
 * Command builder tests — verify cca_jobs_* produce correct TdmaJobGroups.
 */

#include <cstdint>
#include <cstdio>
#include <cstring>

#include "cca_tdma.h"
#include "cca_commands.h"
#include "cca_tx_builder.h"
#include "cca_types.h"

extern int test_pass_count;
extern int test_fail_count;
extern void test_registry_add(const char *name, void (*func)());

#define TEST(name) \
    static void test_##name(); \
    static struct test_reg_##name { \
        test_reg_##name() { test_registry_add(#name, test_##name); } \
    } test_reg_inst_##name; \
    static void test_##name()

#define ASSERT_TRUE(expr) do { \
    if (!(expr)) { \
        printf("  FAIL: %s:%d: %s\n", __FILE__, __LINE__, #expr); \
        test_fail_count++; \
        return; \
    } \
} while (0)

#define ASSERT_EQ(a, b) do { \
    auto _a = (a); auto _b = (b); \
    if (_a != _b) { \
        printf("  FAIL: %s:%d: %s == %lld, expected %lld\n", \
               __FILE__, __LINE__, #a, (long long)_a, (long long)_b); \
        test_fail_count++; \
        return; \
    } \
} while (0)

/* Stub printf for builders that log */
/* (printf is already available from cstdio) */

TEST(cmd_bridge_level_group)
{
    TdmaJobGroup g = cca_jobs_bridge_level(0x00010002, 0xFFFFFFFF, 75, 8);
    ASSERT_EQ(g.phase_count, 1);
    ASSERT_EQ(g.phases[0].retransmits, CCA_TDMA_RETRIES_LEVEL); /* 20 */
    ASSERT_EQ(g.phases[0].packet.type_rotate, 1);
    ASSERT_EQ(g.phases[0].packet.len, 22);
    /* Verify level encoding: 75% = 75 * 65279 / 100 = 48959 = 0xBF3F */
    ASSERT_EQ(g.phases[0].packet.data[16], 0xBF);
    ASSERT_EQ(g.phases[0].packet.data[17], 0x3F);
    ASSERT_EQ(g.phases[0].packet.data[19], 8); /* fade */
}

TEST(cmd_button_group_has_two_phases)
{
    TdmaJobGroup g = cca_jobs_button(0x08692D70, 0x02 /* ON */);
    ASSERT_EQ(g.phase_count, 2);
    /* Phase 0: PRESS, short format */
    ASSERT_EQ(g.phases[0].packet.len, 22);
    ASSERT_EQ(g.phases[0].retransmits, 2);
    ASSERT_EQ(g.phases[0].packet.data[11], ACTION_PRESS);
    /* Phase 1: RELEASE, long format */
    ASSERT_EQ(g.phases[1].packet.len, 22);
    ASSERT_EQ(g.phases[1].retransmits, 12);
    ASSERT_EQ(g.phases[1].packet.data[11], ACTION_RELEASE);
}

TEST(cmd_beacon_group)
{
    TdmaJobGroup g = cca_jobs_beacon(0xAABBCCDD, 0x92);
    ASSERT_EQ(g.phase_count, 1);
    ASSERT_EQ(g.phases[0].retransmits, CCA_TDMA_RETRIES_NORMAL); /* 5 */
    ASSERT_EQ(g.phases[0].packet.data[0], 0x92);
    ASSERT_EQ(g.phases[0].packet.len, 22);
}

TEST(cmd_raw_group)
{
    uint8_t payload[22] = {0x81, 0x00, 0xDE, 0xAD};
    TdmaJobGroup g = cca_jobs_raw(payload, 22, 10);
    ASSERT_EQ(g.phase_count, 1);
    ASSERT_EQ(g.phases[0].retransmits, 10);
    ASSERT_EQ(g.phases[0].packet.data[0], 0x81);
    ASSERT_EQ(g.phases[0].packet.data[2], 0xDE);
}

TEST(cmd_to_jobs_level)
{
    CcaCmdItem item = {};
    item.cmd = CCA_CMD_BRIDGE_LEVEL;
    item.device_id = 0x00010002;
    item.target_id = 0xFFFFFFFF;
    item.level_pct = 50;
    item.fade_qs = 4;

    TdmaJobGroup g = cca_cmd_to_jobs(&item);
    ASSERT_EQ(g.phase_count, 1);
    ASSERT_EQ(g.phases[0].packet.type_rotate, 1);
}

TEST(cmd_to_jobs_unknown_returns_empty)
{
    CcaCmdItem item = {};
    item.cmd = 0xFF; /* invalid */
    TdmaJobGroup g = cca_cmd_to_jobs(&item);
    ASSERT_EQ(g.phase_count, 0);
}
```

- [ ] **Step 2: Add to Makefile**

Change the test line to:

```makefile
	    tests/test_main.cpp tests/test_crc.cpp tests/test_n81.cpp \
	    tests/test_decoder.cpp tests/test_cbor.cpp \
	    tests/test_tdma.cpp tests/test_encoder.cpp \
	    tests/test_tdma_jobs.cpp tests/test_cmd_builders.cpp \
```

- [ ] **Step 3: Run tests**

Run: `make -C firmware test`
Expected: 75+ passed, 0 failed

- [ ] **Step 4: Commit**

```bash
git add firmware/tests/test_cmd_builders.cpp firmware/Makefile
git commit -m "test: add command builder tests for level/button/beacon/raw groups"
```

---

### Task 6: Wire up CCA task main loop

**Files:**
- Modify: `firmware/src/cca/cca_task.cpp`

This is the integration step. The CCA task main loop switches from calling `cca_cmd_execute()` (blocking) to calling `cca_cmd_to_jobs()` + `cca_tdma_submit_group()` (non-blocking). The immediate TX queue is removed.

- [ ] **Step 1: Add include at top of cca_task.cpp**

Add after existing includes:

```cpp
#include "cca_tx_builder.h"
```

- [ ] **Step 2: Remove immediate queue declaration (line ~61)**

Delete:

```cpp
static QueueHandle_t cca_tx_immediate_queue = NULL; /* bypass TDMA (pairing) */
```

- [ ] **Step 3: Remove immediate queue creation in task init**

In the init function (around line 429), delete the line:

```cpp
    cca_tx_immediate_queue = xQueueCreate(CCA_TX_QUEUE_LEN, sizeof(CcaTxItem));
```

- [ ] **Step 4: Remove the cca_tx_send_immediate function (around line 445-455)**

Delete the entire function.

- [ ] **Step 5: Remove the immediate TX queue processing block (lines 388-408)**

Delete the entire `/* Process immediate TX queue */` while loop.

- [ ] **Step 6: Replace the command queue processing block (lines 410-419)**

Replace:

```cpp
        /* Process command queue (non-blocking).
         * Commands execute synchronously with delays (blocking this task),
         * which is fine since they handle stop_rx/start_rx internally. */
        {
            QueueHandle_t cmdq = (QueueHandle_t)cca_cmd_queue_handle();
            CcaCmdItem cmd_item;
            while (cmdq && xQueueReceive(cmdq, &cmd_item, 0) == pdTRUE) {
                cca_cmd_execute(&cmd_item);
            }
        }
```

With:

```cpp
        /* Process command queue — convert to job groups and submit to TDMA */
        {
            QueueHandle_t cmdq = (QueueHandle_t)cca_cmd_queue_handle();
            CcaCmdItem cmd_item;
            while (cmdq && xQueueReceive(cmdq, &cmd_item, 0) == pdTRUE) {
                TdmaJobGroup group = cca_cmd_to_jobs(&cmd_item);
                if (group.phase_count > 0) {
                    if (!cca_tdma_submit_group(&group)) {
                        printf("[cca] TX engine full, command dropped\r\n");
                    }
                }
                else {
                    /* Unsupported command — fall back to blocking execute */
                    cca_cmd_execute(&cmd_item);
                }
            }
        }
```

Note: commands not yet ported to job builders (pairing, config, etc.) fall back to the existing blocking `cca_cmd_execute()`. This is intentional — we migrate commands incrementally.

- [ ] **Step 7: Verify compilation**

Run: `make -C firmware test`
Expected: All tests pass

Note: Full firmware compilation (`make -C firmware build`) requires the ARM toolchain and STM32 HAL. The host tests verify logic correctness; flash-and-test on hardware is the integration gate.

- [ ] **Step 8: Commit**

```bash
git add firmware/src/cca/cca_task.cpp
git commit -m "cca: wire job-based TX into task loop, remove immediate queue"
```

---

### Task 7: Run full CI suite and push

**Files:** None (verification only)

- [ ] **Step 1: Run all firmware checks**

```bash
make -C firmware test         # unit tests
make -C firmware format-check # clang-format
make -C firmware lint          # cppcheck
```

Expected: All pass with zero errors.

- [ ] **Step 2: Run TypeScript checks**

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # biome check
npm run test:ts      # node test runner
npm run codegen:check # codegen drift
```

Expected: All pass.

- [ ] **Step 3: Fix any issues surfaced by clang-format or cppcheck**

Run `make -C firmware format` if format-check fails. Fix any cppcheck findings.

- [ ] **Step 4: Push**

```bash
git push
```

Expected: Pre-push hook runs all 5 checks and passes. CI goes green.

---

## Migration Notes

Commands not yet ported to job builders will continue using blocking `cca_cmd_execute()`. These should be migrated incrementally in future work:

- `CCA_CMD_PICO_LEVEL` — needs `cca_jobs_pico_level` builder
- `CCA_CMD_VIVE_LEVEL` / `CCA_CMD_VIVE_DIM` — Vive-specific builders
- `CCA_CMD_PICO_PAIR` / `CCA_CMD_BRIDGE_PAIR` / `CCA_CMD_HYBRID_PAIR` — pairing builders (multi-phase)
- `CCA_CMD_LED_CONFIG` / `CCA_CMD_FADE_CONFIG` / `CCA_CMD_TRIM_CONFIG` — config builders
- `CCA_CMD_ANNOUNCE` — announce builder

Each migration follows the same pattern: write a `cca_jobs_*` builder, add it to the `cca_cmd_to_jobs` switch, add tests.
