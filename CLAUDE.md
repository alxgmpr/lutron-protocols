# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

Lutron reverse-engineering toolkit: RF transceiver, protocol analyzer, and control interface for Lutron lighting systems (RadioRA3, Homeworks QSX, Caseta, Vive). Covers three transport layers:
- **CCA** (Clear Connect Type A): 433 MHz FSK via STM32H723+CC1101
- **CCX** (Clear Connect Type X): Thread/802.15.4 via nRF52840 (NCP on STM32)
- **LEAP**: JSON/TLS processor API (port 8081)

## Architecture

```
  CC1101 (CCA)  ──┐                              ┌── Interactive shell (USART3/ST-LINK VCP)
                   ├── STM32H723 (FreeRTOS) ──────┤
  nRF52840 (CCX) ─┘   TCP :9433 (lwIP)           └── TCP stream → Bun CLI (cli/nucleo.ts)
```

### Key Directories

| Directory | Runtime | Purpose |
|-----------|---------|---------|
| `firmware/` | STM32 C/C++ (FreeRTOS, lwIP) | Radio drivers, protocol engine, TCP stream, shell |
| `cli/nucleo.ts` | Bun | Primary UI — TCP client, interactive TUI, packet decoder |
| `cli/tui/` | Bun | Terminal UI components (VT100 scroll regions, line editor, table) |
| `tools/` | Bun/TypeScript, Python | CLI utilities (LEAP, CCX, CCA, codegen, analyzers) |
| `protocol/` | YAML + generated TS/C | CCA/CCX protocol definitions (single source of truth) |
| `ccx/` | TypeScript | CCX protocol encoder/decoder/config |
| `lib/` | TypeScript | Shared libraries (env loader, IEEE 802.15.4, Thread crypto) |
| `ldproxy/` | Node.js | Designer auth proxy — injects channel strings to unlock product types |
| `data/` | — | LEAP dumps, device maps, Designer DB exports |

### Protocol Definitions

TypeScript definition files are the single source of truth — no YAML, no generated TS.

- `protocol/dsl.ts` — Builder types and functions for defining protocol structures
- `protocol/shared.ts` — Cross-protocol encoding (level ↔ percent, fade ↔ quarter-seconds)
- `protocol/cca.protocol.ts` — CCA definitions: enums, packet types, field layouts, QS Link constants, sequences
- `protocol/ccx.protocol.ts` — CCX definitions: message types, body keys, CBOR schemas, level/port constants
- `protocol/protocol-ui.ts` — Runtime parsing (identifyPacket, parseFieldValue) — imports from `cca.protocol.ts`
- `ccx/constants.ts` — Thin re-export layer from `ccx.protocol.ts` (encoder/decoder import from here)
- `tools/codegen.ts` — Imports TS defs → emits `firmware/src/cca/cca_generated.h` + `firmware/src/ccx/ccx_generated.h`

### Firmware

FreeRTOS tasks: CCA RX/TX (`cca_task`), CCX NCP (`ccx_task`), TCP stream (`stream`), shell (`shell`).

Key firmware modules:
- `firmware/src/cca/` — CC1101 driver, N81 codec, CRC-16, packet encoder, pairing engine
- `firmware/src/ccx/` — Spinel/HDLC NCP driver, CBOR encoder, IPv6/UDP TX, SMP DFU
- `firmware/src/net/` — lwIP Ethernet, TCP stream server (binary framing, multi-client)
- `firmware/src/shell/` — UART interactive shell with line editing and history
- `firmware/src/storage/` — Flash persistence (device IDs, Thread params)

### CLI

`cli/nucleo.ts` connects to Nucleo over **UDP** port 9433. Key abstractions:
- **Screen** (`cli/tui/screen.ts`) — VT100-based TUI with fixed header/status/input and scrollable packet table region
- **LineEditor** (`cli/tui/line-editor.ts`) — raw mode stdin with history, tab completion
- **PacketTable** (`cli/tui/table.ts`) — in-memory packet buffer with visible-line computation
- Packet identification via `identifyPacket()` from `protocol/protocol-ui.ts`

### CoAP Device Communication

