# Lutron Protocol Wiki Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure `docs/` from 52 fragmented files into a ~37-page protocol+device wiki, merging overlapping topics, moving attack-framed docs to the private `~/redacted-security-repo` repo, fixing stale content, and updating all inbound references.

**Architecture:** Reorganize along two axes — `protocols/` (wire protocols, with per-protocol subdirs) and `devices/` (one page per device family, hardware + firmware RE together) — plus `designer/`, `tooling/`, `reference/`. Use `git mv` to preserve history on straight renames; for merges, `git mv` the primary source then fold sibling docs in and `git rm` them. Update every inbound reference (README, CLAUDE.md, `.claude/skills/`, source comments) after files move. Verify with a link checker that no intra-doc or inbound link dangles.

**Tech Stack:** Markdown, git, bash/grep, Node.js (link-check one-liner). No build system changes.

---

## Reference Tables (used by multiple tasks)

### Table A — Straight renames (`git mv`, content edits happen in later tasks)

| Old path | New path |
|----------|----------|
| `docs/protocols/cca.md` | `docs/protocols/cca/index.md` |
| `docs/protocols/cca-pairing.md` | `docs/protocols/cca/pairing.md` |
| `docs/protocols/cca-tdma-beacon.md` | `docs/protocols/cca/tdma.md` |
| `docs/protocols/cca-rx-dispatch.md` | `docs/protocols/cca/rx-dispatch.md` |
| `docs/firmware-re/cca-end-devices.md` | `docs/protocols/cca/end-devices.md` |
| `docs/protocols/ccx.md` | `docs/protocols/ccx/index.md` |
| `docs/protocols/ccx-coap.md` | `docs/protocols/ccx/coap.md` |
| `docs/firmware-re/ble-commissioning.md` | `docs/protocols/ccx/commissioning.md` |
| `docs/protocols/leap.md` | `docs/protocols/leap/index.md` |
| `docs/firmware-re/leap-server.md` | `docs/protocols/leap/server-internals.md` |
| `docs/firmware-re/apk.md` | `docs/protocols/leap/api-discovery.md` |
| `docs/hardware/overview.md` | `docs/devices/index.md` |
| `docs/hardware/phoenix.md` | `docs/devices/ra3-processor.md` |
| `docs/hardware/rr-sel-rep2.md` | `docs/devices/radiora2-select-rep.md` |
| `docs/hardware/ra2-main-repeater.md` | `docs/devices/radiora2-main-rep.md` |
| `docs/firmware-re/powpak.md` | `docs/devices/powpak.md` |
| `docs/firmware-re/qsm.md` | `docs/devices/qsm.md` |
| `docs/firmware-re/esn.md` | `docs/devices/esn.md` |
| `docs/firmware-re/pd-3pcl.md` | `docs/devices/pd-3pcl.md` |
| `docs/firmware-re/grafik-eye.md` | `docs/devices/grafik-eye.md` |
| `docs/firmware-re/coproc.md` | `docs/devices/coprocessor-firmware.md` |
| `docs/firmware-re/wink-hub.md` | `docs/devices/wink-hub.md` |
| `docs/hardware/nucleo.md` | `docs/tooling/nucleo.md` |
| `docs/infrastructure/bridge.md` | `docs/tooling/ccx-wiz-bridge.md` |
| `docs/infrastructure/network.md` | `docs/tooling/network.md` |
| `docs/infrastructure/cloud-proxy.md` | `docs/tooling/cloud-proxy.md` |
| `docs/infrastructure/firmware-updates.md` | `docs/tooling/firmware-updates.md` |
| `docs/infrastructure/designer-db.md` | `docs/designer/database.md` |
| `docs/infrastructure/cycle-dim.md` | `docs/designer/cycle-dim.md` |

Unchanged paths (no move): `docs/protocols/ipl.md`, `docs/protocols/qslink.md`,
`docs/reference/dimming-curves.md`, `docs/reference/daylighting.md`,
`docs/reference/cca-event-loop.md`, `docs/reference/ccx-device-map.md`,
`docs/reference/training-notes-index.md`.

### Table B — Merges (primary `git mv`'d, siblings folded in then `git rm`'d)

| Target | Primary source | Folded-in siblings |
|--------|----------------|--------------------|
| `docs/protocols/cca/ota.md` | `docs/firmware-re/cca-ota-live-capture.md` | `docs/firmware-re/cca-ota-hcs08.md`, OTA-wire-protocol section of `docs/firmware-re/powpak.md` |
| `docs/devices/caseta-smartbridge.md` | `docs/firmware-re/caseta-smartbridge-dispatch.md` | `docs/firmware-re/caseta-smartbridge-coproc.md`, `docs/firmware-re/caseta-cca-ota.md` |
| `docs/devices/vive.md` | `docs/hardware/vive.md` | `docs/hardware/vive-processor.md`, `docs/hardware/vive-athena.md`, `docs/firmware-re/vive-ra2sel-device-firmware.md` |
| `docs/designer/ra3-hw-migration.md` | `docs/infrastructure/ra3-hw-migration.md` | `docs/infrastructure/ra3-hw-workflow.md` |
| `docs/tooling/bdm-recovery.md` | `docs/firmware-re/powpak-bdm-recovery.md` | new `tools/firmware/bdm-prog.py` documentation |

### Table C — Move out of repo (to `~/redacted-security-repo/docs-security/`)

| Source | Destination |
|--------|-------------|
| `docs/firmware-re/powpak-conversion-attack.md` | `~/redacted-security-repo/docs-security/powpak-conversion-attack.md` |
| `docs/hardware/grx-keypad/glitch-rig-wiring.md` | `~/redacted-security-repo/docs-security/grx-glitch-rig-wiring.md` |
| `docs/infrastructure/designer-universal-unlock.md` | `~/redacted-security-repo/docs-security/designer-universal-unlock.md` |
| `docs/infrastructure/designer-26.2-channel-fix.md` | `~/redacted-security-repo/docs-security/designer-26.2-channel-fix.md` |

