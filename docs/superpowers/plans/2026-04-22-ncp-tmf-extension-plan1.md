# NCP TMF Extension — Plan 1 (NCP patch + standalone verification)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land a vendor Spinel extension to `ot-ncp-ftd` that exposes `otThreadSendDiagnosticGet/Reset` and the neighbor/child table iterators, rebuild the firmware for the Nucleo-soldered nRF52840, flash via DFU, and verify end-to-end with a standalone `tools/nrf-ncp-probe.ts` — all without touching the STM32 firmware.

**Architecture:** The extension patches OpenThread's `NcpBase` source directly (six new vendor properties at IDs `0x3C00–0x3C05`), registers an async callback for diagnostic-get responses, and emits streaming `PROP_INSERTED` frames. The STM32's existing `shell spinel raw <hex>` passthrough lets a TS probe talk Spinel directly to the NCP without any firmware changes on the host. Two DFU artifacts live in tree so rollback to the known-good firmware is one command.

**Tech Stack:** C++ (OpenThread / `ot-nrf528xx`), ARM GCC 15.2, CMake + Ninja, `nrfutil nrf5sdk-tools` for DFU, TypeScript (`tsx`) for probe/flash tooling, Node `node:test` for unit tests.

**Spec:** [`docs/superpowers/specs/2026-04-22-ncp-tmf-extension-design.md`](../specs/2026-04-22-ncp-tmf-extension-design.md)

---

## Orientation for the executor

- Working worktree: `/Users/alex/lutron-tools/.claude/worktrees/pedantic-johnson-77c037` on branch `claude/pedantic-johnson-77c037`. Run all `git` / `npm` commands from there. If the Bash tool resets `cwd` to a stale path, `cd` explicitly.
- OT source clone lives at `build/ot-nrf528xx` (created by `tools/nrf-ncp/build.sh` on first run). Edits inside this clone are **discarded** by `build.sh` (`git checkout -- .` at the top). All source modifications live in the patch files at `tools/nrf-ncp/*.patch`.
- Hardware: Nucleo with soldered nRF52840, reachable via ST-LINK USB (for STM32 flash/monitor) AND via a second USB cable to the nRF dongle bootloader (for NCP DFU). User puts the dongle in DFU mode by pressing its reset button.
- **Never use `st-flash`.** STM32 programming uses `cd firmware && make flash` (OpenOCD + ST-LINK). The NCP uses `nrfutil` DFU only.
- TS test runner: `npm run test:ts` = `node --import tsx --test test/**/*.test.ts`. Node `node:test` + `node:assert/strict`.
- Lint + format: `npm run lint:fix`. Typecheck: `npm run typecheck`.
- The STM32 firmware is already flashed with the enriched `[coap]` broadcast code from Phase B predecessor (commit `d08cbde`). Plan 1 does not touch STM32 source.

---

## Phase 1 — Ground-truth the OT source

**Purpose:** Confirm the exact OT version our build pulls, locate the NcpBase dispatch table, the async-property-emission API, the constructor hook, and the timer primitive. These assumptions are spec-critical; if any is wrong, we stop and re-design before writing code.

### Task 1.1: Clone `ot-nrf528xx` and pin the commit

**Files:**
- Create: `tools/nrf-ncp/tmf-ext-notes.md`

- [ ] **Step 1: Run build.sh up to the clone/submodule step**

The first run of `build.sh` clones `ot-nrf528xx` into `build/ot-nrf528xx`. Run it, but when it reaches the `./script/build` step let it complete the build (we need the known-good baseline binary anyway for Phase 9 rollback comparison).

Run: `cd /Users/alex/lutron-tools/.claude/worktrees/pedantic-johnson-77c037 && tools/nrf-ncp/build.sh`

Expected: clones `ot-nrf528xx` into `build/ot-nrf528xx`, applies `nucleo-uart.patch`, builds firmware, packages DFU zip to `build/ot-ncp-ftd-nucleo.zip`. Takes 3–8 minutes.

If the build fails, **stop and debug the baseline build before going further**. The rest of this plan assumes the baseline works.

- [ ] **Step 2: Record OT commit pin**

```bash
cd build/ot-nrf528xx
echo "ot-nrf528xx HEAD: $(git rev-parse HEAD)"
cd third_party/openthread/repo 2>/dev/null || cd openthread 2>/dev/null || pwd
echo "openthread HEAD: $(git rev-parse HEAD)"
```

Write both hashes into `tools/nrf-ncp/tmf-ext-notes.md` as the pinned state for this plan's patch. Format:

```markdown
# TMF Extension — Source Investigation Notes

## Pinned revisions

- `ot-nrf528xx`: <hash>
- `openthread` (submodule): <hash>
- Pinned on: 2026-04-22

All `ncp_base.hpp` / `ncp_base.cpp` line numbers in this document refer to these revisions.
```

- [ ] **Step 3: Commit the notes file (empty template for now)**

```bash
cd /Users/alex/lutron-tools/.claude/worktrees/pedantic-johnson-77c037
git add tools/nrf-ncp/tmf-ext-notes.md
git commit -m "docs(nrf-ncp): seed tmf-ext-notes with OT commit pin"
```

### Task 1.2: Locate the NcpBase property dispatch table

**Files:**
- Modify: `tools/nrf-ncp/tmf-ext-notes.md`

- [ ] **Step 1: Find the property handler dispatch**

Run:

```bash
cd /Users/alex/lutron-tools/.claude/worktrees/pedantic-johnson-77c037/build/ot-nrf528xx
grep -rn "sHandlerEntry\|kPropertyHandlerTable\|HandlerEntry.*kPropertyHandler" openthread 2>/dev/null | head -20
```

Expected: a table or array in `ncp_base.cpp` (or a companion file) mapping property IDs to handler pointers. Shape is usually:

```cpp
const NcpBase::PropertyHandlerEntry NcpBase::sHandlerEntry[] = {
    {SPINEL_PROP_*, &NcpBase::HandlePropertyGet*, &NcpBase::HandlePropertySet*, ...},
    ...
};
```

If the dispatch mechanism is instead macro-driven (`OT_DEFINE_SPINEL_PROP_HANDLER`), search for that:

```bash
grep -rn "OT_DEFINE_SPINEL_PROP_HANDLER\|SPINEL_PROP_HANDLER" openthread | head -10
```

- [ ] **Step 2: Find `NcpBase` constructor and init path**

Run:

```bash
grep -n "^NcpBase::NcpBase\|^NcpBase::Init\|void NcpBase::Init" openthread/src/ncp/ncp_base.cpp
```

We need a location in the constructor (or `NcpInit()`) where we can safely call `NcpTmfExtensionInit(this)` — after OT is instantiated but before the Spinel loop starts.

- [ ] **Step 3: Find the async-property-emission API**

We need to emit `PROP_INSERTED` frames from a callback context. Candidates in OT:

```bash
grep -n "WritePropertyValueIsFrame\|WritePropertyValueInsertedFrame\|SendPropertyUpdate\|HandleStreamMcpsOutput" openthread/src/ncp/ncp_base.cpp | head -20
```

Expected: something like `NcpBase::WritePropertyValueIsFrame(uint8_t aHeader, spinel_prop_key_t aKey, ...)` or a `SendPropertyUpdate()` method. Note the signature exactly.

- [ ] **Step 4: Find the timer primitive**

We need a 5-second timer inside the extension. OT has multiple options (`otTimer*`, `otPlatAlarmMilli*`, `TimerMilli` class). Find the one NcpBase itself uses:

```bash
grep -n "TimerMilli\|otPlatAlarmMilliStartAt\|otTimer" openthread/src/ncp/ncp_base.cpp openthread/src/ncp/ncp_base.hpp | head -20
```

- [ ] **Step 5: Find `otThreadSendDiagnosticGet` + callback API**

Verify the OT diagnostic-get API shape we assumed:

```bash
grep -n "otThreadSendDiagnosticGet\|otThreadSendDiagnosticReset\|otThreadSetReceiveDiagnosticGetCallback\|otReceiveDiagnosticGetCallback" openthread/include/openthread/thread.h openthread/include/openthread/netdiag.h 2>/dev/null | head -20
```

Expected signatures (per the spec):

```c
otError otThreadSendDiagnosticGet(otInstance *aInstance,
                                  const otIp6Address *aDestination,
                                  const uint8_t aTlvTypes[],
                                  uint8_t aCount);

typedef void (*otReceiveDiagnosticGetCallback)(otError aError,
                                               otMessage *aMessage,
                                               const otMessageInfo *aMessageInfo,
                                               void *aContext);

void otThreadSetReceiveDiagnosticGetCallback(otInstance *aInstance,
                                              otReceiveDiagnosticGetCallback aCallback,
                                              void *aCallbackContext);
```

If any signature differs, **update the spec and this plan before proceeding**.

- [ ] **Step 6: Write findings to `tmf-ext-notes.md` and commit**

Extend the notes file with exact file paths, line numbers, function signatures, and the chosen async-emission + timer API names. This is the ground truth subsequent tasks will reference.

Minimum notes template:

```markdown
## Hook points (pinned revisions)

### Property dispatch
- Table: `openthread/src/ncp/ncp_base.cpp:<LINE>` (`<TABLE_NAME>`)
- Entry shape: `{PROP_ID, GetHandler, SetHandler, InsertHandler, RemoveHandler}`

### Constructor init hook
- `openthread/src/ncp/ncp_base.cpp:<LINE>` — `NcpBase::NcpBase()` last statement

### Async property emission
- API: `NcpBase::<MethodName>(<signature>)`
- Location: `openthread/src/ncp/ncp_base.cpp:<LINE>`

### Timer
- API: `<class/function>` at `<file>:<line>`

### Diagnostic get
- `otThreadSendDiagnosticGet`: `openthread/include/openthread/netdiag.h:<LINE>`, signature matches spec ✓/✗
- Callback type: `otReceiveDiagnosticGetCallback`, signature matches spec ✓/✗
```

