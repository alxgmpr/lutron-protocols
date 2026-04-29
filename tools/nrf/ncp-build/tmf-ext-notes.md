# TMF Extension — Source Investigation Notes

Investigation output for the NCP TMF Vendor Extension implementation plan
(`docs/superpowers/plans/2026-04-21-stable-ccx-addressing-tmf-diag.md`,
spec at `docs/superpowers/specs/2026-04-22-ncp-tmf-extension-design.md`).
This file is Phase 1's deliverable; subsequent phases cite it for exact
line numbers and API shapes.

## Pinned revisions

- `ot-nrf528xx`: `1dce5cd29548dfc27b495889e98f3c15da233eb7` (default branch tip
  on `main` at clone time).
- `openthread` (submodule): `33e163424ed9c5620812eed8948d193682d55007`.
- Pinned on: **2026-04-22**.

All line numbers below refer to these revisions. Paths are relative to the
cloned tree at `build/ot-nrf528xx/` (gitignored — re-clone with
`tools/nrf-ncp/build.sh`).

## Baseline build

**Status: BLOCKED on local tooling (not on source or architecture).**

- ARM GCC at `/Applications/ArmGNUToolchain/15.2.rel1/arm-none-eabi/bin`: present.
- `cmake`: present at `/opt/homebrew/bin/cmake`.
- `ninja`: **missing** — `./script/build` calls `cmake -GNinja` and requires it.
- `nrfutil` with `nrf5sdk-tools`: **missing** — packaging step `nrfutil
  nrf5sdk-tools pkg generate` is the last step of `build.sh`.

To unblock:

```bash
brew install ninja
pip3 install --user --break-system-packages nrfutil  # or use a venv per CLAUDE.md global rule
nrfutil install nrf5sdk-tools
```

Once installed, re-run `tools/nrf-ncp/build.sh`. The clone/submodule steps are
idempotent; only the patch-apply + build + package steps need to run.

### Blocker: `tools/nrf-ncp/nucleo-uart.patch` is malformed

The committed patch omits hunk line counts (`@@ -N +N @@` instead of
`@@ -N,M +N,M @@`) and at least one context line, so `git apply` rejects it
with "corrupt patch at line 11". For this investigation, I applied the four
intended changes to the cloned file manually (so the source layout matches
what Phase 2+ will see), but **`build.sh` will fail at the `git apply` step
on a fresh clone** until the patch is regenerated. A regenerated patch
produced with `git diff` from the modified file is preserved at
`/tmp/nucleo-uart-fixed.patch` in this session; it should be dropped into
`tools/nrf-ncp/nucleo-uart.patch` in a separate commit (out of Phase 1 scope).
Intended changes (UART pins for Nucleo routing — TX 6→20, RX 8→24, baud
115200→460800, HWFC on→off) are already applied to the cloned tree.

---

## Hook points

### Property dispatch

Dispatch lives in a dedicated file — not in `ncp_base.cpp`.

- **Dispatcher file**: `openthread/src/ncp/ncp_base_dispatcher.cpp`
  (853 lines total in the pinned tree).
- **Entry shape** (`openthread/src/ncp/ncp_base.hpp:376-380`):
  ```cpp
  struct HandlerEntry
  {
      spinel_prop_key_t        mKey;
      NcpBase::PropertyHandler mHandler;
  };
  ```
  where `PropertyHandler` is `typedef otError (NcpBase::*PropertyHandler)(void);`
  (`ncp_base.hpp:352`).

- **Four dispatch tables** — each a file-local `constexpr static HandlerEntry
  sHandlerEntries[]` inside its finder function:

  | Direction | Finder function | Table location | End line |
  |-----------|-----------------|----------------|----------|
  | GET | `NcpBase::FindGetPropertyHandler` | `ncp_base_dispatcher.cpp:45-410` | `@402` (close-brace), `@409` (dispatch call) |
  | SET | `NcpBase::FindSetPropertyHandler` | `ncp_base_dispatcher.cpp:412-722` | `@714`, `@721` |
  | INSERT | `NcpBase::FindInsertPropertyHandler` | `ncp_base_dispatcher.cpp:724-775` | `@767`, `@774` |
  | REMOVE | `NcpBase::FindRemovePropertyHandler` | `ncp_base_dispatcher.cpp:777-825` | `@817`, `@824` |

- **Entry add macro** (local to each finder, `#define`/`#undef` wrapped):
  `OT_NCP_GET_HANDLER_ENTRY(SPINEL_PROP_*)` →
  `{aPropertyName, &NcpBase::HandlePropertyGet<aPropertyName>}`; analogous for
  SET / INSERT / REMOVE.

