# Lutron Protocol Wiki Consolidation — Design

**Date:** 2026-06-11
**Status:** Approved

## Goal

Consolidate and update the fragmented `docs/` tree (52 markdown files across
`protocols/`, `hardware/`, `firmware-re/`, `infrastructure/`, `reference/`)
into a coherent, comprehensive Lutron protocol wiki. Stay as in-repo markdown
(no MkDocs, no GitHub wiki). Verify content against the current source of
truth and fix stale facts as part of the merge.

## Decisions

- **Format:** in-repo markdown only.
- **Consolidation:** one canonical page per topic. Session-log content folded
  into reference pages; superseded findings corrected (not appended). Old
  filenames removed.
- **Updating:** full verify + update against `protocol/*.protocol.ts`,
  firmware, tools, config, and recent git history.
- **Security boundary:** move attack-framed docs out to a separate private
  repo.
- **Structure:** protocol + device axes (collapse `hardware/` vs
  `firmware-re/` split into one `devices/` axis).

## Target structure

```
docs/
  index.md                      # rebuilt wiki home, every page linked & grouped
  protocols/
    cca/
      index.md                  # <- cca.md
      pairing.md                # <- cca-pairing.md
      tdma.md                   # <- cca-tdma-beacon.md
      rx-dispatch.md            # <- cca-rx-dispatch.md
      ota.md                    # MERGE cca-ota-live-capture + cca-ota-hcs08 + OTA-wire section of powpak
      end-devices.md            # <- cca-end-devices.md
    ccx/
      index.md                  # <- ccx.md
      coap.md                   # <- ccx-coap.md
      commissioning.md          # <- ble-commissioning.md (reframed: commissioning RE, neutral tone)
    leap/
      index.md                  # <- leap.md
      server-internals.md       # <- leap-server.md
      api-discovery.md          # <- apk.md
    qslink.md                   # <- qslink.md
    ipl.md                      # <- ipl.md
  devices/
    index.md                    # <- hardware/overview.md
    ra3-processor.md            # <- phoenix.md
    caseta-smartbridge.md       # MERGE caseta-smartbridge-coproc + caseta-smartbridge-dispatch + caseta-cca-ota
    vive.md                     # MERGE vive + vive-processor + vive-athena + vive-ra2sel-device-firmware
    radiora2-select-rep.md      # <- rr-sel-rep2.md
    radiora2-main-rep.md        # <- ra2-main-repeater.md
    powpak.md                   # <- powpak.md (OTA-wire detail moves to protocols/cca/ota.md)
    qsm.md                      # <- qsm.md
    esn.md                      # <- esn.md
    pd-3pcl.md                  # <- pd-3pcl.md
    grafik-eye.md               # <- grafik-eye.md
    coprocessor-firmware.md     # <- coproc.md
    wink-hub.md                 # <- wink-hub.md
  designer/
    index.md                    # short hub
    database.md                 # <- designer-db.md
    ra3-hw-migration.md         # MERGE ra3-hw-migration + ra3-hw-workflow
    cycle-dim.md                # <- cycle-dim.md
  tooling/
    nucleo.md                   # <- hardware/nucleo.md
    bdm-recovery.md             # MERGE powpak-bdm-recovery + NEW bdm-prog.py tool docs
    ccx-wiz-bridge.md           # <- infrastructure/bridge.md
    network.md                  # <- infrastructure/network.md
    cloud-proxy.md              # <- infrastructure/cloud-proxy.md
    firmware-updates.md         # <- infrastructure/firmware-updates.md
  reference/
    dimming-curves.md
    daylighting.md
    cca-event-loop.md
    ccx-device-map.md
    training-notes-index.md
```

Net: 52 -> ~37 pages. No hardware/firmware-re split; each device family on one page.

## Moves out of repo (to a separate private repo)

- `firmware-re/powpak-conversion-attack.md` — RMJ→LMJ conversion attack
- `hardware/grx-keypad/glitch-rig-wiring.md` — voltage-glitch extraction rig
- `infrastructure/designer-universal-unlock.md` — IL jailbreak patches
- `infrastructure/designer-26.2-channel-fix.md` — IL DLL patch (same category)

Stays in this repo: `bdm-recovery` (defensive), `ble-commissioning` (protocol
RE — neutralize "best attack surface" framing).

Deleted: `powpak-recovery-resume.md` (stale session-resume prompt, not reference).

## Content fixes during merge

- Document new `tools/firmware/bdm-prog.py` USBDM programmer in `tooling/bdm-recovery.md`.
- Fix repo-rename stale paths: `lutron-tools` -> `lutron-protocols`, and
  `-Users-alex-lutron-tools` memory paths, in ~7 affected docs.
- Correct PowPak "35-row hopping table" narrative to match 2026-04-28 live
  capture (single-channel ~433.566 MHz), not just an inline caveat.
- Standardize page headers (title, one-line summary, status, source-of-truth
  links) and add cross-links.

## Reference updates after restructure

Update doc-path references in:
- `README.md`, `CLAUDE.md`
- 4 `.claude/skills/*/SKILL.md` (cca-protocol, designer-feature-flags,
  designer-re, s19-firmware-re)
- ~20 code/comment references in `firmware/src/`, `tools/`, `lib/`, `protocol/`

Pages moved to a separate private repo: update pointers or remove
(CLAUDE.md references `designer-universal-unlock.md`).

## Out of scope

- No conversion to a static-site generator.
- No new protocol research; only verify/correct existing content.
- No changes to `docs/superpowers/` (specs/plans) except fixing stale paths.