Commit:

```bash
cd /Users/alex/lutron-tools/.claude/worktrees/pedantic-johnson-77c037
git add tools/nrf-ncp/tmf-ext-notes.md
git commit -m "docs(nrf-ncp): record NcpBase hook points and OT diag-get API shape"
```

---

## Phase 2 — Write TMF extension source in OT clone

**Purpose:** Implement the six property handlers + callback + timer. Work directly inside `build/ot-nrf528xx/openthread/src/ncp/` (the clone). Nothing committed to OT — the patch is generated in Phase 4 via `git diff`.

### Task 2.1: Create `ncp_tmf_ext.hpp`

**Files:**
- Create: `build/ot-nrf528xx/openthread/src/ncp/ncp_tmf_ext.hpp`

- [ ] **Step 1: Write the header**

```cpp
/*
 * Lutron vendor Spinel extension — TMF toolkit.
 *
 * Exposes otThreadSendDiagnosticGet/Reset and the neighbor/child-table
 * iterators via six vendor properties at IDs 0x3C00..0x3C05. See:
 *   docs/superpowers/specs/2026-04-22-ncp-tmf-extension-design.md
 */
#ifndef NCP_TMF_EXT_HPP_
#define NCP_TMF_EXT_HPP_

#include <openthread/instance.h>
#include <openthread/ip6.h>
#include <openthread/message.h>
#include "common/timer.hpp"
#include "lib/spinel/spinel.h"

// Vendor property IDs. OpenThread reserves 0x3C00..0x3FFF for vendors.
#define SPINEL_PROP_VENDOR_DIAG_GET_REQUEST  ((spinel_prop_key_t)0x3C00)
#define SPINEL_PROP_VENDOR_DIAG_GET_RESPONSE ((spinel_prop_key_t)0x3C01)
#define SPINEL_PROP_VENDOR_DIAG_GET_DONE     ((spinel_prop_key_t)0x3C02)
#define SPINEL_PROP_VENDOR_DIAG_RESET_REQUEST ((spinel_prop_key_t)0x3C03)
#define SPINEL_PROP_VENDOR_NEIGHBOR_TABLE    ((spinel_prop_key_t)0x3C04)
#define SPINEL_PROP_VENDOR_CHILD_TABLE       ((spinel_prop_key_t)0x3C05)

// Max diag TLV types per request.
#define TMF_EXT_MAX_TLV_TYPES 32

// Completion timer window for DIAG_GET (ms).
#define TMF_EXT_DIAG_GET_TIMEOUT_MS 5000

namespace ot {
namespace Ncp {

class NcpBase;  // forward decl

class NcpTmfExtension
{
public:
    explicit NcpTmfExtension(NcpBase &aNcpBase);

    // Property handlers — registered by NcpBase patch.
    otError HandleSetDiagGetRequest(const uint8_t *aArg, uint16_t aLen);
    otError HandleSetDiagResetRequest(const uint8_t *aArg, uint16_t aLen);
    otError HandleGetNeighborTable(uint8_t *aOut, uint16_t aCap, uint16_t &aLenOut);
    otError HandleGetChildTable(uint8_t *aOut, uint16_t aCap, uint16_t &aLenOut);

private:
    static void HandleDiagGetResponseTrampoline(otError              aError,
                                                otMessage *          aMessage,
                                                const otMessageInfo *aMessageInfo,
                                                void *               aContext);
    void HandleDiagGetResponse(otError aError, otMessage *aMessage, const otMessageInfo *aMessageInfo);

    static void HandleTimerTrampoline(Timer &aTimer);
    void HandleTimer(void);

    NcpBase &       mNcpBase;
    bool            mInFlight;
    uint16_t        mResponderCount;
    TimerMilli      mTimer;
};

} // namespace Ncp
} // namespace ot

// C-linkage init called from NcpBase constructor (patch).
extern "C" void NcpTmfExtensionInit(ot::Ncp::NcpBase *aNcpBase);

#endif // NCP_TMF_EXT_HPP_
```

> **NOTE TO EXECUTOR:** The exact includes / forward decl / timer base class depend on what Phase 1 Task 1.2 Step 4 revealed. If OT's NcpBase uses a different timer primitive (e.g., `otPlatAlarm*` instead of `TimerMilli`), adjust the `TimerMilli mTimer` member and the `HandleTimerTrampoline` signature to match. Reference the notes file.

### Task 2.2: Create `ncp_tmf_ext.cpp` skeleton

**Files:**
- Create: `build/ot-nrf528xx/openthread/src/ncp/ncp_tmf_ext.cpp`

- [ ] **Step 1: Write the skeleton with init + state**

```cpp
/*
 * Lutron vendor Spinel extension — TMF toolkit.
 * See ncp_tmf_ext.hpp and the design spec for protocol details.
 */
#include "ncp_tmf_ext.hpp"

#include <string.h>

#include <openthread/link.h>
#include <openthread/thread.h>
#include <openthread/thread_ftd.h>
#include <openthread/netdiag.h>

#include "common/code_utils.hpp"
#include "common/encoding.hpp"
#include "ncp/ncp_base.hpp"

namespace ot {
namespace Ncp {

static NcpTmfExtension *sInstance = nullptr;

NcpTmfExtension::NcpTmfExtension(NcpBase &aNcpBase)
    : mNcpBase(aNcpBase)
    , mInFlight(false)
    , mResponderCount(0)
    , mTimer(aNcpBase.GetInstance(), NcpTmfExtension::HandleTimerTrampoline)
{
    sInstance = this;

    // Register the diag-get callback once. Context = this.
    otThreadSetReceiveDiagnosticGetCallback(aNcpBase.GetInstance(),
                                            &NcpTmfExtension::HandleDiagGetResponseTrampoline,
                                            this);
}

// --- Trampolines (C-callback → method) ---------------------------------

void NcpTmfExtension::HandleDiagGetResponseTrampoline(otError              aError,
                                                      otMessage *          aMessage,
                                                      const otMessageInfo *aMessageInfo,
                                                      void *               aContext)
{
    static_cast<NcpTmfExtension *>(aContext)->HandleDiagGetResponse(aError, aMessage, aMessageInfo);
}

void NcpTmfExtension::HandleTimerTrampoline(Timer &aTimer)
{
    OT_UNUSED_VARIABLE(aTimer);
    if (sInstance != nullptr) sInstance->HandleTimer();
}

// --- Handlers (method stubs, filled in by later tasks) ------------------

otError NcpTmfExtension::HandleSetDiagGetRequest(const uint8_t *aArg, uint16_t aLen) { OT_UNUSED_VARIABLE(aArg); OT_UNUSED_VARIABLE(aLen); return OT_ERROR_NOT_IMPLEMENTED; }
otError NcpTmfExtension::HandleSetDiagResetRequest(const uint8_t *aArg, uint16_t aLen) { OT_UNUSED_VARIABLE(aArg); OT_UNUSED_VARIABLE(aLen); return OT_ERROR_NOT_IMPLEMENTED; }
otError NcpTmfExtension::HandleGetNeighborTable(uint8_t *aOut, uint16_t aCap, uint16_t &aLenOut) { OT_UNUSED_VARIABLE(aOut); OT_UNUSED_VARIABLE(aCap); aLenOut = 0; return OT_ERROR_NOT_IMPLEMENTED; }
otError NcpTmfExtension::HandleGetChildTable(uint8_t *aOut, uint16_t aCap, uint16_t &aLenOut) { OT_UNUSED_VARIABLE(aOut); OT_UNUSED_VARIABLE(aCap); aLenOut = 0; return OT_ERROR_NOT_IMPLEMENTED; }

void NcpTmfExtension::HandleDiagGetResponse(otError aError, otMessage *aMessage, const otMessageInfo *aMessageInfo)
{
    OT_UNUSED_VARIABLE(aError);
    OT_UNUSED_VARIABLE(aMessage);
    OT_UNUSED_VARIABLE(aMessageInfo);
    // Filled in by Task 2.7
}

void NcpTmfExtension::HandleTimer(void)
{
    // Filled in by Task 2.8
}

} // namespace Ncp
} // namespace ot

// --- C init called from NcpBase patch ----------------------------------

extern "C" void NcpTmfExtensionInit(ot::Ncp::NcpBase *aNcpBase)
{
    static uint8_t sStorage[sizeof(ot::Ncp::NcpTmfExtension)];
    new (sStorage) ot::Ncp::NcpTmfExtension(*aNcpBase);
}
```

### Task 2.3: Implement `VENDOR_NEIGHBOR_TABLE` handler

This is the simplest property (synchronous, local-only). Implementing it first proves the dispatch + emission path works before we tackle async responses.

**Files:**
- Modify: `build/ot-nrf528xx/openthread/src/ncp/ncp_tmf_ext.cpp`

- [ ] **Step 1: Replace the stub with real body**

Replace:

```cpp
otError NcpTmfExtension::HandleGetNeighborTable(uint8_t *aOut, uint16_t aCap, uint16_t &aLenOut) { OT_UNUSED_VARIABLE(aOut); OT_UNUSED_VARIABLE(aCap); aLenOut = 0; return OT_ERROR_NOT_IMPLEMENTED; }
```

With:

