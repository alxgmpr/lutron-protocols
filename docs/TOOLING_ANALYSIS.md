# Tooling Analysis: What’s Used vs Unused

Analysis date: 2026-02-03. This document summarizes all scripts, CLIs, and tooling in the repo and whether they are referenced, documented, or likely unused.

---

## 1. Summary

| Category | Used (referenced + doc’d) | Documented only | Unreferenced / broken / stale |
|----------|----------------------------|-----------------|-------------------------------|
| **Node/npm** | packet-analyzer, record-vive-pairing, backend, web, cca codegen | — | Turbo workspaces, root lint/clean, tools/capture.ts |
| **Python** | esp32_controller, database, event_aggregator, packet_relay, udp_transport, lutron-tool | pairing_analyzer, compare_databases, extract_lutron_db | capture.py (broken paths) |
| **Other** | proxy (doc’d), esphome | — | Root `generated/` (legacy?), stale `rf/` paths |

---

## 2. By Area

### 2.1 Root / Monorepo (package.json, Turbo)

- **`npm run build` / `npm run dev` / `npm run test` / `npm run lint` / `npm run clean`**  
  All delegate to Turbo. Workspaces are `["rf/web", "proxy"]`. There is no `rf/web` (only `web/`), so only **proxy** is in the workspace. **web** and **backend** are not in workspaces.
- **Turbo:** Effectively only runs for **proxy**. Proxy has no `build`, `lint`, or `clean` scripts, so `npm run build` / `lint` / `clean` do nothing or fail. **Verdict:** Turbo and root scripts are misconfigured; web/backend are outside the monorepo.

### 2.2 Backends (two stacks)

- **Bun backend (`backend/`)**  
  - **Used.** Port 5001. Documented in CLAUDE.md, skills, packet-analyzer, record-vive-pairing.sh, tools/capture.ts.  
  - Start: `cd backend && bun run src/server.ts` (or `bun run dev`).

- **Python backend (`esp32_controller.py`)**  
  - **Used.** Port 8080. Started by `web/start-dev.sh` and referenced in .claude/settings. Imports: database, event_aggregator, packet_relay, udp_transport, and optionally `generated.python.cca_protocol`.  
  - So there are two parallel backends: Bun (5001) for modern CCA tooling; Python (8080) for the “CCA Playground” dev script.

### 2.3 Frontend