- **Alternative — macro-driven?** No. Tables are literal initializer lists
  inside each finder. `OT_DEFINE_SPINEL_PROP_HANDLER` does **not** exist.

- **Lookup mechanism** (`ncp_base_dispatcher.cpp:827-850`): sorted binary search
  via `NcpBase::FindPropertyHandler(aHandlerEntries, aSize, aKey)`. Every
  finder ends with
  ```cpp
  static_assert(AreHandlerEntriesSorted(sHandlerEntries,
                                        OT_ARRAY_LENGTH(sHandlerEntries)),
                "NCP property ... entries not sorted!");
  return FindPropertyHandler(sHandlerEntries, OT_ARRAY_LENGTH(sHandlerEntries), aKey);
  ```
  so **entries must be in ascending `spinel_prop_key_t` order**. Our vendor IDs
  `0x3C00`–`0x3C05` are larger than every stock key (tail of the stock tables
  is in the `SPINEL_PROP_DEBUG_*` range, `0x2000`-ish), so they go at the
  **end** of each applicable table — before the closing `};` and after any
  `#endif` at the tail.

- **Templated handler trick**: the stock macros instantiate a template
  `NcpBase::HandlePropertyGet<SPINEL_PROP_*>()` per key. For vendor IDs our
  extension will either (a) supply explicit template specializations for
  `HandlePropertyGet<0x3C04>()` etc., or (b) thunk through a handful of
  non-templated member methods (cleaner — Phase 2 decides).

### Constructor / init hook

- **Single-instance constructor** (`openthread/src/ncp/ncp_base.cpp:271-395`):
  `NcpBase::NcpBase(Instance *aInstance)`. This is the form called from
  `NcpHdlc` subclass construction (FTD + USB build). Constructor body (after
  initializer list) runs `246-395`.

- **Last statement in the body** — `ncp_base.cpp:392-394`:
  ```cpp
  #if OPENTHREAD_ENABLE_VENDOR_EXTENSION
      aInstance->Get<Extension::ExtensionBase>().SignalNcpInit(*this);
  #endif
  ```
  followed by the closing brace at **line 395**.

- **Insertion point for `NcpTmfExtensionInit(this)`**: just before line 395,
  after the `#endif` on line 394. At this point all OT callbacks have been
  registered (state-changed, IPv6 receive, CLI, etc.) and
  `mChangedPropsSet.AddLastStatus(SPINEL_STATUS_RESET_UNKNOWN)` has posted the
  initial reset notification, so the extension can safely start its timer and
  register its own callbacks.

- **Multi-instance constructor** (`ncp_base.cpp:246-268`,
  `#if OPENTHREAD_CONFIG_MULTIPAN_RCP_ENABLE && OPENTHREAD_RADIO`): not used
  by this build. Delegates to single-instance constructor on line 247, so
  adding the hook only to the single-instance body covers both cases.

### Async property emission

**No single-call helper exists for `PROP_VALUE_INSERTED`.** The stock helper

```cpp
otError NcpBase::WritePropertyValueIsFrame(uint8_t aHeader,
                                           spinel_prop_key_t aPropKey,
                                           bool aIsGetResponse = true);
```

(declared at `ncp_base.hpp:403`, defined at `ncp_base.cpp:1227-1300+`) only
emits `SPINEL_CMD_PROP_VALUE_IS` and dispatches to the registered Get handler
to produce the payload — not what we want for our asynchronous TLV stream.

**Canonical three-step pattern** — this is what all existing
`PROP_VALUE_INSERTED` async emitters use. Representative callsite:
`HandleActiveScanResult` in `openthread/src/ncp/ncp_base_mtd.cpp:4230-4283`:

```cpp
SuccessOrExit(error = mEncoder.BeginFrame(SPINEL_HEADER_FLAG | SPINEL_HEADER_IID_0,
                                          SPINEL_CMD_PROP_VALUE_INSERTED,
                                          SPINEL_PROP_MAC_SCAN_BEACON));
// ... WriteUint8 / WriteInt8 / OpenStruct / WriteEui64 / ... / CloseStruct ...
SuccessOrExit(error = mEncoder.EndFrame());
```

Key encoder methods (declared in
`openthread/src/lib/spinel/spinel_encoder.hpp`):

- `BeginFrame(uint8_t aHeader, unsigned int aCommand, spinel_prop_key_t aKey)` (`:117`)
- `WriteUint8 / WriteUint16 / WriteUintPacked` (`:185, :321`)
- `WriteEui64(uint8_t *)` (`:423`)
- `WriteData(uint8_t *, uint16_t)` (`:492`)
- `WriteUtf8(const char *)` (`:474`)
- `OpenStruct` / `CloseStruct` (`:603, :619`)
- `EndFrame()` (`:151`)