```cpp
otError NcpTmfExtension::HandleGetNeighborTable(uint8_t *aOut, uint16_t aCap, uint16_t &aLenOut)
{
    // Serialize: [count:1][entries:17*count]
    // Each entry: [ext_addr:8][rloc16:2 LE][age_s:4 LE][avg_rssi:1][last_rssi:1][mode_flags:1]
    if (aCap < 1) return OT_ERROR_NO_BUFS;

    uint16_t pos = 1; // leave byte 0 for count
    uint8_t  count = 0;

    otNeighborInfoIterator iter = OT_NEIGHBOR_INFO_ITERATOR_INIT;
    otNeighborInfo         info;

    while (otThreadGetNextNeighborInfo(mNcpBase.GetInstance(), &iter, &info) == OT_ERROR_NONE)
    {
        if (pos + 17 > aCap) return OT_ERROR_NO_BUFS;

        memcpy(&aOut[pos], info.mExtAddress.m8, 8);
        pos += 8;
        aOut[pos++] = (uint8_t)(info.mRloc16 & 0xFF);
        aOut[pos++] = (uint8_t)((info.mRloc16 >> 8) & 0xFF);
        aOut[pos++] = (uint8_t)(info.mAge & 0xFF);
        aOut[pos++] = (uint8_t)((info.mAge >> 8) & 0xFF);
        aOut[pos++] = (uint8_t)((info.mAge >> 16) & 0xFF);
        aOut[pos++] = (uint8_t)((info.mAge >> 24) & 0xFF);
        aOut[pos++] = (uint8_t)info.mAverageRssi;
        aOut[pos++] = (uint8_t)info.mLastRssi;

        uint8_t flags = 0;
        if (info.mIsChild)           flags |= 0x01;
        if (info.mRxOnWhenIdle)      flags |= 0x02;
        if (info.mFullThreadDevice)  flags |= 0x04;
        if (info.mSecureDataRequest) flags |= 0x08;
        if (info.mFullNetworkData)   flags |= 0x10;
        aOut[pos++] = flags;

        count++;
        if (count == 0xFF) break;
    }

    aOut[0] = count;
    aLenOut = pos;
    return OT_ERROR_NONE;
}
```

### Task 2.4: Implement `VENDOR_CHILD_TABLE` handler

**Files:**
- Modify: `build/ot-nrf528xx/openthread/src/ncp/ncp_tmf_ext.cpp`

- [ ] **Step 1: Replace the child-table stub**

Replace:

```cpp
otError NcpTmfExtension::HandleGetChildTable(uint8_t *aOut, uint16_t aCap, uint16_t &aLenOut) { OT_UNUSED_VARIABLE(aOut); OT_UNUSED_VARIABLE(aCap); aLenOut = 0; return OT_ERROR_NOT_IMPLEMENTED; }
```

With:

```cpp
otError NcpTmfExtension::HandleGetChildTable(uint8_t *aOut, uint16_t aCap, uint16_t &aLenOut)
{
    // Serialize: [count:1][entries:21*count]
    // Each entry: [ext_addr:8][rloc16:2 LE][timeout_s:4 LE][age_s:4 LE][avg_rssi:1][last_rssi:1][mode_flags:1]
    if (aCap < 1) return OT_ERROR_NO_BUFS;

    uint16_t    pos   = 1;
    uint8_t     count = 0;
    otChildInfo info;

    for (uint16_t i = 0; ; i++)
    {
        if (otThreadGetChildInfoByIndex(mNcpBase.GetInstance(), i, &info) != OT_ERROR_NONE) break;
        if (info.mRloc16 == 0xFFFE) continue; // invalid slot
        if (pos + 21 > aCap) return OT_ERROR_NO_BUFS;

        memcpy(&aOut[pos], info.mExtAddress.m8, 8);
        pos += 8;
        aOut[pos++] = (uint8_t)(info.mRloc16 & 0xFF);
        aOut[pos++] = (uint8_t)((info.mRloc16 >> 8) & 0xFF);
        aOut[pos++] = (uint8_t)(info.mTimeout & 0xFF);
        aOut[pos++] = (uint8_t)((info.mTimeout >> 8) & 0xFF);
        aOut[pos++] = (uint8_t)((info.mTimeout >> 16) & 0xFF);
        aOut[pos++] = (uint8_t)((info.mTimeout >> 24) & 0xFF);
        aOut[pos++] = (uint8_t)(info.mAge & 0xFF);
        aOut[pos++] = (uint8_t)((info.mAge >> 8) & 0xFF);
        aOut[pos++] = (uint8_t)((info.mAge >> 16) & 0xFF);
        aOut[pos++] = (uint8_t)((info.mAge >> 24) & 0xFF);
        aOut[pos++] = (uint8_t)info.mAverageRssi;
        aOut[pos++] = (uint8_t)info.mLastRssi;

        uint8_t flags = 0;
        if (info.mRxOnWhenIdle)      flags |= 0x02;
        if (info.mFullThreadDevice)  flags |= 0x04;
        if (info.mSecureDataRequest) flags |= 0x08;
        if (info.mFullNetworkData)   flags |= 0x10;
        aOut[pos++] = flags;

        count++;
        if (count == 0xFF) break;
    }

    aOut[0] = count;
    aLenOut = pos;
    return OT_ERROR_NONE;
}
```

### Task 2.5: Implement `VENDOR_DIAG_RESET_REQUEST` handler

**Files:**
- Modify: `build/ot-nrf528xx/openthread/src/ncp/ncp_tmf_ext.cpp`

- [ ] **Step 1: Replace the diag-reset stub**

Replace:

```cpp
otError NcpTmfExtension::HandleSetDiagResetRequest(const uint8_t *aArg, uint16_t aLen) { OT_UNUSED_VARIABLE(aArg); OT_UNUSED_VARIABLE(aLen); return OT_ERROR_NOT_IMPLEMENTED; }
```

With:

```cpp
otError NcpTmfExtension::HandleSetDiagResetRequest(const uint8_t *aArg, uint16_t aLen)
{
    // Payload: [dst_addr:16][tlv_count:1][tlv_types:tlv_count]
    if (aLen < 17) return OT_ERROR_PARSE;

    otIp6Address dst;
    memcpy(dst.mFields.m8, aArg, 16);

    uint8_t tlvCount = aArg[16];
    if (tlvCount == 0 || tlvCount > TMF_EXT_MAX_TLV_TYPES) return OT_ERROR_PARSE;
    if (aLen != 17u + tlvCount) return OT_ERROR_PARSE;

    return otThreadSendDiagnosticReset(mNcpBase.GetInstance(), &dst, &aArg[17], tlvCount);
}
```

### Task 2.6: Implement `VENDOR_DIAG_GET_REQUEST` handler

**Files:**
- Modify: `build/ot-nrf528xx/openthread/src/ncp/ncp_tmf_ext.cpp`

- [ ] **Step 1: Replace the diag-get stub**

Replace:

```cpp
otError NcpTmfExtension::HandleSetDiagGetRequest(const uint8_t *aArg, uint16_t aLen) { OT_UNUSED_VARIABLE(aArg); OT_UNUSED_VARIABLE(aLen); return OT_ERROR_NOT_IMPLEMENTED; }
```

With:

```cpp
otError NcpTmfExtension::HandleSetDiagGetRequest(const uint8_t *aArg, uint16_t aLen)
{
    if (mInFlight) return OT_ERROR_BUSY;

    // Payload: [dst_addr:16][tlv_count:1][tlv_types:tlv_count]
    if (aLen < 17) return OT_ERROR_PARSE;

    otIp6Address dst;
    memcpy(dst.mFields.m8, aArg, 16);

    uint8_t tlvCount = aArg[16];
    if (tlvCount == 0 || tlvCount > TMF_EXT_MAX_TLV_TYPES) return OT_ERROR_PARSE;
    if (aLen != 17u + tlvCount) return OT_ERROR_PARSE;

    otError err = otThreadSendDiagnosticGet(mNcpBase.GetInstance(), &dst, &aArg[17], tlvCount);
    if (err != OT_ERROR_NONE) return err;

    mInFlight       = true;
    mResponderCount = 0;
    mTimer.Start(TMF_EXT_DIAG_GET_TIMEOUT_MS);

    return OT_ERROR_NONE;
}
```

### Task 2.7: Implement the diag-get response emitter

**Files:**
- Modify: `build/ot-nrf528xx/openthread/src/ncp/ncp_tmf_ext.cpp`

- [ ] **Step 1: Replace `HandleDiagGetResponse` stub with the real body**

Replace the stub with:

```cpp
void NcpTmfExtension::HandleDiagGetResponse(otError aError, otMessage *aMessage, const otMessageInfo *aMessageInfo)
{
    if (aError != OT_ERROR_NONE || aMessage == nullptr || aMessageInfo == nullptr) return;

    // Read the full TLV blob out of the message.
    uint16_t offset  = otMessageGetOffset(aMessage);
    uint16_t msgLen  = otMessageGetLength(aMessage);
    uint16_t tlvLen  = (msgLen > offset) ? (msgLen - offset) : 0;

    // Build frame payload: [src_addr:16][tlv_len:2 LE][tlv_payload:tlv_len]
    // Size upper bound: 16 + 2 + 255 = 273. Cap at Spinel practical frame limit.
    static const uint16_t kMaxPayload = 320;
    uint8_t  buf[kMaxPayload];
    uint16_t pos = 0;

    memcpy(&buf[pos], aMessageInfo->mPeerAddr.mFields.m8, 16);
    pos += 16;

    // If we can't fit the whole thing, set the high bit of tlv_len as "truncated" flag.
    uint16_t room = (uint16_t)(kMaxPayload - pos - 2);
    bool     trunc = false;
    uint16_t emit  = tlvLen;
    if (emit > room) { emit = room; trunc = true; }

    uint16_t encoded_len = emit | (trunc ? 0x8000u : 0u);
    buf[pos++] = (uint8_t)(encoded_len & 0xFF);
    buf[pos++] = (uint8_t)((encoded_len >> 8) & 0xFF);

    otMessageRead(aMessage, offset, &buf[pos], emit);
    pos += emit;

    // Emit as PROP_INSERTED. The exact NcpBase method comes from Phase 1 notes;
    // below is a placeholder call — replace with the correct method name the
    // notes file records (e.g. WritePropertyValueIsFrame with cmd=VALUE_INSERTED).
    mNcpBase.WriteVendorPropFrame(SPINEL_PROP_VENDOR_DIAG_GET_RESPONSE, buf, pos);

    mResponderCount++;
}
```