CCX devices expose CoAP endpoints on Thread mesh (port 5683). Address via RLOC:
- `ccx coap get rloc:<RLOC16> <path>` — synchronous GET with response capture
- `ccx coap scan <rloc> <basePath>` — scan suffix A-Z with progress
- `ccx coap observe <rloc> <path>` — subscribe to notifications
- Device RLOCs from RA3: `ssh root@10.0.0.1 "zcat /var/log/ccx-diagnostics-log.0.gz | head -20"`
- Trim encoding uses level formula: `raw = percent * 0xFEFF / 100` (NOT `percent * 256 - 256`)
- Full protocol docs: `docs/protocols/ccx-coap.md`

### Stream Protocol (UDP :9433)

Binary framing: `[FLAGS:1][LEN:1][TS:4 LE][DATA:N]`. Host→STM32: `[CMD:1][LEN:1][DATA:N]`.
- `CMD 0x20` = text passthrough (shell command), response: `[0xFD][text]`
- `FLAGS 0x40` = CCX packet, `0x80` = TX echo, `0xFF` = heartbeat
- Firmware `printf()` in ccx_task goes to UART only — use `stream_broadcast_text()` for UDP clients

## Commands

```bash
# TypeScript tools (all run with tsx, no build step)
npx tsx cli/nucleo.ts               # Connect to Nucleo interactive shell
npx tsx tools/nucleo-cmd.ts "cmd"   # Scriptable one-shot command to Nucleo
npx tsx tools/codegen.ts            # Regenerate C headers from TS protocol defs
npx tsx tools/ccx-sniffer.ts --live # Sniff Thread traffic
npx tsx tools/leap-dump.ts          # Dump LEAP device hierarchy

# NPM script shortcuts
npm run codegen        # Regenerate C headers from TS protocol defs
npm run ccx:sniff      # Sniff Thread traffic
npm run ccx:send       # Send CCX commands
npm run leap:dump      # Dump LEAP hierarchy
npm run lint           # Biome linter (check)
npm run lint:fix       # Biome auto-fix
npm run format         # Biome formatter

# Firmware
cd firmware && cmake -B build -DCMAKE_TOOLCHAIN_FILE=cmake/arm-none-eabi.cmake && make -C build -j8
cd firmware && make flash      # OpenOCD + ST-LINK (NEVER use st-flash)
cd firmware && make test       # C++ unit tests (CRC, N81, decoder, CBOR)
cd firmware && make monitor    # Serial terminal to ST-LINK VCP (115200)
cd firmware && make format     # clang-format
cd firmware && make lint       # cppcheck
```

## Code Patterns

### TypeScript Tool Structure

All tools follow this pattern: `#!/usr/bin/env npx tsx` shebang, JSDoc header, imports, then `main()`. No CLI arg parsing library — tools use manual `process.argv.slice(2)` with helpers:
```typescript
const getArg = (name: string) => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : undefined; };
const hasFlag = (name: string) => args.includes(name);
```

Environment values load via `import { RA3_HOST } from "../lib/env"` (reads `.env` from project root, environment variables take precedence).

### CCX CBOR Encoding

`ccx/encoder.ts` uses a **custom minimal CBOR encoder** (not cbor-x) because CCX requires integer-keyed maps and `cbor-x` would stringify object keys. The decoder (`ccx/decoder.ts`) uses `cbor-x` since decoding doesn't have this issue. Messages are CBOR arrays `[msgType, body]` where body uses integer keys from `BodyKey` enum.

CCX sequence numbers persist to `.ccx-seq` file in project root to survive restarts.

### LEAP Client

`tools/leap-client.ts` provides `LeapConnection` class wrapping TLS with request/response pairing via auto-incrementing client tags (`lt-1`, `lt-2`, ...). Messages are newline-delimited JSON. Constructor takes an options object: `new LeapConnection({ host, certName })`.

The client auto-detects RA3 vs Caseta by probing the `/zone` endpoint — RA3 uses area-walk (`/area/{id}/associatedzone`), Caseta exposes zones directly.

Certificate paths are auto-resolved: tries `lutron-{certName}-{cert|key|ca}.pem` in the project root.