### Table D — Delete

| Path | Reason |
|------|--------|
| `docs/firmware-re/powpak-recovery-resume.md` | Stale "resume prompt for next session", not reference material |

### Table E — Inbound reference rewrites (old doc path → new, applied across repo)

| Old reference string | New reference string |
|----------------------|----------------------|
| `docs/protocols/cca.md` | `docs/protocols/cca/index.md` |
| `docs/protocols/cca-pairing.md` | `docs/protocols/cca/pairing.md` |
| `docs/protocols/cca-tdma-beacon.md` | `docs/protocols/cca/tdma.md` |
| `docs/protocols/cca-rx-dispatch.md` | `docs/protocols/cca/rx-dispatch.md` |
| `docs/firmware-re/cca-end-devices.md` | `docs/protocols/cca/end-devices.md` |
| `docs/firmware-re/cca-ota-live-capture.md` | `docs/protocols/cca/ota.md` |
| `docs/firmware-re/cca-ota-hcs08.md` | `docs/protocols/cca/ota.md` |
| `docs/protocols/ccx.md` | `docs/protocols/ccx/index.md` |
| `docs/protocols/ccx-coap.md` | `docs/protocols/ccx/coap.md` |
| `docs/firmware-re/ble-commissioning.md` | `docs/protocols/ccx/commissioning.md` |
| `docs/protocols/leap.md` | `docs/protocols/leap/index.md` |
| `docs/firmware-re/leap-server.md` | `docs/protocols/leap/server-internals.md` |
| `docs/firmware-re/apk.md` | `docs/protocols/leap/api-discovery.md` |
| `docs/hardware/overview.md` | `docs/devices/index.md` |
| `docs/hardware/phoenix.md` | `docs/devices/ra3-processor.md` |
| `docs/hardware/rr-sel-rep2.md` | `docs/devices/radiora2-select-rep.md` |
| `docs/hardware/ra2-main-repeater.md` | `docs/devices/radiora2-main-rep.md` |
| `docs/firmware-re/powpak.md` | `docs/devices/powpak.md` |
| `docs/firmware-re/qsm.md` | `docs/devices/qsm.md` |
| `docs/firmware-re/esn.md` | `docs/devices/esn.md` |
| `docs/firmware-re/pd-3pcl.md` | `docs/devices/pd-3pcl.md` |
| `docs/firmware-re/grafik-eye.md` | `docs/devices/grafik-eye.md` |
| `docs/firmware-re/coproc.md` | `docs/devices/coprocessor-firmware.md` |
| `docs/firmware-re/wink-hub.md` | `docs/devices/wink-hub.md` |
| `docs/firmware-re/caseta-smartbridge-dispatch.md` | `docs/devices/caseta-smartbridge.md` |
| `docs/firmware-re/caseta-smartbridge-coproc.md` | `docs/devices/caseta-smartbridge.md` |
| `docs/firmware-re/caseta-cca-ota.md` | `docs/devices/caseta-smartbridge.md` |
| `docs/hardware/vive.md` | `docs/devices/vive.md` |
| `docs/hardware/vive-processor.md` | `docs/devices/vive.md` |
| `docs/hardware/vive-athena.md` | `docs/devices/vive.md` |
| `docs/firmware-re/vive-ra2sel-device-firmware.md` | `docs/devices/vive.md` |
| `docs/hardware/nucleo.md` | `docs/tooling/nucleo.md` |
| `docs/infrastructure/bridge.md` | `docs/tooling/ccx-wiz-bridge.md` |
| `docs/infrastructure/network.md` | `docs/tooling/network.md` |
| `docs/infrastructure/cloud-proxy.md` | `docs/tooling/cloud-proxy.md` |
| `docs/infrastructure/firmware-updates.md` | `docs/tooling/firmware-updates.md` |
| `docs/firmware-re/powpak-bdm-recovery.md` | `docs/tooling/bdm-recovery.md` |
| `docs/infrastructure/designer-db.md` | `docs/designer/database.md` |
| `docs/infrastructure/cycle-dim.md` | `docs/designer/cycle-dim.md` |
| `docs/infrastructure/ra3-hw-migration.md` | `docs/designer/ra3-hw-migration.md` |
| `docs/infrastructure/ra3-hw-workflow.md` | `docs/designer/ra3-hw-migration.md` |

References to moved-out docs (Table C) and the deleted doc (Table D) must be
rewritten to point at `~/redacted-security-repo/docs-security/...` or removed — handled
explicitly in Task 16.

---

## Task 1: Create directory skeleton and link-check helper

**Files:**
- Create: `docs/protocols/cca/`, `docs/protocols/ccx/`, `docs/protocols/leap/`, `docs/devices/`, `docs/designer/`, `docs/tooling/` (via the files placed in them; git tracks files not dirs)
- Create: `tools/docs/check-links.mjs`

- [ ] **Step 1: Write the link checker**

Create `tools/docs/check-links.mjs`:

```javascript
#!/usr/bin/env node
// Verifies every relative markdown link under docs/ resolves to an existing file.
// Usage: node tools/docs/check-links.mjs
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const ROOT = resolve(process.cwd(), "docs");
const linkRe = /\]\(([^)]+)\)/g;
let errors = 0;

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith(".md")) check(p);
  }
}

function check(file) {
  const text = readFileSync(file, "utf8");
  let m;
  while ((m = linkRe.exec(text))) {
    let target = m[1].trim();
    if (/^(https?:|mailto:|#|tel:)/.test(target)) continue; // external/anchor
    target = target.split("#")[0]; // strip anchor
    if (!target) continue;
    if (target.startsWith("/")) continue; // absolute filesystem refs (rare); skip
    const resolved = resolve(dirname(file), target);
    if (!existsSync(resolved)) {
      console.error(`BROKEN: ${file} -> ${m[1]}`);
      errors++;
    }
  }
}

walk(ROOT);
if (errors) {
  console.error(`\n${errors} broken link(s)`);
  process.exit(1);
}
console.log("All docs links resolve.");
```