> **NOTE TO EXECUTOR:** `WriteVendorPropFrame` is a placeholder name. In Task 3.1 you will add a matching method to `NcpBase` (or use whatever method the Phase-1 notes identified), whose body wraps OT's real async-emission API. Keep this call shape symmetric with what's added in Task 3.1.

### Task 2.8: Implement the completion timer

**Files:**
- Modify: `build/ot-nrf528xx/openthread/src/ncp/ncp_tmf_ext.cpp`

- [ ] **Step 1: Replace `HandleTimer` stub**

Replace:

```cpp
void NcpTmfExtension::HandleTimer(void)
{
    // Filled in by Task 2.8
}
```

With:

```cpp
void NcpTmfExtension::HandleTimer(void)
{
    // Emit VENDOR_DIAG_GET_DONE: [reason:1][responder_count:2 LE]
    uint8_t buf[3];
    buf[0] = 0; // reason = 0 (timer elapsed, normal completion)
    buf[1] = (uint8_t)(mResponderCount & 0xFF);
    buf[2] = (uint8_t)((mResponderCount >> 8) & 0xFF);

    mNcpBase.WriteVendorPropFrame(SPINEL_PROP_VENDOR_DIAG_GET_DONE, buf, sizeof(buf));

    mInFlight = false;
}
```

---

## Phase 3 — Patch OT's `NcpBase`

**Purpose:** Wire the extension into OT's property dispatch table and constructor. This is the invasive part — minimise the footprint to keep `git apply` resilient against OT upstream changes.

### Task 3.1: Modify `ncp_base.hpp` — declare extension glue

**Files:**
- Modify: `build/ot-nrf528xx/openthread/src/ncp/ncp_base.hpp`

- [ ] **Step 1: Add glue declarations inside the `NcpBase` class body**

Locate the public section of `class NcpBase` (public: block), add at the end:

```cpp
    // --- Lutron TMF extension glue ---
    void    WriteVendorPropFrame(spinel_prop_key_t aKey, const uint8_t *aBuf, uint16_t aLen);
    otError HandleVendorPropGet(spinel_prop_key_t aKey, uint8_t *aOut, uint16_t aCap, uint16_t &aLenOut);
    otError HandleVendorPropSet(spinel_prop_key_t aKey, const uint8_t *aArg, uint16_t aLen);
```

### Task 3.2: Modify `ncp_base.cpp` — dispatch + emission + constructor

**Files:**
- Modify: `build/ot-nrf528xx/openthread/src/ncp/ncp_base.cpp`

- [ ] **Step 1: Add `#include "ncp_tmf_ext.hpp"` at the top of the file, with the other `"ncp_*"` includes.**

- [ ] **Step 2: Implement `WriteVendorPropFrame`**

Add at the end of `ncp_base.cpp` (inside `namespace ot::Ncp` block):

```cpp
void NcpBase::WriteVendorPropFrame(spinel_prop_key_t aKey, const uint8_t *aBuf, uint16_t aLen)
{
    // Use the same async emission path OT uses for its own PROP_INSERTED frames.
    // <EXECUTOR: replace the body with the method call recorded in Phase 1 notes.
    //  Example placeholder using a hypothetical WritePropertyFrame():>
    WritePropertyFrame(SPINEL_HEADER_FLAG | SPINEL_HEADER_IID(0),
                       SPINEL_CMD_PROP_VALUE_INSERTED, aKey, aBuf, aLen);
}
```

> **NOTE TO EXECUTOR:** The exact method name comes from Phase 1 Task 1.2 Step 3. Substitute it here. If no single-call emission API exists, use the two-step `mEncoder.BeginFrame` / `mEncoder.WriteData` / `mEncoder.EndFrame` pattern shown in `ncp_base.cpp` for other async properties (e.g. `STREAM_NET` emission).

- [ ] **Step 3: Implement `HandleVendorPropGet`**

Add below `WriteVendorPropFrame`:

```cpp
otError NcpBase::HandleVendorPropGet(spinel_prop_key_t aKey, uint8_t *aOut, uint16_t aCap, uint16_t &aLenOut)
{
    extern ot::Ncp::NcpTmfExtension *gNcpTmfExt; // defined in ncp_tmf_ext.cpp (init)

    switch (aKey)
    {
    case SPINEL_PROP_VENDOR_NEIGHBOR_TABLE:
        return gNcpTmfExt->HandleGetNeighborTable(aOut, aCap, aLenOut);
    case SPINEL_PROP_VENDOR_CHILD_TABLE:
        return gNcpTmfExt->HandleGetChildTable(aOut, aCap, aLenOut);
    default:
        aLenOut = 0;
        return OT_ERROR_NOT_FOUND;
    }
}
```

And in `ncp_tmf_ext.cpp`, replace the static `sInstance` with a public `gNcpTmfExt`:

```cpp
// at file scope, replacing `static NcpTmfExtension *sInstance = nullptr;`
ot::Ncp::NcpTmfExtension *gNcpTmfExt = nullptr;
```

Update the `HandleTimerTrampoline` to use `gNcpTmfExt` and the ctor to assign it.

- [ ] **Step 4: Implement `HandleVendorPropSet`**

```cpp
otError NcpBase::HandleVendorPropSet(spinel_prop_key_t aKey, const uint8_t *aArg, uint16_t aLen)
{
    extern ot::Ncp::NcpTmfExtension *gNcpTmfExt;

    switch (aKey)
    {
    case SPINEL_PROP_VENDOR_DIAG_GET_REQUEST:
        return gNcpTmfExt->HandleSetDiagGetRequest(aArg, aLen);
    case SPINEL_PROP_VENDOR_DIAG_RESET_REQUEST:
        return gNcpTmfExt->HandleSetDiagResetRequest(aArg, aLen);
    default:
        return OT_ERROR_NOT_FOUND;
    }
}
```

- [ ] **Step 5: Register the vendor properties in the dispatch table**

Based on Phase 1 Task 1.2 Step 1, OT dispatches property requests via either a table (`sHandlerEntry[]`) or macro. Extend the dispatch to route property IDs `0x3C00..0x3C05` to `HandleVendorPropGet` / `HandleVendorPropSet`.

**If the dispatch is a table**, add entries referencing member functions of shape:

```cpp
{SPINEL_PROP_VENDOR_DIAG_GET_REQUEST,     nullptr, &NcpBase::HandleSpinelVendorDiagGetSet,  nullptr, nullptr},
{SPINEL_PROP_VENDOR_DIAG_RESET_REQUEST,   nullptr, &NcpBase::HandleSpinelVendorDiagResetSet, nullptr, nullptr},
{SPINEL_PROP_VENDOR_NEIGHBOR_TABLE,       &NcpBase::HandleSpinelVendorNeighborGet, nullptr, nullptr, nullptr},
{SPINEL_PROP_VENDOR_CHILD_TABLE,          &NcpBase::HandleSpinelVendorChildGet, nullptr, nullptr, nullptr},
```

plus small wrapper methods that forward to the `HandleVendorProp{Get,Set}` dispatcher. Check the exact handler signature in the real OT source.

**If the dispatch is macro-driven**, add `OT_DEFINE_SPINEL_PROP_HANDLER(...)` invocations at the bottom of `ncp_base.cpp`.

> **NOTE TO EXECUTOR:** This step is the one most likely to need adjustment. Phase 1 Task 1.2 Step 1 should have documented which style is in use — follow the notes.

- [ ] **Step 6: Call `NcpTmfExtensionInit` from the constructor**

In the body of `NcpBase::NcpBase(otInstance *aInstance)` (locate via Phase 1 Task 1.2 Step 2), add before the closing brace:

```cpp
    NcpTmfExtensionInit(this);
```

---

## Phase 4 — Generate the patch file

### Task 4.1: `git diff` to produce the patch

**Files:**
- Create: `tools/nrf-ncp/tmf-extension.patch`

- [ ] **Step 1: Stage nothing, diff everything**

```bash
cd /Users/alex/lutron-tools/.claude/worktrees/pedantic-johnson-77c037/build/ot-nrf528xx
# Diff only the openthread submodule (all our edits live there):
cd openthread  # adjust path if submodule root differs
git diff src/ncp/ > /Users/alex/lutron-tools/.claude/worktrees/pedantic-johnson-77c037/tools/nrf-ncp/tmf-extension.patch
ls src/ncp/ncp_tmf_ext.cpp src/ncp/ncp_tmf_ext.hpp  # confirm both new files exist
```

`git diff` alone omits untracked files. Include them explicitly:

```bash
# Inside openthread submodule:
git add -N src/ncp/ncp_tmf_ext.hpp src/ncp/ncp_tmf_ext.cpp  # intent-to-add so diff sees them
git diff src/ncp/ > /Users/alex/lutron-tools/.claude/worktrees/pedantic-johnson-77c037/tools/nrf-ncp/tmf-extension.patch
```

- [ ] **Step 2: Sanity check the patch**

```bash
cd /Users/alex/lutron-tools/.claude/worktrees/pedantic-johnson-77c037
head -30 tools/nrf-ncp/tmf-extension.patch
wc -l tools/nrf-ncp/tmf-extension.patch
```

Expected: a unified diff header (`diff --git a/src/ncp/...`), new-file markers for the two `.cpp`/`.hpp`, modification hunks for `ncp_base.{hpp,cpp}`. Total somewhere between 300 and 600 lines.

- [ ] **Step 3: Commit the patch**

