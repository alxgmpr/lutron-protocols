# Lean protocol verification

Run from the repository root:

```sh
npm run test:lean
```

Install [Lean via elan](https://lean-lang.org/install/) first. The runner finds
`~/.elan/bin/lake`, falling back to `lake` on PATH. `lean-toolchain` pins Lean
4.34.1. Lake downloads that version when necessary. No Mathlib or other external
Lean library is required. Lean warnings fail the build, including `sorry`
placeholders. The checked proofs use no added axioms or `native_decide`.

CI runs this command in a dedicated `test-lean` job on pushes and pull requests,
using Node 22 and a cached, pinned Lean toolchain. Locally it remains separate
from `npm test`. Once Lean is installed,
it runs offline: fake sockets and clocks exercise the real LEAP client methods
without certificates or processor connections. Four lifecycle regressions also
run in the ordinary TypeScript test suite, without requiring Lean.

## Proofs and implementation checks

Lean proves properties of an executable model. `Main.lean` emits vectors and
state-machine traces; `tools/check-lean.ts` compares them with production code.
The proofs are universal under their stated assumptions. The differential tests
cover the finite domains below, not every possible JavaScript execution.

| Model | Kernel-checked properties | Production comparisons |
| --- | --- | --- |
| `Lutron.lean` | Integral level endpoints, bounds, monotonicity, half-level rounding bound; whole/quarter-second round-trips; LSB-first byte round-trips | 101 integral percentages, 256 quarter-second values, all 256 bytes, concatenation and seven partial-byte tails |
| `Lutron/Packet.lean` | CCA build/parse round-trip with arbitrary trailing data; packet length; valid-byte bounds; zero-length, truncated and bad-checksum rejection; checksum byte comparison equals big-endian integer comparison | 256 packets covering every opcode and every legal body length, independent bitwise CRC versus production lookup-table CRC, each packet's strict prefixes, corrupted CRCs, zero LEN and trailing data |
| `Lutron/Ccx.lean` | Unsigned CBOR encode/decode round-trip; emitted bytes fit in a byte for 32-bit input | 17 values around CBOR size boundaries through `0xffffffff`, both generic messages and complete default LEVEL_CONTROL packets |
| `Lutron/Leap.lean` | At most one public settlement per request across arbitrary event lists; interim 102 leaves a pending request unchanged; close clears pending/subscription state; refusal detaches; detached state cannot dispatch pushes | All 432 three-event traces over six events, for ordinary requests and subscriptions; two same-chunk response/push traces; tag reuse and old-subscription cleanup; unsubscribe before acknowledgement |

CCA packet bodies are deterministic patterns, not an enumeration of all possible
payloads. Each opcode is paired with one length; this is not the Cartesian product
of all opcodes and lengths. The CCA parser theorem starts at LEN after the fixed
preamble and sync bytes. It does not prove synchronization or RF demodulation.
The CRC is an executable polynomial model, not a theorem about its error-detection
strength. The CBOR decoder theorem concerns the unsigned scalar model; the complete
LEVEL_CONTROL structure is compared by differential tests, not proved against a
full CBOR parser.

The LEAP model tracks one allocated request/tag. Its events are interim 102,
success, refusal, timeout, close and an unrelated-tag frame, plus explicit detach.
An ordinary request resolves with a non-2xx response; a subscribing request rejects
it. Once no request is pending, frames route to an active subscription or the
unsolicited handler, matching the current client's routing contract. Model trace
comparisons normally drain promise continuations after each event; separate
same-chunk cases deliberately omit that drain between response and push.

## Bugs exposed and regressions

The comparisons reproduced two production failures:

- A refused SubscribeResponse followed by another frame in the same TCP chunk
  dispatched that frame to the refused subscription before the async cleanup ran.
  Frame routing now detaches the subscription synchronously on refusal.
- A deadline from a closed connection could delete a new request that reused its
  ClientTag, leaving the new promise unresolved. Terminal paths now cancel their
  timers, and each deadline checks request-object identity before deleting state.

Subscription cleanup also checks object identity so a delayed rejection from an
old subscription cannot remove its replacement. These reuse tests exercise close
and socket replacement offline; they do not establish correctness of TLS reconnect
or stale socket callbacks. Synchronous write failures clean up their pending entry
and timer through the same rejection path.

## Remaining boundaries

Natural-number models do not cover NaN, negative numbers, infinities, arbitrary
fractional percentages, or every floating-point rounding case. Production shared
conversions do not clamp inputs, so bounds need the explicit valid-input assumptions.
The bit-list theorem preserves byte boundaries; flattened parsing is tested only.

Not yet formally modeled: all CCX message variants, CBOR malformed-input parsing,
CoAP, multi-request concurrency, real socket error/close/reconnect callbacks,
JSON framing, callback failures, firmware C execution, and live device or RF
interoperability. No claim of full protocol or hardware verification is made.