- [ ] **Step 2: Run it against the current tree to establish a baseline**

Run: `node tools/docs/check-links.mjs`
Expected: PASS ("All docs links resolve.") — the current tree should already be
clean. If it reports pre-existing broken links, note them; they are not caused
by this work but should be fixed when their containing file is touched.

- [ ] **Step 3: Commit**

```bash
git add tools/docs/check-links.mjs
git commit -m "docs: add relative-link checker for wiki migration

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: Move attack-framed docs to the private repo

**Files:**
- Remove: the four docs in Table C
- Create (other repo): four docs under `~/redacted-security-repo/docs-security/`

- [ ] **Step 1: Copy each file into the private repo, then git rm here**

The private repo is a separate git repo, so `git mv` across repos is not
possible. Use plain copy + `git rm`:

```bash
cd ~/lutron-protocols
cp docs/firmware-re/powpak-conversion-attack.md      ~/redacted-security-repo/docs-security/powpak-conversion-attack.md
cp docs/hardware/grx-keypad/glitch-rig-wiring.md     ~/redacted-security-repo/docs-security/grx-glitch-rig-wiring.md
cp docs/infrastructure/designer-universal-unlock.md  ~/redacted-security-repo/docs-security/designer-universal-unlock.md
cp docs/infrastructure/designer-26.2-channel-fix.md  ~/redacted-security-repo/docs-security/designer-26.2-channel-fix.md

git rm docs/firmware-re/powpak-conversion-attack.md
git rm docs/hardware/grx-keypad/glitch-rig-wiring.md
git rm docs/infrastructure/designer-universal-unlock.md
git rm docs/infrastructure/designer-26.2-channel-fix.md
# grx-keypad/ is now empty; git tracks files only, nothing else to remove
```

- [ ] **Step 2: Commit the private repo**

```bash
cd ~/redacted-security-repo
git add docs-security/
git commit -m "docs: import attack-framed docs from lutron-protocols wiki split

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 3: Commit the removal in this repo**

```bash
cd ~/lutron-protocols
git commit -m "docs: move attack-framed docs to private redacted-security-repo repo

Conversion attack, GRX glitch rig, and Designer IL-patch docs relocated to
~/redacted-security-repo/docs-security/. This repo keeps only protocol/hardware
interoperability research.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

Note: inbound references to these moved docs are fixed in Task 16, not here.

---

## Task 3: Delete the stale resume-prompt doc

**Files:**
- Remove: `docs/firmware-re/powpak-recovery-resume.md`

- [ ] **Step 1: Remove it**

```bash
git rm docs/firmware-re/powpak-recovery-resume.md
```

- [ ] **Step 2: Commit**

```bash
git commit -m "docs: remove stale powpak-recovery-resume session prompt

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: Rename CCA protocol pages into protocols/cca/

**Files:** see Table A rows for CCA.

- [ ] **Step 1: git mv the CCA pages**

```bash
git mv docs/protocols/cca.md             docs/protocols/cca/index.md
git mv docs/protocols/cca-pairing.md     docs/protocols/cca/pairing.md
git mv docs/protocols/cca-tdma-beacon.md docs/protocols/cca/tdma.md
git mv docs/protocols/cca-rx-dispatch.md docs/protocols/cca/rx-dispatch.md
git mv docs/firmware-re/cca-end-devices.md docs/protocols/cca/end-devices.md
```

- [ ] **Step 2: Fix intra-CCA relative links**

These pages linked to each other and to siblings with old relative paths
(e.g. `[pairing](cca-pairing.md)`, `[QS Link](qslink.md)`,
`[firmware](../../firmware/src/...)`). The directory depth changed (now one
level deeper), so `../../` code links become `../../../`, and sibling links
lose the `cca-` prefix. Open each of the five moved files and rewrite:
- Links to other CCA pages: `cca-pairing.md` → `pairing.md`, `cca.md` → `index.md`, `cca-tdma-beacon.md` → `tdma.md`, `cca-rx-dispatch.md` → `rx-dispatch.md`, `cca-end-devices.md` → `end-devices.md`.
- Links to `qslink.md`/`ipl.md` (now `../qslink.md`, `../ipl.md`).
- Links to other protocols: `ccx.md` → `../ccx/index.md`, `leap.md` → `../leap/index.md`.
- Code links: add one `../` level (e.g. `../../firmware/...` → `../../../firmware/...`, `../../protocol/...` → `../../../protocol/...`).
- Links into firmware-re / hardware that move later: use the final Table E target (e.g. `../firmware-re/powpak.md` → `../../devices/powpak.md`).

- [ ] **Step 3: Run link check**

Run: `node tools/docs/check-links.mjs`
Expected: PASS. (Links from other not-yet-moved files into these CCA files will
be fixed when those files move or in Task 16; the checker validates outbound
links per file, so fix any BROKEN lines that originate from the five files you
just edited.)

- [ ] **Step 4: Commit**