```bash
git add tools/nrf-ncp/tmf-extension.patch
git commit -m "feat(nrf-ncp): tmf-extension patch — 6 vendor Spinel props for diag/neighbor/child"
```

---

## Phase 5 — Update `build.sh`

### Task 5.1: Apply both patches, rename outputs

**Files:**
- Modify: `tools/nrf-ncp/build.sh`

- [ ] **Step 1: Read current build.sh**

```bash
cat /Users/alex/lutron-tools/.claude/worktrees/pedantic-johnson-77c037/tools/nrf-ncp/build.sh
```

- [ ] **Step 2: Patch to apply both patches and rename outputs**

Apply this edit — add the TMF patch application after the existing nucleo-uart apply, and change the output filenames:

```bash
# Find the existing "git apply "$SCRIPT_DIR/nucleo-uart.patch"" line, add after it:
echo "==> Applying TMF extension patch..."
git apply "$SCRIPT_DIR/tmf-extension.patch"
```

And change the final DFU packaging step so the output is `ot-ncp-ftd-nucleo-tmf.zip` (search the file for the current `.zip` output name and suffix it with `-tmf`).

```bash
# Before:
# nrfutil nrf5sdk-tools pkg generate --hw-version 52 ... <existing>.zip
# After:
# nrfutil nrf5sdk-tools pkg generate --hw-version 52 ... ot-ncp-ftd-nucleo-tmf.zip
```

- [ ] **Step 3: Also emit the raw `.hex` alongside the `.zip`**

The build output already produces a `.hex`. Ensure the script copies it to the same output dir:

```bash
cp "$BUILD_DIR/build/bin/ot-ncp-ftd.hex" "$OUTPUT_DIR/ot-ncp-ftd-nucleo-tmf.hex"
```

(Adjust the source path to match the real build location.)

- [ ] **Step 4: Commit**

```bash
git add tools/nrf-ncp/build.sh
git commit -m "build(nrf-ncp): apply tmf-extension patch; rename outputs to -tmf suffix"
```

---

## Phase 6 — Build & capture artifacts

### Task 6.1: Run the full build

- [ ] **Step 1: Clean the OT clone to ensure patches apply from scratch**

```bash
cd /Users/alex/lutron-tools/.claude/worktrees/pedantic-johnson-77c037
rm -rf build/ot-nrf528xx
tools/nrf-ncp/build.sh
```

Expected: clone, both patches apply cleanly, compile succeeds, outputs `build/ot-ncp-ftd-nucleo-tmf.zip` and `build/ot-ncp-ftd-nucleo-tmf.hex`. Build time 3–8 minutes.

If a patch fails to apply, `build.sh` exits with `set -e`. To debug: re-run the `git apply --check tools/nrf-ncp/tmf-extension.patch` manually from inside the clone, fix the patch, commit, re-run.

If compile fails, read the error, fix the source in the clone directly, **regenerate the patch** (Phase 4 Task 4.1), commit, re-run.

- [ ] **Step 2: Copy artifacts into `firmware/ncp/` with the `-tmf` naming**

```bash
cd /Users/alex/lutron-tools/.claude/worktrees/pedantic-johnson-77c037
cp build/ot-ncp-ftd-nucleo-tmf.hex firmware/ncp/ot-ncp-ftd-tmf.hex
cp build/ot-ncp-ftd-nucleo-tmf.zip firmware/ncp/ot-ncp-ftd-tmf-dfu.zip
ls -l firmware/ncp/
```

Expected: four files present — the known-good pair (`ot-ncp-ftd.hex`, `ot-ncp-ftd-dfu.zip`) unchanged, plus the new `ot-ncp-ftd-tmf.hex`, `ot-ncp-ftd-tmf-dfu.zip`.

- [ ] **Step 3: Commit the new binaries**

```bash
git add firmware/ncp/ot-ncp-ftd-tmf.hex firmware/ncp/ot-ncp-ftd-tmf-dfu.zip
git commit -m "feat(firmware/ncp): add ot-ncp-ftd-tmf DFU artifacts"
```

---

## Phase 7 — `tools/nrf-dfu-flash.ts`

### Task 7.1: Scaffold + tests

**Files:**
- Create: `tools/nrf-dfu-flash.ts`
- Create: `test/nrf-dfu-flash.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/nrf-dfu-flash.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  chooseArtifact,
  detectNewUsbmodem,
  type UsbmodemSnapshot,
} from "../tools/nrf-dfu-flash";

test("chooseArtifact resolves --tmf to the -tmf-dfu.zip", () => {
  const path = chooseArtifact({ tmf: true, rollback: false });
  assert.ok(path.endsWith("/firmware/ncp/ot-ncp-ftd-tmf-dfu.zip"));
});

test("chooseArtifact resolves --rollback to the known-good dfu.zip", () => {
  const path = chooseArtifact({ tmf: false, rollback: true });
  assert.ok(path.endsWith("/firmware/ncp/ot-ncp-ftd-dfu.zip"));
});

test("chooseArtifact rejects zero or both flags", () => {
  assert.throws(() => chooseArtifact({ tmf: false, rollback: false }));
  assert.throws(() => chooseArtifact({ tmf: true, rollback: true }));
});

test("detectNewUsbmodem returns the new port that appeared after reset", () => {
  const before: UsbmodemSnapshot = ["/dev/tty.usbmodem101", "/dev/tty.usbmodem102"];
  const after: UsbmodemSnapshot  = ["/dev/tty.usbmodem101", "/dev/tty.usbmodem102", "/dev/tty.usbmodemDFU5"];
  assert.equal(detectNewUsbmodem(before, after), "/dev/tty.usbmodemDFU5");
});

test("detectNewUsbmodem returns undefined when no new port appeared", () => {
  const before: UsbmodemSnapshot = ["/dev/tty.usbmodem101"];
  const after: UsbmodemSnapshot  = ["/dev/tty.usbmodem101"];
  assert.equal(detectNewUsbmodem(before, after), undefined);
});
```

Run: `node --import tsx --test test/nrf-dfu-flash.test.ts`
Expected: MODULE_NOT_FOUND.

- [ ] **Step 2: Write the tool**

Create `tools/nrf-dfu-flash.ts`:

```ts
#!/usr/bin/env npx tsx

/**
 * nRF NCP DFU flash wrapper.
 *
 * Usage:
 *   npx tsx tools/nrf-dfu-flash.ts --tmf         # flash the TMF-extension build
 *   npx tsx tools/nrf-dfu-flash.ts --rollback    # reflash the known-good baseline
 *
 * Prompts the user to press the reset button on the Nucleo-soldered nRF52840
 * dongle, detects the new DFU serial port, and runs nrfutil. See
 * docs/superpowers/specs/2026-04-22-ncp-tmf-extension-design.md.
 */

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type UsbmodemSnapshot = readonly string[];

const __dir = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dir, "..");

export function chooseArtifact(flags: { tmf: boolean; rollback: boolean }): string {
  if (flags.tmf === flags.rollback) {
    throw new Error("Specify exactly one of --tmf or --rollback");
  }
  const name = flags.tmf ? "ot-ncp-ftd-tmf-dfu.zip" : "ot-ncp-ftd-dfu.zip";
  return join(REPO_ROOT, "firmware", "ncp", name);
}

export function snapshotUsbmodem(): UsbmodemSnapshot {
  try {
    return readdirSync("/dev")
      .filter((n) => n.startsWith("tty.usbmodem"))
      .map((n) => `/dev/${n}`);
  } catch {
    return [];
  }
}

export function detectNewUsbmodem(
  before: UsbmodemSnapshot,
  after: UsbmodemSnapshot,
): string | undefined {
  const beforeSet = new Set(before);
  return after.find((p) => !beforeSet.has(p));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const artifact = chooseArtifact({
    tmf: args.includes("--tmf"),
    rollback: args.includes("--rollback"),
  });

  console.log(`Artifact: ${artifact}`);

  const before = snapshotUsbmodem();
  console.log(`Ports before: ${before.join(", ") || "(none)"}`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question(
    "Press the RESET button on the dongle (LED pulses red in DFU mode), then press ENTER here: ",
  );
  rl.close();

  // Give the kernel a moment to re-enumerate USB.
  await new Promise((r) => setTimeout(r, 1500));

  const after = snapshotUsbmodem();
  console.log(`Ports after:  ${after.join(", ") || "(none)"}`);

  const port = detectNewUsbmodem(before, after);
  if (!port) {
    throw new Error(
      "No new usbmodem port appeared. Dongle may not be in DFU mode — re-press reset and retry.",
    );
  }
  console.log(`Detected DFU port: ${port}`);

  console.log(`Invoking nrfutil...`);
  try {
    execFileSync(
      "nrfutil",
      ["nrf5sdk-tools", "dfu", "usb-serial", "-pkg", artifact, "-p", port],
      { stdio: "inherit" },
    );
  } catch (err) {
    throw new Error(
      `nrfutil DFU failed: ${(err as Error).message}. If this was --tmf, consider running --rollback.`,
    );
  }

  console.log(`Done. Dongle should re-enumerate as a normal CDC port within a few seconds.`);
}

main().catch((err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});
```

- [ ] **Step 3: Run tests, typecheck, lint**

```bash
cd /Users/alex/lutron-tools/.claude/worktrees/pedantic-johnson-77c037
node --import tsx --test test/nrf-dfu-flash.test.ts
npm run typecheck
npm run lint
```

Expected: 5 tests pass, no type/lint errors.

- [ ] **Step 4: Commit**

```bash
git add tools/nrf-dfu-flash.ts test/nrf-dfu-flash.test.ts
git commit -m "feat(tools): nrf-dfu-flash — --tmf / --rollback DFU wrapper"
```

---

## Phase 8 — `tools/nrf-ncp-probe.ts`