### CCX Config Loading

`ccx/config.ts` merges all `data/leap-*.json` files to build zone/device/serial/preset lookup tables. This means LEAP dump data drives CCX tool behavior (zone name resolution, device identification).

## Key Protocol Concepts

**OUTPUT vs DEVICE** is the fundamental architectural split in Lutron:
- **OUTPUT** = zone/load control with level + fade + delay (CCA format 0x0E, CCX type 0)
- **DEVICE** = component control like button presses (CCA pico packets, CCX type 1)

This split explains why pico set-level has no fade control — it uses the DEVICE path which lacks a fade field.

**CCA packet lengths**: type byte 0x80-0x9F = 24 bytes (22 data + 2 CRC), type 0xA0+ = 53 bytes (51 data + 2 CRC). Long packet padding uses 0x00.

**Level encoding**: `level16 = percent * 0xFEFF / 100` (shared across CCA and CCX).

**Fade encoding**: quarter-seconds (`byte = seconds * 4`), used in CCA format 0x0E byte 19 and CCX command key 3.

## Linting

Biome handles both linting and formatting. Config in `biome.json`:
- Scope: `cli/`, `tools/`, `ccx/`, `protocol/` (TypeScript only)
- 2-space indent, spaces not tabs
- Relaxed rules: `noExplicitAny` off, `noNonNullAssertion` off, `useTemplate` off, `useNodejsImportProtocol` off
- Pre-push hook (`.githooks/pre-push`) runs lint + typecheck — **CI must be green before push**
- `npx biome check --write cli/ tools/ ccx/ protocol/` — auto-fix formatting
- `npx tsc --noEmit` — type errors (strict mode, covers all TS files)

## CCX→WiZ Bridge

The bridge captures Lutron Thread traffic and forwards level/scene/button commands to WiZ smart bulbs.

### Deployment

- **Production**: HA local add-on at 10.0.0.4 — all config (pairings, Thread creds, warm dim) in HA UI
- **Dev/standalone**: `config/ccx-bridge.yaml` + Docker or local `npx tsx bridge/main.ts --serial`
- **Deploy script**: `./bridge/deploy-ha.sh /Volumes/config /Volumes/addons` (SMB to HA)
- LEAP data files go to `/config/ccx-bridge/` on HA (separate from add-on source)

### Key constraints

- Bridge is a **passive Thread sniffer** — NEVER suggest LEAP subscriptions/polling
- Sunnata/Darter devices are ALWAYS CCX (link type 40), never CCA
- nRF sniffer dongle crashes under burst load — 30s watchdog auto-reconnects
- Pi5 USB autosuspend kills dongle — `run.sh` disables it at boot

## Project Conventions

- **No Bun** — all tools use `npx tsx` (Node.js). No `Bun.*` APIs, no `import.meta.dir`
- **Add tests** for new modules, especially unattended code like bridge (`node --import tsx --test test/**/*.test.ts`)
- **NEVER use `st-flash`** — always use `make flash` (openocd) for STM32 programming

## Network Topology

| Host | IP | Purpose |
|------|-----|---------|
| RA3 processor | 10.0.0.1 | LEAP API, Thread network |
| Caseta | 10.0.0.2 | LEAP API |
| Nucleo | 10.0.0.3 | TCP:9433, CCA+CCX radio |
| Home Assistant | 10.0.0.4 | CCX→WiZ bridge add-on, SMB, SSH |
| Designer VM | 10.0.0.5 | UTM/NAT, key auth |

## Documentation

Docs are organized by topic under `docs/`: `protocols/`, `hardware/`, `security/`, `firmware-re/`, `infrastructure/`, `reference/`. See `docs/index.md` for the full table of contents.

## Environment Notes

- RTL-SDR captures use 2 MHz sample rate: `rtl_sdr -f 433602844 -s 2000000 -g 40 <output.bin>`
- CC1101 variable-length mode only captures packets matching its configured sync/length — use RTL-SDR to see everything
- Nucleo shell is on USART3 (ST-LINK VCP) — connect via serial terminal or use CLI text passthrough