Encoder lives on `NcpBase` as `Spinel::Encoder mEncoder;`
(`ncp_base.hpp:773`, protected). An extension implemented via a **`friend
class` declaration on NcpBase** or **as a NcpHdlc subclass** gets direct
access to `mEncoder`; these are the two Phase 2 design options. The spec
commits to the former (direct patch) to avoid the subclass indirection.

**Recommended header for async frames** (broadcast to all IIDs for
single-instance builds, resolves to IID_0):

```cpp
#define SPINEL_HEADER_TX_NOTIFICATION_IID SPINEL_HEADER_IID_0
// ncp_base.hpp:78 — single-instance build branch
uint8_t header = SPINEL_HEADER_FLAG | SPINEL_HEADER_TX_NOTIFICATION_IID;
```

**Buffer-full recovery pattern** — every async emitter follows
`HandleActiveScanResult`'s `exit:` fallback:

```cpp
exit:
    if (error != OT_ERROR_NONE) {
        mChangedPropsSet.AddLastStatus(SPINEL_STATUS_NOMEM);
        mUpdateChangedPropsTask.Post();
    }
```

The extension's `DIAG_GET_RESPONSE` emitter should follow the same pattern —
drop the individual response frame on buffer full, signal the host via the
shared NOMEM update task.

### Timer

**NcpBase does not itself use `TimerMilli`.** It uses a `Tasklet`
(`mUpdateChangedPropsTask`, `ncp_base.hpp:784`, grep in this file shows it as
the only timer-like primitive on NcpBase).

The right primitive for the TMF extension's 5-second completion timer is
therefore a new `TimerMilli` / `TimerMilliContext`, declared in the extension
as its own member — not borrowed from NcpBase.

- **Class**: `ot::TimerMilli` in
  `openthread/src/core/common/timer.hpp:259-362`.
- **Context-pointer variant**: `ot::TimerMilliContext` at `:397-423` (adds a
  `void *mContext` for extensions that may have multiple instances).
- **Handler signature**: `typedef void (&Handler)(Timer &aTimer);` (`:195`)
  — the callback receives the base `Timer &` and downcasts as needed.
- **Typed variant (recommended)**: `TimerMilliIn<Owner, HandleTimerPtr>`
  (`:372-387`) — template that binds a pointer-to-member-function as the
  handler without requiring a static jump function. Cleaner than
  `TimerMilliContext` when there's exactly one extension instance.
- **API**: `Start(aDelay_ms)`, `StartAt(aStartTime, aDelay_ms)`, `Stop()`,
  `FireAt(aFireTime)`, `FireAtIfEarlier(...)`.
- **Now**: `TimerMilli::GetNow()` returns a `TimeMilli`.

**Usage sketch** for the spec's 5-second DIAG_GET_DONE timer:

```cpp
class NcpTmfExtension
{
public:
    NcpTmfExtension(Instance &aInstance, NcpBase &aNcp)
        : mNcp(aNcp)
        , mTimer(aInstance)  // TimerMilliIn<NcpTmfExtension, &NcpTmfExtension::HandleTimer>
    {}

    void OnDiagGetAccepted(void) { mTimer.Start(5000); }

private:
    void HandleTimer(void) { /* emit DIAG_GET_DONE, clear mInFlight */ }

    using TimerT = TimerMilliIn<NcpTmfExtension, &NcpTmfExtension::HandleTimer>;
    NcpBase &mNcp;
    TimerT   mTimer;
};
```

### Diagnostic get

- **Header**: `openthread/include/openthread/netdiag.h`.
- **Callback type** (matches spec) — `netdiag.h:346-349`:
  ```c
  typedef void (*otReceiveDiagnosticGetCallback)(otError              aError,
                                                 otMessage           *aMessage,
                                                 const otMessageInfo *aMessageInfo,
                                                 void                *aContext);
  ```
  ✓ **Signature matches spec exactly.**

- **Send function** — `netdiag.h:367-372`:
  ```c
  otError otThreadSendDiagnosticGet(otInstance                    *aInstance,
                                    const otIp6Address            *aDestination,
                                    const uint8_t                  aTlvTypes[],
                                    uint8_t                        aCount,
                                    otReceiveDiagnosticGetCallback aCallback,
                                    void                          *aCallbackContext);
  ```