**Purpose:** Self-contained Spinel client for Plan-1 verification. Builds frames, sends via the STM32's `shell spinel raw <hex>` passthrough on UDP `:9433`, parses responses. Uses only the TLV codec from `ccx/tmf-diag.ts` (already landed); all Spinel encoding is implemented in this file.

### Task 8.1: Spinel frame primitives + tests

**Files:**
- Create: `tools/nrf-ncp-probe.ts` (start of file with Spinel primitives)
- Create: `test/nrf-ncp-probe.test.ts`

- [ ] **Step 1: Write failing tests for frame construction**

Create `test/nrf-ncp-probe.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDiagGetRequest,
  buildPropGet,
  buildPropSet,
  decodeResponse,
  SPINEL_CMD_PROP_VALUE_INSERTED,
  SPINEL_PROP_VENDOR_DIAG_GET_REQUEST,
  SPINEL_PROP_VENDOR_DIAG_GET_RESPONSE,
  SPINEL_PROP_VENDOR_NEIGHBOR_TABLE,
  parseNeighborTable,
} from "../tools/nrf-ncp-probe";

test("buildPropGet emits [header][cmd][prop-encoded]", () => {
  const f = buildPropGet(0x81, SPINEL_PROP_VENDOR_NEIGHBOR_TABLE);
  // header=0x81, cmd=0x02 (PROP_VALUE_GET), prop=pack(0x3C04)
  assert.equal(f[0], 0x81);
  assert.equal(f[1], 0x02);
  // Vendor props >= 0x3C00 need 2-byte packed encoding per Spinel (high bit set on first)
  assert.ok(f.length >= 4);
});

test("buildPropSet emits [header][cmd][prop][value]", () => {
  const value = Buffer.from("deadbeef", "hex");
  const f = buildPropSet(0x81, SPINEL_PROP_VENDOR_DIAG_GET_REQUEST, value);
  assert.equal(f[0], 0x81);
  assert.equal(f[1], 0x03);
  assert.ok(f.length > 4 + value.length - 1);
});

test("buildDiagGetRequest packs [dst:16][count:1][types:N]", () => {
  const dst = Buffer.from("ff030000000000000000000000000001", "hex");
  const req = buildDiagGetRequest(dst, [0, 1, 8]);
  // value portion = 16 (addr) + 1 (count) + 3 (types) = 20
  // Full frame = header+cmd+propkey(>=2)+value
  assert.ok(req.length >= 2 + 2 + 20);
  const value = req.subarray(req.length - 20);
  assert.deepEqual(value.subarray(0, 16), dst);
  assert.equal(value[16], 3);
  assert.deepEqual(Array.from(value.subarray(17, 20)), [0, 1, 8]);
});

test("decodeResponse identifies PROP_VALUE_INSERTED(DIAG_GET_RESPONSE)", () => {
  // Synthetic response: header=0x81, cmd=0x06 (INSERTED), prop=0x3C01, value=…
  // (packed prop encoding used below for 0x3C01)
  const propBytes = Buffer.from([0xbc, 0x01]); // high-bit indicates extended prop; 0x3C01
  const value = Buffer.concat([
    Buffer.alloc(16, 0x22), // src_addr 22:22:…
    Buffer.from([0x08, 0x00]), // tlv_len = 8
    Buffer.from("0008e2798dfffe9285fe".slice(0, 16), "hex").subarray(0, 8),
  ]);
  const pkt = Buffer.concat([Buffer.from([0x81, SPINEL_CMD_PROP_VALUE_INSERTED]), propBytes, value]);

  const r = decodeResponse(pkt);
  assert.ok(r && r.kind === "insert");
  assert.equal(r.prop, SPINEL_PROP_VENDOR_DIAG_GET_RESPONSE);
  assert.equal(r.value.length, value.length);
});

test("parseNeighborTable deserializes count + fixed-size entries", () => {
  // count=1, one entry: ext=8, rloc16=0x4800 LE, age=0, rssi=-50/-45, flags=0x01
  const body = Buffer.concat([
    Buffer.from([0x01]), // count
    Buffer.from("e2798dfffe9285fe", "hex"),
    Buffer.from([0x00, 0x48, 0x00, 0x00, 0x00, 0x00]), // rloc16 LE + age_s LE
    Buffer.from([0xce, 0xd3, 0x01]), // avg -50, last -45, flags child
  ]);
  const entries = parseNeighborTable(body);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].rloc16, 0x4800);
  assert.equal(entries[0].ageSec, 0);
  assert.equal(entries[0].avgRssi, -50);
  assert.equal(entries[0].lastRssi, -45);
  assert.equal(entries[0].isChild, true);
});
```

Run: `node --import tsx --test test/nrf-ncp-probe.test.ts` → MODULE_NOT_FOUND.

- [ ] **Step 2: Write the Spinel + probe code**

Create `tools/nrf-ncp-probe.ts`:

