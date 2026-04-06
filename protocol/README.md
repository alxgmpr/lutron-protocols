# Protocol Definitions

TypeScript definition files for CCA and CCX protocol structures. These files are the single source of truth for packet formats, enums, and field layouts. The codegen tool (`tools/codegen.ts`) reads these definitions and emits C headers for the firmware.

## Files

| File | Contents |
|------|----------|
| `dsl.ts` | Builder types and functions for defining protocol structures |
| `shared.ts` | Cross-protocol encoding (level/percent conversion, fade/quarter-second conversion) |
| `cca.protocol.ts` | CCA definitions: enums, packet types, field layouts, QS Link constants, sequences |
| `ccx.protocol.ts` | CCX definitions: message types, body keys, CBOR schemas, level/port constants |
| `protocol-ui.ts` | Runtime parsing (`identifyPacket`, `parseFieldValue`) for the CLI packet display |

## Code Generation

```bash
npm run codegen
# or: npx tsx tools/codegen.ts
```

Generates:
- `firmware/src/cca/cca_generated.h`
- `firmware/src/ccx/ccx_generated.h`
