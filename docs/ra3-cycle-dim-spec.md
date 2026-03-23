# RA3 Cycle Dimming Enablement Spec (ATPM)

## Goal
Enable HomeWorks-style cycle dimming behavior on a RadioRA3 ATPM keypad button by reproducing the same programming model scaffold in the project DB.

## Scope
- In scope: `tblProgrammingModel` (`ATPM`, `ObjectType=74`), `tblPreset`, `tblPresetAssignment`, `tblAssignmentCommandParameter`.
- Initial target: `ProgrammingModelID=1221` (Office > Doorway > Position 1 > Button 2).
- Out of scope: firmware patching, protocol-level injection, cross-product import.

## Baseline Evidence (HomeWorks)
Known-working HW ATPM rows (`PM 540`, `PM 569`) show:
- `LedLogic=13`
- `AllowDoubleTap=1`
- `HeldButtonAction=0`
- `HoldPresetId` is populated
- `DoubleTapPresetID` is populated
- On/off/hold/double presets all have valid assignment rows

Parameter decode (from `AllPresetAssignmentsWithAssignmentCommandParameter`):
- `ParameterType=1` -> `fade`
- `ParameterType=2` -> `delay`
- `ParameterType=3` -> `primary_level`

Working HW values:
- On preset: `fade=3`, `delay=0`, `primary_level=75`
- Off preset: `fade=10`, `delay=0`, `primary_level=0`
- Double tap preset: `fade=0`, `delay=0`, `primary_level=100`
- Hold preset: `fade=40`, `delay=30`, `primary_level=0`

## Implementation Strategy
For a target RA3 ATPM PM row:
1. Validate target PM is ATPM (`ObjectType=74`) and button-backed (`ParentType=57`).
2. Require existing `OnPresetID`/`OffPresetID` and clone topology from `OnPreset` assignments.
3. Delete any pre-existing hold/double presets currently linked by PM.
4. Create new `Double Tap` and `Hold` preset rows parented to the target PM.
5. Clone each `OnPreset` assignment into two new assignments:
   - Double tap assignment params: `1,0:2,0:3,100`
   - Hold assignment params: `1,40:2,30:3,0`
6. Update PM fields to HW-style pattern:
   - `LedLogic=13`
   - `AllowDoubleTap=1`
   - `HeldButtonAction=0`
   - `HoldPresetId=<new hold preset>`
   - `DoubleTapPresetID=<new double tap preset>`
   - `NeedsTransfer=1`
7. Run integrity check (`sel_ProgrammingModelIssues`) and fail transaction if corruption is detected.

## Artifacts
- Apply script: `<project-root>/tools/sql/ra3-enable-atpm-cycle-dim.sql`
- Verify script: `<project-root>/tools/sql/ra3-verify-atpm-cycle-dim.sql`

## Execution Runbook
1. Close HomeWorks project in Designer.
2. Open the target RA3 project in Designer.
3. Run apply script in the active RA3 DB.
4. Save project, close/reopen project in Designer.
5. Transfer to processor.
6. Run verify script and perform physical button test.

## Acceptance Criteria
- PM row has HW-style field pattern (`LedLogic=13`, hold+double preset IDs populated, `AllowDoubleTap=1`, `HeldButtonAction=0`).
- New hold/double presets exist with assignment rows for the same zones as `OnPreset`.
- Decoded assignment values match expected fade/delay/level triplets.
- `sel_ProgrammingModelIssues` returns `0`.
- Runtime: press/hold behavior is cycle-dim-like and no transfer/linking errors occur.

## Rollback Plan
If transfer/runtime fails:
1. Set PM back to toggle-only state:
   - `AllowDoubleTap=0`
   - `HeldButtonAction=0`
   - `HoldPresetId=NULL`
   - `DoubleTapPresetID=NULL`
   - `LedLogic=1`
2. Delete new hold/double presets and their assignment/parameter rows.
3. Set `NeedsTransfer=1` on PM.
4. Save, reopen project, transfer again.

## Risks
- Behavior may still be runtime-gated by product mode (`ProductType=3`) despite table parity.
- Zone/control-station model differences can alter semantics even under ATPM.
- Designer may display stale UI values until project reopen.