```bash
git add docs/protocols/cca docs/firmware-re
git commit -m "docs: regroup CCA protocol pages under protocols/cca/

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: Build protocols/cca/ota.md (merge)

**Files:**
- Target: `docs/protocols/cca/ota.md`
- Sources: `docs/firmware-re/cca-ota-live-capture.md` (primary), `docs/firmware-re/cca-ota-hcs08.md`, OTA-wire section of `docs/devices/powpak.md` (powpak is moved in Task 9; if running out of order, read from `docs/firmware-re/powpak.md`)

- [ ] **Step 1: Seed the target with the primary, preserving history**

```bash
git mv docs/firmware-re/cca-ota-live-capture.md docs/protocols/cca/ota.md
```

- [ ] **Step 2: Read both sibling sources and the powpak OTA section**

Read `docs/firmware-re/cca-ota-hcs08.md` in full and the section(s) of
`docs/firmware-re/powpak.md` (or `docs/devices/powpak.md` if Task 9 ran first)
that describe the OTA wire protocol — sync word FADE, CRC 0xCA0F, opcode set,
BeginTransfer / TransferData / ChangeAddressOffset framing, and the 35-row
table.

- [ ] **Step 3: Rewrite ota.md as a single canonical OTA reference**

Produce one page with this section outline (write real prose from the sources,
do not leave placeholders):
1. **Summary** — one paragraph: CCA OTA is a single-channel (~433.566 MHz,
   ~80 kHz BW) transfer; same wire protocol across EFR32 (Caseta) and HCS08
   (PowPak/HW-CCA) targets.
2. **Channel parameters** — from the live capture (frequency, deviation,
   bandwidth, data rate), with the 2026-04-28 spectrogram evidence.
3. **Wire format** — sync word, framing, CRC-16 0xCA0F, opcode set, the
   BeginTransfer/TransferData/ChangeAddressOffset sequence.
4. **Force-trigger procedure** — DB spoof + leap-server bounce + app button
   (from the live-capture doc).
5. **HCS08 specifics** — bootloader differences, FREQ registers, and the
   corrected interpretation of the 35-row table (NOT a frequency-hop table;
   single-channel was confirmed empirically — it is a calibration/retry LUT).
6. **Cross-references** — link `../../devices/powpak.md`,
   `../../devices/caseta-smartbridge.md`, `index.md`.

Use the final Table E paths for all links and the correct relative depth
(`protocols/cca/ota.md` → devices is `../../devices/...`).

- [ ] **Step 4: Remove the merged sibling**

```bash
git rm docs/firmware-re/cca-ota-hcs08.md
```

(The powpak OTA-wire section stays in `powpak.md` only as a short pointer to
`ota.md`; trim it down in Task 9.)

- [ ] **Step 5: Run link check**

Run: `node tools/docs/check-links.mjs`
Expected: PASS for outbound links from `ota.md`.

- [ ] **Step 6: Commit**

```bash
git add docs/protocols/cca/ota.md docs/firmware-re/cca-ota-hcs08.md
git commit -m "docs: merge CCA OTA capture + HCS08 adaptation into protocols/cca/ota.md

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 6: Regroup CCX protocol pages under protocols/ccx/

**Files:** see Table A rows for CCX.

- [ ] **Step 1: git mv**

```bash
git mv docs/protocols/ccx.md          docs/protocols/ccx/index.md
git mv docs/protocols/ccx-coap.md     docs/protocols/ccx/coap.md
git mv docs/firmware-re/ble-commissioning.md docs/protocols/ccx/commissioning.md
```

- [ ] **Step 2: Neutralize attack framing in commissioning.md**

Open `docs/protocols/ccx/commissioning.md`. Reframe security-charged language
to neutral protocol-RE description:
- Replace phrasing like "best attack surface" / "OOB without authentication"
  framed as an exploit with factual description: "The commissioning channel
  accepts the Thread network key over TLS-in-GATT; the iOS app does not
  validate the device certificate (`acceptInvalidCerts`), so the channel is
  authenticated only by physical proximity / out-of-band pairing."
- Keep all protocol facts (HDLC framing, GATTTLSManager flow, NMK delivery).
- Remove any step-by-step that reads as an exploitation recipe; keep the
  protocol description.

- [ ] **Step 3: Fix relative links in the three moved files**

Adjust depth and Table E targets (same rules as Task 4 Step 2): CCX pages now
live at `protocols/ccx/`; code links gain one `../`; cross-protocol links use
`../cca/index.md`, `../leap/index.md`, `../qslink.md`.

- [ ] **Step 4: Run link check**

Run: `node tools/docs/check-links.mjs`
Expected: PASS for outbound links from the three files.

- [ ] **Step 5: Commit**

```bash
git add docs/protocols/ccx docs/firmware-re
git commit -m "docs: regroup CCX pages under protocols/ccx/, neutralize commissioning framing

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 7: Regroup LEAP pages under protocols/leap/

**Files:** see Table A rows for LEAP.

- [ ] **Step 1: git mv**

```bash
git mv docs/protocols/leap.md           docs/protocols/leap/index.md
git mv docs/firmware-re/leap-server.md  docs/protocols/leap/server-internals.md
git mv docs/firmware-re/apk.md          docs/protocols/leap/api-discovery.md
```

- [ ] **Step 2: Fix relative links in the three moved files**

Same rules as Task 4 Step 2. Note `server-internals.md` references
`data/firmware-re/leap-routes.json` and `data/firmware-re/leap-types.json` —
those are repo-root-relative; from `protocols/leap/` the link is
`../../../data/firmware-re/leap-routes.json`. `api-discovery.md` cross-links the
live-probed endpoints in `index.md` (now `index.md`, same dir).

- [ ] **Step 3: Run link check**

Run: `node tools/docs/check-links.mjs`
Expected: PASS for the three files.

- [ ] **Step 4: Commit**

```bash
git add docs/protocols/leap docs/firmware-re
git commit -m "docs: regroup LEAP pages under protocols/leap/

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 8: Straight-rename device pages into devices/

**Files:** Table A rows targeting `docs/devices/` that are NOT merges
(ra3-processor, radiora2-select-rep, radiora2-main-rep, qsm, esn, pd-3pcl,
grafik-eye, coprocessor-firmware, wink-hub, and `devices/index.md`).

- [ ] **Step 1: git mv**

```bash
git mv docs/hardware/overview.md          docs/devices/index.md
git mv docs/hardware/phoenix.md           docs/devices/ra3-processor.md
git mv docs/hardware/rr-sel-rep2.md       docs/devices/radiora2-select-rep.md
git mv docs/hardware/ra2-main-repeater.md docs/devices/radiora2-main-rep.md
git mv docs/firmware-re/qsm.md            docs/devices/qsm.md
git mv docs/firmware-re/esn.md            docs/devices/esn.md
git mv docs/firmware-re/pd-3pcl.md        docs/devices/pd-3pcl.md
git mv docs/firmware-re/grafik-eye.md     docs/devices/grafik-eye.md
git mv docs/firmware-re/coproc.md         docs/devices/coprocessor-firmware.md
git mv docs/firmware-re/wink-hub.md       docs/devices/wink-hub.md
```