- **web/**  
  - **Used.** Vite + React. Uses `web/src/generated/protocol.ts` (hand-maintained). Not in npm workspaces (root has `rf/web`).  
  - Start: `cd web && npm run dev` or `npm run start` (start-dev.sh → Python backend + Vite).

### 2.4 Protocol / codegen

- **`cca codegen`**  
  - **Used.** Rust binary in `cca/`. Writes to `protocol/generated/`. Documented in CLAUDE.md, protocol/README.md, cca.yaml.  
  - Note: protocol/README says “rf/generated/”; actual output is `protocol/generated/`.

- **Root `generated/`**  
  - **Used by Python only.** `esp32_controller.py` does `from generated.python import cca_protocol`. No other code references root `generated/`. Protocol codegen writes to `protocol/generated/`; root `generated/` may be a copy or older output—sync story is unclear.

### 2.5 tools/

- **`tools/packet-analyzer.ts`**  
  - **Used.** Documented in CLAUDE.md, .claude/commands/cca.md, .claude/skills/cca.md, .claude/agents/cca-reverse-engineer.md. Uses backend API (default 5001). Run: `bun run tools/packet-analyzer.ts <cmd>`.

- **`tools/record-vive-pairing.sh`**  
  - **Used.** Documented in CLAUDE.md. Calls backend 5001, streams packets to JSONL. Run: `./tools/record-vive-pairing.sh [filename]`.

- **`tools/capture.ts`**  
  - **Unreferenced.** Only self-doc. Uses backend 5001 to capture packets to JSONL (Bun-based alternative to record-vive-pairing). Not mentioned in CLAUDE.md or README. **Verdict:** likely unused or redundant with record-vive-pairing.sh.

### 2.6 Python scripts (root and db/)

- **`capture.py`**  
  - **Broken / legacy.** References `esphome/pico-proxy-cc1101.yaml` and `ESP_DEVICE = "pico-trigger.local"`. Repo has `esphome/cca-proxy.yaml` only; no `pico-proxy-cc1101.yaml`. Writes to `captures/` (root). Not referenced in CLAUDE or README. **Verdict:** broken paths; either fix or retire.

- **`database.py`**  
  - **Used.** SQLite for CCA Playground. Imported by esp32_controller.py and event_aggregator.py. Not documented in CLAUDE/README.

- **`event_aggregator.py`**  
  - **Used.** Imported by esp32_controller.py. Not documented in CLAUDE/README.

- **`packet_relay.py`**  
  - **Used.** Imported by esp32_controller.py. Not documented in CLAUDE/README.

- **`udp_transport.py`**  
  - **Used.** Imported by esp32_controller.py. Not documented in CLAUDE/README.

- **`db/lutron-tool.py`**  
  - **Used.** Documented in README and docs/DATABASE_EDITING.md. Extract/pack .ra3/.hw project files.

- **`db/extract_lutron_db.py`**  
  - **Standalone, unreferenced.** Extracts .mdf/.ldf from .bkf. Only self-doc. Not in README or DATABASE_EDITING. **Verdict:** niche; document if keeping.

- **`db/compare_databases.py`**  
  - **Standalone, unreferenced.** Compares RA3/HW DBs. Only self-doc. **Verdict:** niche; document if keeping.

### 2.7 analysis/

- **`analysis/pairing_analyzer.py`**  
  - **Standalone, unreferenced.** Analyzes capture logs (pairing, timeline). Only self-doc. **Verdict:** useful for analysis; document if keeping.

- **`analysis/BRIDGE_DIMMER_PAIRING.md`**  
  - Analysis doc; references `captures/bridge_dimmer_pairing.log`. Not a runnable tool.

### 2.8 ccx/

- **`ccx/ccx_decoder.py`**  
  - **Referenced in docs only.** docs/CCX.md says “See ccx/ccx_decoder.py for a Python implementation.” No other code imports it. **Verdict:** doc’d reference; standalone decoder.

### 2.9 proxy/

- **proxy/**  
  - **Documented.** README and main README describe it as Designer API proxy. No other code depends on it. **Verdict:** separate use case; used when unlocking Designer features.

### 2.10 ESPHome

- **esphome/**  
  - **Used.** Documented in CLAUDE.md (/esphome skill). Config: `esphome/cca-proxy.yaml`. No `rf/esphome` or `pico-proxy-cc1101.yaml` at root.

### 2.11 Tests

- **`tests/test_esp32_parsing.py`**  
  - Imports `esp32_controller` (parse_packet_bytes, PACKET_TYPE_MAP). **Used** as test for Python stack.

---

## 3. Stale paths and config (`rf/`)

The repo used to use a top-level `rf/` directory. Current layout is flat (e.g. `cca/`, `web/`, `esphome/`). The following still reference `rf/` and are wrong or misleading:

- **package.json**  
  - `"workspaces": ["rf/web", "proxy"]` — should be `"web"` (or equivalent) if web is to be in the monorepo; `rf/web` does not exist.
- **README.md**  
  - “rf/cca/”, “rf/esphome/” — actual dirs are `cca/`, `esphome/`.
- **protocol/README.md**  
  - “Generated code lives in rf/generated/” — actual output is `protocol/generated/`; Python also uses root `generated/`.
- **.claude/settings.local.json**  
  - Paths like `rf/cca`, `rf/esp32_controller.py`, `rf/esphome`, `rf/web` — all invalid; should point to root `cca/`, `esp32_controller.py`, `esphome/`, `web/`.
- **docs/CCA.md**  
  - “rf/esphome/custom_components/lutron_cc1101/” — component lives under `esphome/custom_components/cc1101_cca/` (name differs).

Fixing these will reduce confusion and make Turbo/docs/skills point at real paths.

---

## 4. Recommendations

1. **Turbo / workspaces**  
   - Add `web` (and optionally `backend`) to `package.json` workspaces; remove or fix `rf/web`.  
   - Add `build` (and optionally `lint`/`clean`) to proxy and web so `npm run build` / `lint` / `clean` do something.

2. **Capture tooling**  
   - **capture.py:** Fix paths to use `esphome/cca-proxy.yaml` and correct device name, or mark deprecated and point to Bun backend + tools/capture.ts or record-vive-pairing.sh.  
   - **tools/capture.ts:** Either add to CLAUDE.md/README as the Bun-based capture option or remove if redundant with record-vive-pairing.sh.

3. **Documentation**  
   - Replace all `rf/` references with current paths (README, protocol/README, .claude/settings, docs/CCA.md).  
   - Optionally document in CLAUDE or README: database.py, event_aggregator, packet_relay, udp_transport (as part of Python CCA stack), and standalone tools: extract_lutron_db, compare_databases, pairing_analyzer, ccx_decoder.

4. **Root `generated/`**  
   - Clarify whether it’s produced by `cca codegen` (e.g. via a script or copy) or legacy. If it’s the canonical Python protocol, document that; if it’s legacy, consider migrating esp32_controller to `protocol/generated/python` and deprecating root `generated/`.

5. **Two backends**  
   - Document clearly: Bun backend (5001) for packet-analyzer, record-vive-pairing, capture.ts, and API; Python backend (8080) for start-dev.sh and CCA Playground. Decide whether to keep both long-term or consolidate.

---

## 5. Quick reference: “Used” vs “Unused / Broken / Niche”

**Used (referenced and/or documented):**  
backend (Bun), web, esp32_controller.py, database.py, event_aggregator.py, packet_relay.py, udp_transport.py, tools/packet-analyzer.ts, tools/record-vive-pairing.sh, cca codegen, db/lutron-tool.py, proxy, esphome, web/start-dev.sh, tests/test_esp32_parsing.py, protocol/generated/, root generated/python (by esp32_controller).

**Documented but not referenced by other code:**  
proxy, ccx_decoder.py (in CCX.md).

**Standalone / niche (only self-doc or single doc ref):**  
pairing_analyzer.py, compare_databases.py, extract_lutron_db.py.

**Unreferenced or broken:**  
tools/capture.ts (no docs), capture.py (broken paths), root Turbo workspaces and lint/clean, all `rf/` paths in config and docs.