⚠ **API MISMATCH vs spec** — but a small one. The spec assumed a 4-arg send +
separate `otThreadSetReceiveDiagnosticGetCallback()`. The real API is **6-arg
send with the callback + context passed per-call**. There is **no
`otThreadSetReceiveDiagnosticGetCallback`** in this tree — `grep` across
`openthread/include/` and `openthread/src/` confirms absence.

**Impact**: low. The spec's `mCallback` / `mCallbackContext` state on the
extension is unaffected — we just pass them as arguments each time we call
`otThreadSendDiagnosticGet` instead of registering them once at init.
Concretely in Phase 2:
```cpp
// at init — no longer needed:
// otThreadSetReceiveDiagnosticGetCallback(mInstance,
//     &NcpTmfExtension::HandleDiagGetResponse, this);

// at DIAG_GET_REQUEST accept time:
otThreadSendDiagnosticGet(mInstance, &dst, tlvs, count,
                          &NcpTmfExtension::HandleDiagGetResponse, this);
```

- **Reset function** (for `VENDOR_DIAG_RESET_REQUEST`, spec prop `0x3C03`) —
  `netdiag.h:387-390`:
  ```c
  otError otThreadSendDiagnosticReset(otInstance         *aInstance,
                                      const otIp6Address *aDestination,
                                      const uint8_t       aTlvTypes[],
                                      uint8_t             aCount);
  ```
  ✓ No callback param (fire-and-forget — matches spec's "no response" note).

- **Config gate**: both APIs are behind `OPENTHREAD_CONFIG_TMF_NETDIAG_CLIENT_ENABLE`
  (`openthread/src/core/config/tmf.h:181-190`). **Default value is
  `OPENTHREAD_CONFIG_BORDER_ROUTING_ENABLE`**, which is `OFF` for the stock
  ot-nrf528xx NCP-FTD build. The extension's build must append
  `-DOT_NETDIAG_CLIENT=ON` to `./script/build` (CMake option maps to the
  config flag via `etc/cmake/options.cmake:243`). **Phase 2 must add this to
  `build.sh`.**

### Bonus findings

1. **Vendor prop-ID sub-range conflict (minor)**:
   `spinel.h:5100-5101` defines
   `SPINEL_PROP_VENDOR_ESP__BEGIN = SPINEL_PROP_VENDOR__BEGIN + 0` ( = `0x3C00`),
   `SPINEL_PROP_VENDOR_ESP__END = SPINEL_PROP_VENDOR__BEGIN + 128` ( = `0x3C80`).
   So the spec's chosen IDs `0x3C00`–`0x3C05` are **inside Espressif's
   reserved sub-range**. No practical conflict (we don't run Espressif
   firmware), but worth logging. Phase 2 could move to `0x3C80+` or
   `0x3F00+` if upstreaming ever becomes a goal. Not required for Plan 1.

2. **`otVendor*` hook path is synchronous-only — confirmed**:
   `openthread/src/ncp/example_vendor_hook.cpp` provides
   `VendorGetPropertyHandler`, `VendorSetPropertyHandler`,
   `VendorCommandHandler` — all called on the inbound request thread and
   expected to return a response via `mEncoder` in the synchronous flow
   (look at the call in `WritePropertyValueIsFrame`,
   `ncp_base.cpp:1240-1256`, which is inside a synchronous request
   response). No async emission API is exposed through vendor hooks. The
   spec's rationale for direct-patching `NcpBase` holds.

3. **Alternate `NcpBase` extension option**:
   `example_vendor_hook.cpp:130-152` shows a proper C++-style extension
   point — a user-defined `NcpVendorUart : public NcpHdlc` sub-class. A
   subclass can directly access protected members like `mEncoder`,
   `mInstance`, `mChangedPropsSet`, `mUpdateChangedPropsTask`. **This is an
   alternative to patching NcpBase via `friend class`** — Phase 2 may
   reconsider. The spec commits to the direct-patch approach; both paths
   are tractable. Recording for awareness.

4. **`SPINEL_HEADER_IID_BROADCAST` vs `IID_0`**:
   `ncp_base.hpp:75-79` shows
   ```cpp
   #if OPENTHREAD_CONFIG_MULTIPAN_RCP_ENABLE && OPENTHREAD_RADIO
   #define SPINEL_HEADER_TX_NOTIFICATION_IID SPINEL_HEADER_IID_BROADCAST
   #else
   #define SPINEL_HEADER_TX_NOTIFICATION_IID SPINEL_HEADER_IID_0
   #endif
   ```
   Single-instance FTD build uses `IID_0`. Use `SPINEL_HEADER_TX_NOTIFICATION_IID`
   directly in the extension — no need to hardcode.