- [ ] **Step 2: Fix relative links in each moved file**

For every file moved above, rewrite outbound links to Table E targets and the
correct depth (`devices/` is one level under `docs/`; code links use `../../`).
`devices/index.md` (was hardware/overview) links to many device pages — point
them at the new `devices/*.md` siblings. `radiora2-select-rep.md` should
cross-link `caseta-smartbridge.md` (shared STM32 coproc).

- [ ] **Step 3: Run link check**

Run: `node tools/docs/check-links.mjs`
Expected: PASS for the moved files.

- [ ] **Step 4: Commit**

```bash
git add docs/devices docs/hardware docs/firmware-re
git commit -m "docs: move device + firmware-RE pages into unified devices/ axis

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 9: Move powpak.md and trim its OTA section

**Files:**
- Move: `docs/firmware-re/powpak.md` → `docs/devices/powpak.md`

- [ ] **Step 1: git mv**

```bash
git mv docs/firmware-re/powpak.md docs/devices/powpak.md
```

- [ ] **Step 2: Trim the OTA-wire-protocol section**

In `docs/devices/powpak.md`, replace the detailed OTA wire-protocol section
(sync FADE / CRC 0xCA0F / opcode set / 35-row table narrative) with a 2–3
sentence summary plus a link: "Full CCA OTA wire protocol — channel
parameters, framing, and the corrected single-channel finding — is documented
in [protocols/cca/ota.md](../protocols/cca/ota.md)." Keep PowPak-specific RE
(DeviceClass at 0x8AD, LDF format, CC1101 init table, bootloader) in this page.

- [ ] **Step 3: Fix remaining relative links and code links (add `../`/Table E targets)**

- [ ] **Step 4: Run link check**

Run: `node tools/docs/check-links.mjs`
Expected: PASS for `powpak.md`.

- [ ] **Step 5: Commit**

```bash
git add docs/devices/powpak.md docs/protocols/cca/ota.md
git commit -m "docs: move powpak.md to devices/, point OTA detail at protocols/cca/ota.md

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 10: Build devices/caseta-smartbridge.md (merge)

**Files:**
- Target: `docs/devices/caseta-smartbridge.md`
- Sources: `caseta-smartbridge-dispatch.md` (primary), `caseta-smartbridge-coproc.md`, `caseta-cca-ota.md`

- [ ] **Step 1: Seed target from primary**

```bash
git mv docs/firmware-re/caseta-smartbridge-dispatch.md docs/devices/caseta-smartbridge.md
```

- [ ] **Step 2: Read the two siblings**

Read `docs/firmware-re/caseta-smartbridge-coproc.md` (firmware extraction,
cipher variant key0=0x29) and `docs/firmware-re/caseta-cca-ota.md` (OTA
orchestration, trigger path, cloud-vs-on-device gating, firmware manifest).

- [ ] **Step 3: Rewrite as one device page**

Section outline:
1. **Hardware** — STM32 coprocessor on the Caseta SmartBridge (note shared
   platform with RA2 Select REP2 → link `radiora2-select-rep.md`).
2. **Firmware extraction** — updater binary, the three extracted images, S19
   pipeline, cipher variant (key0=0x29, continuous, no per-record reset) vs
   the Phoenix cipher.
3. **Dispatch & IPC** — RX state machine, IPC command table, HDLC IPC chain
   comparison vs Phoenix; note OTA framing present in TX only (dead RX path).
4. **CCA OTA orchestration** — who triggers OTA, JSON IPC,
   `platform_manager_wrapper.sh`, cloud-vs-on-device gating, manifest format.
   Cross-link `../protocols/cca/ota.md` for the wire format.

- [ ] **Step 4: Remove merged siblings**

```bash
git rm docs/firmware-re/caseta-smartbridge-coproc.md docs/firmware-re/caseta-cca-ota.md
```

- [ ] **Step 5: Run link check**

Run: `node tools/docs/check-links.mjs`
Expected: PASS for `caseta-smartbridge.md`.

- [ ] **Step 6: Commit**

```bash
git add docs/devices/caseta-smartbridge.md docs/firmware-re
git commit -m "docs: merge Caseta SmartBridge coproc/dispatch/OTA into one device page

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 11: Build devices/vive.md (merge)

**Files:**
- Target: `docs/devices/vive.md`
- Sources: `hardware/vive.md` (primary), `hardware/vive-processor.md`, `hardware/vive-athena.md`, `firmware-re/vive-ra2sel-device-firmware.md`

- [ ] **Step 1: Seed target from primary**

```bash
git mv docs/hardware/vive.md docs/devices/vive.md
```

- [ ] **Step 2: Read the three siblings**

`vive-processor.md` (Vive.app binary RE — legacy app uses generic HTTP, not
LEAP), `vive-athena.md` (unified app v26 adds Athena + LEAP support),
`vive-ra2sel-device-firmware.md` (device firmware notes).

- [ ] **Step 3: Rewrite as one device page**

Section outline:
1. **Hardware teardown** — AM335x + STM32L100 + CC110L, eMMC partitions, key
   binaries, EEPROM, WiFi/mDNS.
2. **Application evolution** — legacy Vive.app (generic HTTP routes, not LEAP)
   → unified v26 app exposing Athena + LEAP (`VAL_SYSTEM_TYPE_ATHENA`, LEAP
   route families). Present as a clear legacy-vs-current narrative.
3. **Device firmware** — the RA2 Select device-firmware notes.

- [ ] **Step 4: Remove merged siblings**

```bash
git rm docs/hardware/vive-processor.md docs/hardware/vive-athena.md docs/firmware-re/vive-ra2sel-device-firmware.md
```

- [ ] **Step 5: Run link check**

Run: `node tools/docs/check-links.mjs`
Expected: PASS for `vive.md`.

- [ ] **Step 6: Commit**

```bash
git add docs/devices/vive.md docs/hardware docs/firmware-re
git commit -m "docs: merge Vive hardware + app evolution + device firmware into one page

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 12: Designer section (move + merge)