```ts
#!/usr/bin/env npx tsx

/**
 * Standalone Spinel probe for Plan-1 verification of the NCP TMF vendor
 * extension. Builds raw Spinel frames, sends them via the STM32's
 * "shell spinel raw <hex>" passthrough on UDP :9433, parses responses.
 *
 * See docs/superpowers/specs/2026-04-22-ncp-tmf-extension-design.md.
 */

import { createSocket } from "node:dgram";
import { decodeDiagResponse } from "../ccx/tmf-diag";
import { config } from "../lib/config";

// --- Spinel constants ---

export const SPINEL_CMD_PROP_VALUE_GET      = 0x02;
export const SPINEL_CMD_PROP_VALUE_SET      = 0x03;
export const SPINEL_CMD_PROP_VALUE_IS       = 0x06;
export const SPINEL_CMD_PROP_VALUE_INSERTED = 0x05;
export const SPINEL_CMD_PROP_VALUE_REMOVED  = 0x08;

export const SPINEL_PROP_LAST_STATUS                = 0x0000;
export const SPINEL_PROP_VENDOR_DIAG_GET_REQUEST    = 0x3C00;
export const SPINEL_PROP_VENDOR_DIAG_GET_RESPONSE   = 0x3C01;
export const SPINEL_PROP_VENDOR_DIAG_GET_DONE       = 0x3C02;
export const SPINEL_PROP_VENDOR_DIAG_RESET_REQUEST  = 0x3C03;
export const SPINEL_PROP_VENDOR_NEIGHBOR_TABLE      = 0x3C04;
export const SPINEL_PROP_VENDOR_CHILD_TABLE         = 0x3C05;

export const SPINEL_STATUS_OK               = 0;
export const SPINEL_STATUS_FAILURE          = 1;
export const SPINEL_STATUS_INVALID_ARGUMENT = 3;
export const SPINEL_STATUS_BUSY             = 12;

// --- Spinel packed-int encoding (for prop keys > 127) ---

function encodePackedUint(value: number): Buffer {
  // "Packed unsigned integer" per Spinel spec — variable-length, 7 bits per byte,
  // most-significant byte first (with high bit set on all but the last).
  if (value < 0) throw new Error("packed uint must be non-negative");
  const bytes: number[] = [];
  let v = value;
  while (v > 0x7F) {
    bytes.push((v & 0x7F) | 0x80);
    v >>>= 7;
  }
  bytes.push(v & 0x7F);
  return Buffer.from(bytes);
}

function decodePackedUint(buf: Buffer, offset: number): { value: number; bytes: number } {
  let value = 0;
  let shift = 0;
  let i = 0;
  while (true) {
    if (offset + i >= buf.length) throw new Error("truncated packed uint");
    const b = buf[offset + i++];
    value |= (b & 0x7F) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return { value, bytes: i };
}

// --- Frame builders ---

export function buildPropGet(header: number, prop: number): Buffer {
  return Buffer.concat([
    Buffer.from([header, SPINEL_CMD_PROP_VALUE_GET]),
    encodePackedUint(prop),
  ]);
}

export function buildPropSet(header: number, prop: number, value: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([header, SPINEL_CMD_PROP_VALUE_SET]),
    encodePackedUint(prop),
    value,
  ]);
}

export function buildDiagGetRequest(dstAddr: Buffer, tlvTypes: readonly number[]): Buffer {
  if (dstAddr.length !== 16) throw new Error("dstAddr must be 16 bytes");
  if (tlvTypes.length === 0 || tlvTypes.length > 32) throw new Error("tlvTypes 1..32");
  const value = Buffer.concat([
    dstAddr,
    Buffer.from([tlvTypes.length]),
    Buffer.from(tlvTypes),
  ]);
  return buildPropSet(0x81, SPINEL_PROP_VENDOR_DIAG_GET_REQUEST, value);
}

export function buildDiagResetRequest(dstAddr: Buffer, tlvTypes: readonly number[]): Buffer {
  if (dstAddr.length !== 16) throw new Error("dstAddr must be 16 bytes");
  const value = Buffer.concat([dstAddr, Buffer.from([tlvTypes.length]), Buffer.from(tlvTypes)]);
  return buildPropSet(0x81, SPINEL_PROP_VENDOR_DIAG_RESET_REQUEST, value);
}

// --- Response decoder ---

export type SpinelResponse =
  | { kind: "is"; prop: number; value: Buffer }
  | { kind: "insert"; prop: number; value: Buffer }
  | { kind: "remove"; prop: number; value: Buffer }
  | { kind: "other"; cmd: number; value: Buffer };

export function decodeResponse(frame: Buffer): SpinelResponse | null {
  if (frame.length < 3) return null;
  const cmd = frame[1];
  const { value: prop, bytes } = decodePackedUint(frame, 2);
  const value = frame.subarray(2 + bytes);
  switch (cmd) {
    case SPINEL_CMD_PROP_VALUE_IS:       return { kind: "is", prop, value };
    case SPINEL_CMD_PROP_VALUE_INSERTED: return { kind: "insert", prop, value };
    case SPINEL_CMD_PROP_VALUE_REMOVED:  return { kind: "remove", prop, value };
    default: return { kind: "other", cmd, value };
  }
}

// --- Neighbor / child table parsing ---

export interface NeighborEntry {
  extAddr: string;    // colon hex
  rloc16: number;
  ageSec: number;
  avgRssi: number;    // signed
  lastRssi: number;   // signed
  isChild: boolean;
  rxOnWhenIdle: boolean;
  fullThreadDevice: boolean;
}

export function parseNeighborTable(body: Buffer): NeighborEntry[] {
  if (body.length < 1) return [];
  const count = body[0];
  const entries: NeighborEntry[] = [];
  let i = 1;
  for (let n = 0; n < count; n++) {
    if (i + 17 > body.length) break;
    const extAddr = body.subarray(i, i + 8).toString("hex").match(/.{2}/g)!.join(":");
    i += 8;
    const rloc16 = body[i] | (body[i + 1] << 8); i += 2;
    const ageSec = body.readUInt32LE(i); i += 4;
    const avgRssi = body.readInt8(i); i += 1;
    const lastRssi = body.readInt8(i); i += 1;
    const flags = body[i++];
    entries.push({
      extAddr, rloc16, ageSec, avgRssi, lastRssi,
      isChild: !!(flags & 0x01),
      rxOnWhenIdle: !!(flags & 0x02),
      fullThreadDevice: !!(flags & 0x04),
    });
  }
  return entries;
}

export interface ChildEntry extends NeighborEntry {
  timeoutSec: number;
}

export function parseChildTable(body: Buffer): ChildEntry[] {
  if (body.length < 1) return [];
  const count = body[0];
  const entries: ChildEntry[] = [];
  let i = 1;
  for (let n = 0; n < count; n++) {
    if (i + 21 > body.length) break;
    const extAddr = body.subarray(i, i + 8).toString("hex").match(/.{2}/g)!.join(":");
    i += 8;
    const rloc16 = body[i] | (body[i + 1] << 8); i += 2;
    const timeoutSec = body.readUInt32LE(i); i += 4;
    const ageSec = body.readUInt32LE(i); i += 4;
    const avgRssi = body.readInt8(i); i += 1;
    const lastRssi = body.readInt8(i); i += 1;
    const flags = body[i++];
    entries.push({
      extAddr, rloc16, ageSec, timeoutSec, avgRssi, lastRssi,
      isChild: true,
      rxOnWhenIdle: !!(flags & 0x02),
      fullThreadDevice: !!(flags & 0x04),
    });
  }
  return entries;
}

// --- Transport: wrap Spinel frame in `shell spinel raw <hex>` command ---

const STREAM_CMD_KEEPALIVE = 0x00;
const STREAM_CMD_TEXT      = 0x20;
const STREAM_RESP_TEXT     = 0xfd;
const STREAM_HEARTBEAT     = 0xff;

function buildStreamCommand(cmd: number, data: Buffer): Buffer {
  const out = Buffer.alloc(2 + data.length);
  out[0] = cmd;
  out[1] = data.length;
  data.copy(out, 2);
  return out;
}

/** Send a Spinel frame via the STM32 shell passthrough; collect response text for windowMs. */
async function sendSpinelAndCollect(
  host: string,
  port: number,
  spinelFrame: Buffer,
  windowMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = createSocket("udp4");
    let captured = "";
    const keepalive = buildStreamCommand(STREAM_CMD_KEEPALIVE, Buffer.alloc(0));
    const shellCmd = `spinel raw ${spinelFrame.toString("hex")}`;
    const textCmd = buildStreamCommand(STREAM_CMD_TEXT, Buffer.from(shellCmd, "utf8"));

    let ka: ReturnType<typeof setInterval> | null = null;
    const done = (err?: Error) => {
      if (ka) clearInterval(ka);
      sock.close();
      if (err) reject(err); else resolve(captured);
    };

    sock.on("error", done);
    sock.on("message", (msg) => {
      if (msg.length >= 2 && msg[0] === STREAM_HEARTBEAT && msg[1] === 0x00) return;
      if (msg.length >= 1 && msg[0] === STREAM_RESP_TEXT) {
        captured += msg.subarray(1).toString("utf8");
      }
    });
    sock.bind(0, async () => {
      try {
        await new Promise<void>((r, rj) =>
          sock.send(keepalive, port, host, (e) => e ? rj(e) : r()),
        );
        ka = setInterval(() => sock.send(keepalive, port, host, () => {}), 1000);
        await new Promise<void>((r, rj) =>
          sock.send(textCmd, port, host, (e) => e ? rj(e) : r()),
        );
        setTimeout(() => done(), windowMs);
      } catch (err) { done(err as Error); }
    });
  });
}

/** Extract Spinel response frames from the STM32's `spinel raw` text output.
 *  The STM32 shell prints "Response (<N> bytes): <hex>" per received frame. */
function extractSpinelResponses(text: string): Buffer[] {
  const re = /Response\s+\(\d+\s+bytes\):\s+([0-9A-Fa-f ]+)/g;
  const out: Buffer[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(Buffer.from(m[1].replace(/\s+/g, ""), "hex"));
  }
  return out;
}

function ipv6Bytes(addr: string): Buffer {
  const stripped = addr.split("%")[0];
  const parts = stripped.includes("::")
    ? (() => {
        const [h, t] = stripped.split("::");
        const hp = h ? h.split(":") : [];
        const tp = t ? t.split(":") : [];
        const missing = 8 - hp.length - tp.length;
        return [...hp, ...Array(missing).fill("0"), ...tp];
      })()
    : stripped.split(":");
  if (parts.length !== 8) throw new Error(`Invalid IPv6: ${addr}`);
  const buf = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) buf.writeUInt16BE(parseInt(parts[i] || "0", 16), i * 2);
  return buf;
}

// --- Main command surface ---

async function cmdNeighbors(host: string, port: number): Promise<void> {
  const frame = buildPropGet(0x81, SPINEL_PROP_VENDOR_NEIGHBOR_TABLE);
  const text = await sendSpinelAndCollect(host, port, frame, 500);
  const frames = extractSpinelResponses(text);
  for (const f of frames) {
    const r = decodeResponse(f);
    if (r?.kind === "is" && r.prop === SPINEL_PROP_VENDOR_NEIGHBOR_TABLE) {
      const entries = parseNeighborTable(r.value);
      console.log(`# ${entries.length} neighbors`);
      for (const e of entries) {
        console.log(`  ext=${e.extAddr} rloc=0x${e.rloc16.toString(16).padStart(4, "0")} age=${e.ageSec}s rssi=${e.avgRssi}/${e.lastRssi} flags=${[e.isChild && "child", e.rxOnWhenIdle && "rxOn", e.fullThreadDevice && "ftd"].filter(Boolean).join(",")}`);
      }
    }
  }
}

async function cmdChildren(host: string, port: number): Promise<void> {
  const frame = buildPropGet(0x81, SPINEL_PROP_VENDOR_CHILD_TABLE);
  const text = await sendSpinelAndCollect(host, port, frame, 500);
  const frames = extractSpinelResponses(text);
  for (const f of frames) {
    const r = decodeResponse(f);
    if (r?.kind === "is" && r.prop === SPINEL_PROP_VENDOR_CHILD_TABLE) {
      const entries = parseChildTable(r.value);
      console.log(`# ${entries.length} children`);
      for (const e of entries) {
        console.log(`  ext=${e.extAddr} rloc=0x${e.rloc16.toString(16).padStart(4, "0")} timeout=${e.timeoutSec}s age=${e.ageSec}s rssi=${e.avgRssi}/${e.lastRssi}`);
      }
    }
  }
}

async function cmdDiagGet(host: string, port: number, dst: string, types: number[]): Promise<void> {
  const frame = buildDiagGetRequest(ipv6Bytes(dst), types);
  const text = await sendSpinelAndCollect(host, port, frame, 6000);
  const frames = extractSpinelResponses(text);
  let responderCount = 0;
  for (const f of frames) {
    const r = decodeResponse(f);
    if (r?.kind === "insert" && r.prop === SPINEL_PROP_VENDOR_DIAG_GET_RESPONSE) {
      const src = Array.from(r.value.subarray(0, 16)).map((b) => b.toString(16).padStart(2, "0"));
      const srcStr = Array.from({ length: 8 }, (_, i) => src[i * 2] + src[i * 2 + 1]).join(":");
      const tlvLen = r.value[16] | (r.value[17] << 8);
      const truncated = !!(tlvLen & 0x8000);
      const realLen = tlvLen & 0x7FFF;
      const tlv = r.value.subarray(18, 18 + realLen);
      const decoded = decodeDiagResponse(tlv);
      console.log(`src=${srcStr} eui64=${decoded.eui64 ?? "-"} rloc=${decoded.rloc16?.toString(16) ?? "-"} addrs=[${decoded.ipv6Addresses.join(",")}]${truncated ? " (truncated)" : ""}`);
      responderCount++;
    } else if (r?.kind === "insert" && r.prop === SPINEL_PROP_VENDOR_DIAG_GET_DONE) {
      const reason = r.value[0];
      const count = r.value[1] | (r.value[2] << 8);
      console.log(`# DONE reason=${reason} responders=${count} (probe saw ${responderCount})`);
    }
  }
}