**Files:**
- Move: `designer-db.md` → `designer/database.md`, `cycle-dim.md` → `designer/cycle-dim.md`
- Merge: `ra3-hw-migration.md` (primary) + `ra3-hw-workflow.md` → `designer/ra3-hw-migration.md`
- Create: `designer/index.md`

- [ ] **Step 1: git mv the straight moves and the merge primary**

```bash
git mv docs/infrastructure/designer-db.md      docs/designer/database.md
git mv docs/infrastructure/cycle-dim.md        docs/designer/cycle-dim.md
git mv docs/infrastructure/ra3-hw-migration.md docs/designer/ra3-hw-migration.md
```

- [ ] **Step 2: Fold the workflow doc into the migration page**

Read `docs/infrastructure/ra3-hw-workflow.md`. Append/integrate its content
into `docs/designer/ra3-hw-migration.md` under a clear section split:
- **Full migration** (processor identity injection: serial/MAC/certs, link
  credentials, save-trick) — from `ra3-hw-migration.md`.
- **ID-only switch workflow** (RRST/RRD/RR ↔ HRST/HQRD/HQR, validation gates,
  rollback, the 2026-02-19 incident log) — from `ra3-hw-workflow.md`.
- A short "Which do I use?" note at the top distinguishing the two.

Then remove the workflow source:

```bash
git rm docs/infrastructure/ra3-hw-workflow.md
```

- [ ] **Step 3: Create designer/index.md hub**

Write `docs/designer/index.md`: one short paragraph on what Designer is (the
Lutron commissioning app, VM at the configured IP) and a bullet list linking
`database.md`, `ra3-hw-migration.md`, `cycle-dim.md`. Note that DLL-patch /
jailbreak material lives in the private `~/redacted-security-repo` repo.

- [ ] **Step 4: Fix relative links in the moved/merged files (depth + Table E)**

- [ ] **Step 5: Run link check**

Run: `node tools/docs/check-links.mjs`
Expected: PASS for the designer/ files.

- [ ] **Step 6: Commit**

```bash
git add docs/designer docs/infrastructure
git commit -m "docs: build designer/ section, merge RA3<->HW migration + workflow

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 13: Tooling section straight moves

**Files:** nucleo, ccx-wiz-bridge, network, cloud-proxy, firmware-updates.

- [ ] **Step 1: git mv**

```bash
git mv docs/hardware/nucleo.md                docs/tooling/nucleo.md
git mv docs/infrastructure/bridge.md          docs/tooling/ccx-wiz-bridge.md
git mv docs/infrastructure/network.md         docs/tooling/network.md
git mv docs/infrastructure/cloud-proxy.md     docs/tooling/cloud-proxy.md
git mv docs/infrastructure/firmware-updates.md docs/tooling/firmware-updates.md
```

- [ ] **Step 2: Fix relative links (depth + Table E) in each moved file**

`network.md` is wide-ranging and references many topics — point its links at
the new protocol/device/designer targets. `firmware-updates.md` and
`cloud-proxy.md` cross-reference each other (same dir now) and the device
firmware pages.

- [ ] **Step 3: Run link check**

Run: `node tools/docs/check-links.mjs`
Expected: PASS for tooling/ files.

- [ ] **Step 4: Commit**

```bash
git add docs/tooling docs/hardware docs/infrastructure
git commit -m "docs: move nucleo, bridge, network, cloud-proxy, firmware-updates into tooling/

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 14: Build tooling/bdm-recovery.md (merge + new tool docs)

**Files:**
- Target: `docs/tooling/bdm-recovery.md`
- Primary: `docs/firmware-re/powpak-bdm-recovery.md`
- New content: documentation for `tools/firmware/bdm-prog.py`

- [ ] **Step 1: Seed target from primary**

```bash
git mv docs/firmware-re/powpak-bdm-recovery.md docs/tooling/bdm-recovery.md
```

- [ ] **Step 2: Read the new tool to document it accurately**

Read `tools/firmware/bdm-prog.py` (added in commit 3554245). Confirm: USBDM USB
protocol via pyusb, target MC9S08QE128, USBDM hardware VID 0x16D0/PID 0x0567,
subcommands `probe` / `erase` / `program FILE` / `read ADDR LEN` / `dump FILE`,
and the known SYNC_TIMEOUT-on-connect issue.

- [ ] **Step 3: Add a "Software: bdm-prog.py" section**

In `docs/tooling/bdm-recovery.md`, after the hardware-wiring content, add a
section documenting the tool:
- Purpose: speak the USBDM USB protocol directly (no GUI) to recover a bricked
  HCS08 PowPak.
- Invocation examples using `uv run` per project convention:
  - `uv run tools/firmware/bdm-prog.py probe`
  - `uv run tools/firmware/bdm-prog.py erase`
  - `uv run tools/firmware/bdm-prog.py program firmware.s19`
  - `uv run tools/firmware/bdm-prog.py read 0x8000 256`
  - `uv run tools/firmware/bdm-prog.py dump flash.bin`
- Hardware: USBDM programmer (VID 0x16D0 / PID 0x0567), target MC9S08QE128.
- Known issue: SYNC_TIMEOUT on connect — likely insufficient USB-only power
  (needs mains) or BKGD test-point misidentification; cross-link the wiring
  section.

- [ ] **Step 4: Fix relative links (depth + Table E); cross-link `../devices/powpak.md`**

- [ ] **Step 5: Run link check**

Run: `node tools/docs/check-links.mjs`
Expected: PASS for `bdm-recovery.md`.

- [ ] **Step 6: Commit**