async function cmdDiagReset(host: string, port: number, dst: string, types: number[]): Promise<void> {
  const frame = buildDiagResetRequest(ipv6Bytes(dst), types);
  const text = await sendSpinelAndCollect(host, port, frame, 500);
  const frames = extractSpinelResponses(text);
  for (const f of frames) {
    const r = decodeResponse(f);
    if (r?.kind === "is" && r.prop === SPINEL_PROP_LAST_STATUS) {
      const status = r.value[0];
      console.log(`# diag-reset LAST_STATUS=${status}`);
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const host = args[args.indexOf("--host") + 1] || config.openBridge;
  const port = 9433;
  const cmd = args.find((a) => !a.startsWith("--")) ?? "neighbors";
  const rest = args.filter((a) => !a.startsWith("--") && a !== cmd);

  if (!host) throw new Error("Missing --host and config.openBridge unset");

  switch (cmd) {
    case "neighbors":   await cmdNeighbors(host, port); break;
    case "children":    await cmdChildren(host, port); break;
    case "diag-get":    await cmdDiagGet(host, port, rest[0], rest.slice(1).map((n) => Number(n))); break;
    case "diag-reset":  await cmdDiagReset(host, port, rest[0], rest.slice(1).map((n) => Number(n))); break;
    default: throw new Error(`Unknown command: ${cmd}. Use: neighbors | children | diag-get <addr> <types...> | diag-reset <addr> <types...>`);
  }
}

main().catch((err) => { console.error(`Error: ${(err as Error).message}`); process.exit(1); });
```

- [ ] **Step 3: Run tests, typecheck, lint**

```bash
node --import tsx --test test/nrf-ncp-probe.test.ts
npm run typecheck
npm run lint
```

Expected: 5 tests pass. Lint may want auto-fix — run `npm run lint:fix`.

- [ ] **Step 4: Commit**

```bash
git add tools/nrf-ncp-probe.ts test/nrf-ncp-probe.test.ts
git commit -m "feat(tools): nrf-ncp-probe — standalone Spinel client for Plan-1 verification"
```

---

## Phase 9 — Hardware verification

> **Executor note:** the remaining tasks require physical access to the Nucleo and the Thread mesh. If you're running without hardware access, stop here and hand off.

### Task 9.1: Flash the TMF firmware

- [ ] **Step 1: Flash via DFU**

```bash
cd /Users/alex/lutron-tools/.claude/worktrees/pedantic-johnson-77c037
npx tsx tools/nrf-dfu-flash.ts --tmf
```

Follow the prompts (press reset button on dongle, press ENTER). Expected: nrfutil completes DFU; dongle re-enumerates as a normal CDC port.

- [ ] **Step 2: Wait for Thread attach**

The NCP needs 30–60 seconds to re-attach as a Router after flash.

```bash
sleep 60
npx tsx tools/nucleo-cmd.ts "ccx"
```

Expected: `Thread role: ROUTER`.

### Task 9.2: Smoke — `neighbors` returns a non-empty table

- [ ] **Step 1: Run the neighbors probe**

```bash
npx tsx tools/nrf-ncp-probe.ts neighbors
```

Expected: non-empty output, at least one entry with a 64-bit ext address and a sensible RLOC (e.g. `rloc=0x3800` for the processor). If empty: smoke test fails → flash rollback and debug.

If smoke passes, this is the first strong signal the dispatch path works end-to-end.

### Task 9.3: Unicast diag-get against a known device

- [ ] **Step 1: Pick a Designer-DB-known device**

Pick any entry from `data/designer-ccx-devices.json` (user-local). Its `secondaryMleid` is the target. Example: `fd00::e079:8dff:fe92:85fe`.

- [ ] **Step 2: Run unicast diag-get with TLVs 0 (ExtMac), 1 (RLOC16), 8 (IPv6 List)**

```bash
npx tsx tools/nrf-ncp-probe.ts diag-get fd00::e079:8dff:fe92:85fe 0 1 8
```

Expected: one `src=…` line where the EUI-64 matches Designer DB, followed by `# DONE reason=0 responders=1`.

### Task 9.4: Multicast diag-get — all responders

- [ ] **Step 1: Run multicast diag-get**

```bash
npx tsx tools/nrf-ncp-probe.ts diag-get ff03::1 0 1 8
```

Expected: ≥ 10 `src=…` lines within 5 seconds, followed by `# DONE reason=0 responders=N`. **The Office Entrance keypad should appear when its button is pressed during the window** — canonical acceptance case.

- [ ] **Step 2: Verify Office Entrance specifically**

Press the Office Entrance keypad button during a fresh query. Confirm a line appears with its EUI-64 matching Designer DB.

### Task 9.5: Regression — CCX comms unaffected

- [ ] **Step 1: Verify status**

```bash
npx tsx tools/nucleo-cmd.ts "ccx"
```

Expected: `Thread role: ROUTER`, RX/TX counters > 0.

- [ ] **Step 2: Exercise a zone dim (the mesh's normal TX path)**

Pick any zone ID from Designer DB, dim it via the existing CLI:

```bash
npx tsx tools/nucleo-cmd.ts "ccx zone <id> 50"
sleep 2
npx tsx tools/nucleo-cmd.ts "ccx zone <id> 100"
```

Expected: the zone visibly dims then brightens. TX counters increment. No regressions.

- [ ] **Step 3: Button press still broadcasts**

Watch stream output in another terminal (`npx tsx cli/nucleo.ts`), press any keypad button, confirm a CCX BUTTON_PRESS frame appears.

### Task 9.6: Commit the verified artifacts (or rollback)

- [ ] **Step 1: If all of 9.1–9.5 pass:**

Artifacts committed in Phase 6 are already correct. No further action beyond an optional annotation commit:

```bash
cd /Users/alex/lutron-tools/.claude/worktrees/pedantic-johnson-77c037
git commit --allow-empty -m "verify(nrf-ncp): Plan-1 hardware acceptance passed on $(date +%Y-%m-%d)"
```

- [ ] **Step 2: If any step fails:**

Roll back and open debugging:

```bash
npx tsx tools/nrf-dfu-flash.ts --rollback
sleep 60
npx tsx tools/nucleo-cmd.ts "ccx"   # expect ROUTER, CCX still works
```

Note the failure in `tools/nrf-ncp/tmf-ext-notes.md`, decide on remediation (code fix → regenerate patch → re-run Phase 6 onward).

---

## Phase 10 — Documentation updates

### Task 10.1: Update `docs/protocols/ccx-coap.md`

**Files:**
- Modify: `docs/protocols/ccx-coap.md`

- [ ] **Step 1: Amend the "NCP restriction on port 61631" section**

Find the existing section (added 2026-04-21). Replace the closing paragraph:

```markdown
To enable the mesh sweep as originally designed, the NCP would need a
dedicated Spinel property that routes through `otThreadSendDiagnosticGet()`
internally (bypassing STREAM_NET's port filtering). Deferred to a follow-up
plan; `tools/tmf-diag.ts` and the TLV codec remain in tree so that path can
pick them up when the firmware side lands.
```

With:

```markdown
**Resolution (2026-04-22):** the NCP firmware now carries a vendor Spinel
extension (`0x3C00..0x3C05`) that exposes `otThreadSendDiagnosticGet` and
related APIs directly to the host, bypassing the STREAM_NET port filter.
See `docs/superpowers/specs/2026-04-22-ncp-tmf-extension-design.md` and
`tools/nrf-ncp-probe.ts`. STM32 host-side integration + `tools/tmf-diag.ts`
wiring land in Plan 2.
```

- [ ] **Step 2: Commit**

```bash
git add docs/protocols/ccx-coap.md
git commit -m "docs(ccx-coap): record resolution of port-61631 NCP restriction"
```

### Task 10.2: Update `.claude/skills/nrf/SKILL.md`

**Files:**
- Modify: `.claude/skills/nrf/SKILL.md`

- [ ] **Step 1: Add a `--tmf` / `--rollback` mini-section**

After the existing "OpenThread RCP" section, insert:

```markdown
---

## Mode: Lutron TMF-extension NCP (for the Nucleo-soldered dongle)

The Nucleo-soldered nRF52840 runs `ot-ncp-ftd` with our TMF vendor extension.
Two DFU artifacts live in `firmware/ncp/`:

- `ot-ncp-ftd-dfu.zip` — known-good baseline (no extension).
- `ot-ncp-ftd-tmf-dfu.zip` — with TMF extension enabled.

### Flash the TMF build

```bash
npx tsx tools/nrf-dfu-flash.ts --tmf
```

### Roll back to known-good

```bash
npx tsx tools/nrf-dfu-flash.ts --rollback
```

### Probe the TMF extension

```bash
npx tsx tools/nrf-ncp-probe.ts neighbors
npx tsx tools/nrf-ncp-probe.ts children
npx tsx tools/nrf-ncp-probe.ts diag-get ff03::1 0 1 8
npx tsx tools/nrf-ncp-probe.ts diag-get <fd00::addr> 0 1 8
npx tsx tools/nrf-ncp-probe.ts diag-reset <fd00::addr> 9
```

The probe talks Spinel directly to the NCP via the STM32's `shell spinel raw`
passthrough on UDP :9433; no STM32 firmware changes needed.
```

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/nrf/SKILL.md
git commit -m "docs(skill/nrf): document --tmf / --rollback / nrf-ncp-probe workflow"
```

---

## Self-review notes (kept for Plan 2 authors)

Plan 1 deliberately treats the OT source modifications as a patch-and-verify loop rather than a deeply-unit-tested library. Rationale:

- The extension code runs in a closed firmware environment (nRF52840) where host-based unit tests don't apply.
- The TS-side tools (`nrf-dfu-flash.ts`, `nrf-ncp-probe.ts`) DO have real unit tests (Phase 7 + 8).
- End-to-end validation happens via the hardware checklist in Phase 9, with a one-command rollback path as the safety net.

If Phase 9 uncovers issues that suggest deeper instability (e.g. intermittent BUSY, frame corruption), consider adding a fifth hardware phase for soak testing before declaring Plan 1 done.

Plan 2 will cover: `ccx_send_diag_get()` + stream broadcasts on the STM32, switching `tools/tmf-diag.ts` from the dead port-61631 path to this Spinel channel, and retiring the stale predecessor plan's Phase 5 commentary.