```bash
git add docs/tooling/bdm-recovery.md docs/firmware-re
git commit -m "docs: move BDM recovery to tooling/, document bdm-prog.py USBDM programmer

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 15: Fix repo-rename stale paths inside docs

**Files:** any doc still referencing `lutron-tools`.

- [ ] **Step 1: Find remaining references**

Run: `grep -rn "lutron-tools" docs/ --include="*.md"`
Expected: hits in (at least) `docs/devices/powpak.md`,
`docs/protocols/cca/ota.md` or its lineage, `docs/protocols/ccx/index.md`,
`docs/superpowers/plans/*` and `docs/superpowers/specs/*`.

- [ ] **Step 2: Rewrite the paths**

Replace:
- `/Users/alex/.claude/projects/-Users-alex-lutron-tools/memory/` → `/Users/alex/.claude/projects/-Users-alex-lutron-protocols/memory/`
- `/Volumes/Secondary/lutron-tools/` → `/Volumes/Secondary/lutron-protocols/` (verify the volume path still exists; if the captures volume is gone, reword to "gitignored capture volume" without a hardcoded path)
- `~/lutron-tools/src/...` and `cd lutron-tools/src` → `~/lutron-protocols/src/...` / `cd lutron-protocols/src`

Leave `docs/superpowers/` plan/spec files' historical worktree paths as-is ONLY
if they are clearly historical logs; otherwise update the memory/volume paths
there too. Do not rewrite the legitimately-historical external corpus reference
`xmocxd/lutron-training-notes`.

- [ ] **Step 3: Verify no stray references remain (except intended historical ones)**

Run: `grep -rn "lutron-tools" docs/ --include="*.md"`
Expected: only `xmocxd/lutron-training-notes` style external references, if any.

- [ ] **Step 4: Commit**

```bash
git add docs/
git commit -m "docs: fix lutron-tools -> lutron-protocols stale paths after repo rename

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 16: Update inbound references across the repo

**Files:** `README.md`, `CLAUDE.md`, `.claude/skills/*/SKILL.md`, and source
comments in `firmware/src/`, `tools/`, `lib/`, `protocol/`.

- [ ] **Step 1: Apply Table E rewrites repo-wide (outside docs/)**

For each Table E row, replace old → new across non-docs files. Use a scripted
loop (review the diff before committing):

```bash
cd ~/lutron-protocols
# Example for one mapping; repeat for every Table E row.
grep -rl "docs/firmware-re/leap-server.md" --include="*.ts" --include="*.h" --include="*.cpp" --include="*.md" --include="*.json" \
  README.md CLAUDE.md .claude lib tools protocol firmware/src \
  | xargs sed -i '' 's#docs/firmware-re/leap-server.md#docs/protocols/leap/server-internals.md#g'
```

Mappings to apply (from Table E) hit these known files (from survey):
- `README.md` → `docs/index.md` (path unchanged; verify only).
- `CLAUDE.md` → `docs/protocols/ccx-coap.md` becomes `docs/protocols/ccx/coap.md`; `docs/infrastructure/designer-universal-unlock.md` is MOVED OUT → rewrite to `~/redacted-security-repo/docs-security/designer-universal-unlock.md`; `docs/index.md` unchanged.
- `.claude/skills/cca-protocol/SKILL.md` → `docs/protocols/cca.md`→`docs/protocols/cca/index.md`, `docs/firmware-re/qsm.md`→`docs/devices/qsm.md`, `docs/protocols/qslink.md` unchanged.
- `.claude/skills/designer-feature-flags/SKILL.md` and `.claude/skills/designer-re/SKILL.md` → `docs/infrastructure/designer-universal-unlock.md` is MOVED OUT → rewrite to `~/redacted-security-repo/docs-security/designer-universal-unlock.md`.
- `.claude/skills/s19-firmware-re/SKILL.md` → `docs/firmware-re/qsm.md`→`docs/devices/qsm.md`, `docs/firmware-re/esn.md`→`docs/devices/esn.md`, `docs/protocols/cca.md`→`docs/protocols/cca/index.md`, `docs/infrastructure/firmware-updates.md`→`docs/tooling/firmware-updates.md`.
- `firmware/src/cca/cca_ota_tx.h` → `docs/firmware-re/cca-ota-live-capture.md`→`docs/protocols/cca/ota.md`; `docs/firmware-re/powpak-conversion-attack.md` is MOVED OUT → rewrite to `~/redacted-security-repo/docs-security/powpak-conversion-attack.md`.
- `tools/firmware/bdm-recovery.sh` → `docs/firmware-re/powpak-bdm-recovery.md`→`docs/tooling/bdm-recovery.md`.
- `tools/firmware/ldf-extract.py`, `lib/ldf.ts`, `lib/cca-ota-codec.ts` → `docs/firmware-re/powpak.md`→`docs/devices/powpak.md`.
- `tools/firmware/pff-parse.ts` → `docs/firmware-re/coproc.md`→`docs/devices/coprocessor-firmware.md`.
- `tools/ccx/ccx-device-map.ts` → `docs/reference/ccx-device-map.md` unchanged (verify).
- `tools/cca/ota-extract.ts`, `tools/cca/rtlsdr-ota-decode.ts`, `lib/cca-ota-tx-builder.ts`, `lib/cca-ota-demod.ts`, `protocol/cca.protocol.ts` → `docs/firmware-re/cca-ota-live-capture.md`→`docs/protocols/cca/ota.md`; `lib/cca-ota-demod.ts` and `lib/cca-ota-codec.ts` also `docs/protocols/cca.md`→`docs/protocols/cca/index.md`.
- `tools/cca/ota-tx.ts` → `docs/firmware-re/cca-ota-hcs08.md`→`docs/protocols/cca/ota.md`; `docs/firmware-re/powpak-conversion-attack.md` MOVED OUT → `~/redacted-security-repo/docs-security/powpak-conversion-attack.md`.
- `tools/cca/ota-upload.ts` → `docs/firmware-re/powpak-conversion-attack.md` MOVED OUT → `~/redacted-security-repo/docs-security/powpak-conversion-attack.md`.
- `tools/ipl/ipl-cmd.ts`, `lib/ipl.ts` → `docs/protocols/ipl.md` unchanged (verify).
- `lib/leap-client.ts` → `docs/firmware-re/leap-server.md`→`docs/protocols/leap/server-internals.md`.
- `lib/bridge-core.ts` → `docs/infrastructure/bridge.md`→`docs/tooling/ccx-wiz-bridge.md`.
- `lib/ccx-coap.ts` → `docs/protocols/ccx-coap.md`→`docs/protocols/ccx/coap.md`.
- `protocol/cca.protocol.ts` → also references `docs/wink-hub-firmware-findings.md` (a path that does not exist) → rewrite to `docs/devices/wink-hub.md`.
- `data/integration-ids-10.1.1.133.json` → `docs/infrastructure/designer-db.md`→`docs/designer/database.md`.

- [ ] **Step 2: Verify no non-docs file references an old docs path**

Run:
```bash
grep -rn -E "docs/(protocols/cca\.md|protocols/cca-|protocols/ccx\.md|protocols/ccx-coap\.md|firmware-re/|hardware/|infrastructure/)" \
  README.md CLAUDE.md .claude lib tools protocol firmware/src data 2>/dev/null
```
Expected: no output (every old path rewritten). Investigate and fix any hit.

- [ ] **Step 3: Update CLAUDE.md prose if needed**

CLAUDE.md's "Documentation" section says security research lives in
`~/redacted-security-repo`. Confirm that statement is still accurate and that the
inline `docs/...` references it makes now resolve. Adjust wording if a
referenced doc moved out of repo.

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md .claude lib tools protocol firmware/src data
git commit -m "docs: update inbound references after wiki restructure

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 17: Rebuild docs/index.md

**Files:**
- Rewrite: `docs/index.md`

- [ ] **Step 1: Enumerate the final tree**

Run: `find docs -name '*.md' -not -path 'docs/superpowers/*' | sort`
Use this as the authoritative page list (every page must appear in the index —
the old index omitted 14 files).

- [ ] **Step 2: Write the new index**

Rewrite `docs/index.md` as the wiki home, grouped to match the new structure,
with a one-line description per page:
- **Protocols** — CCA (index, pairing, tdma, rx-dispatch, ota, end-devices),
  CCX (index, coap, commissioning), LEAP (index, server-internals,
  api-discovery), QS Link, IPL.
- **Devices** — index (RF overview), ra3-processor, caseta-smartbridge, vive,
  radiora2-select-rep, radiora2-main-rep, powpak, qsm, esn, pd-3pcl,
  grafik-eye, coprocessor-firmware, wink-hub.
- **Designer** — index, database, ra3-hw-migration, cycle-dim.
- **Tooling** — nucleo, bdm-recovery, ccx-wiz-bridge, network, cloud-proxy,
  firmware-updates.
- **Reference** — dimming-curves, daylighting, cca-event-loop, ccx-device-map,
  training-notes-index.

Use relative links from `docs/index.md` (e.g. `protocols/cca/index.md`). Add a
short top paragraph noting that exploit/jailbreak material lives in the private
`~/redacted-security-repo` repo.

- [ ] **Step 3: Run link check**

Run: `node tools/docs/check-links.mjs`
Expected: PASS, and every link in index.md resolves.

- [ ] **Step 4: Commit**

```bash
git add docs/index.md
git commit -m "docs: rebuild index as comprehensive wiki home for new structure

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 18: Standardize page headers and final verification

**Files:** all pages under `docs/protocols/`, `docs/devices/`,
`docs/designer/`, `docs/tooling/`, `docs/reference/`.

- [ ] **Step 1: Apply a consistent header to each page**

For each wiki page, ensure the top has: an H1 title, a one-line italic summary,
and (where applicable) a short "Sources" / "Source of truth" line linking the
authoritative code (`protocol/*.protocol.ts`, firmware, tools). Do not rewrite
body content — this is a light, mechanical pass. Skip `docs/superpowers/`.

- [ ] **Step 2: Verify empty directories are gone**

Run:
```bash
find docs/firmware-re docs/hardware docs/infrastructure -type f 2>/dev/null
```
Expected: no output (all files migrated). If any remain, they were missed —
move them to their Table A/B destination. Remove now-empty
`docs/hardware/grx-keypad/` implicitly (git tracks files; nothing to do).

- [ ] **Step 3: Full link check**

Run: `node tools/docs/check-links.mjs`
Expected: PASS ("All docs links resolve.").

- [ ] **Step 4: Confirm no dangling references anywhere**

Run:
```bash
grep -rn -E "docs/(firmware-re|hardware|infrastructure)/" \
  README.md CLAUDE.md .claude lib tools protocol firmware/src data docs 2>/dev/null \
  | grep -v "docs/superpowers/"
```
Expected: no output.

- [ ] **Step 5: Run existing repo checks (ensure nothing else broke)**

Run: `npm run lint && npm run typecheck`
Expected: PASS (doc moves should not affect TS, but comment-path edits touched
source files — confirm they still compile/lint).

- [ ] **Step 6: Commit**

```bash
git add docs/
git commit -m "docs: standardize wiki page headers, final link/reference verification

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** target structure (Tasks 4–14, 17), moves-out (Task 2),
  delete (Task 3), bdm-prog.py docs (Task 14), repo-rename fixes (Task 15),
  35-row correction (Task 5/9), header standardization (Task 18), reference
  updates (Task 16) — all spec sections mapped.
- **Out of scope respected:** no SSG, no new research, superpowers/ only touched
  for stale-path fixes (Task 15).
- **Ordering:** moves-out and delete first (Tasks 2–3) so later passes don't
  re-touch them; merges after their primaries are in place; references updated
  (Task 16) only after all files reach final paths; index + headers last.
