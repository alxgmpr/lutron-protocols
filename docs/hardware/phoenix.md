# RA3 System Reference

RadioRA 3 processor internals, LEAP API, certificates, and database editing.

## 1. System Architecture

| Property | Value |
|----------|-------|
| Processor codename | **Janus** (JanusProcRA3) |
| SoC | TI AM3351 (ARM Cortex-A8, 600MHz) |
| OS | Linux 5.10 |
| Database schema | v168, **268 tables** per project transfer |
| Firmware | APT-style repo (kernel, rootfs, spl, uboot .deb packages) |
| MAC | <ra3-mac> (example) |

Internal codenames: Janus (RA3 processor), Pegasus (link/network), Hyperion (daylighting/facade), Kaleido (Ketra color display), McCasey (dimming curve algorithm).

## 2. Network Ports

| Port | Protocol | Purpose | Cert Required |
|------|----------|---------|---------------|
| 8081 | LEAP/JSON | Primary API (read-only) | Product certs (from Designer) |
| 8083 | TCP/TLS | LAP protocol | Unknown |
| 8902 | IPL/Binary | Designer transfer | Product certs (binary protocol) |
| **443** | **WSS** | **Programming/write access** | **Project-specific certs** |
| 22 | SSH | Support files, diagnostics | Unknown (publickey, keyboard-interactive) |
| 5353 | mDNS | Processor discovery | N/A |
| 2056-3055 | UDP multicast | Inter-processor events (239.0.38.x) | N/A |
| 8883 | MQTT/TLS | AWS IoT cloud | Device certs |

**Access summary**: Port 8081 is read-only with product certs. Write access requires port 443 with project-specific certificates generated during Designer pairing.

## 3. Certificate Hierarchy

Two independent chains serve different ports:

```
Port 8081/8083 (Product Certs):          Port 443 (Project Certs):

lutron-root                              Lutron Project SubSystem CA
    └─ radioRa3-products                     └─ RadioRa3Processor<MAC>
        └─ radioRa3-devices                      └─ IPLServer<serial>
            └─ radioRa3-processors-XXX
                └─ radiora3-<mac>-server
```

Product certs are extracted from Lutron Designer's `CertificateStore/` directory. Project certs are generated during Designer-to-processor pairing and stored in the project database.

**Key files** (in project root):
- `lutron-ra3-cert.pem` — Client certificate (product chain)
- `lutron-ra3-key.pem` — Client private key
- `lutron-ra3-ca.pem` — CA chain

## 4. LEAP API

Read-only JSON API on port 8081 via mutual TLS.

### Connection

```bash
# Using pylutron-caseta
leap --cacert lutron-ra3-ca.pem --cert lutron-ra3-cert.pem --key lutron-ra3-key.pem \
  "<ra3-ip>/area"

# Using leap-dump (walks full hierarchy)
bun run tools/leap-dump.ts
```

### Key Endpoints

| Endpoint | Returns |
|----------|---------|
| `/area` | All areas/rooms |
| `/area/{id}/associatedzone` | Zones (dimmers/switches) in an area |
| `/area/{id}/associatedcontrolstation` | Control stations (keypads, picos) |
| `/device/{id}` | Device details (serial, model, firmware) |
| `/device/{id}/buttongroup` | Button groups on a device |
| `/button/{id}` | Button definition with programming model |
| `/programmingmodel/{id}` | Programming model with preset references |
| `/preset/{id}` | Preset definition |
| `/zone/{id}/status` | Current zone level and lock state |
| `/link/{id}` | RF network config (Thread keys, CCA subnet) |

Write attempts return 500 or 405. Write access requires port 443 (WSS) with project-specific certificates.

### Control Station Hierarchy

```
Area → ControlStation → AssociatedGangedDevices[] → Device → ButtonGroup → Button → ProgrammingModel → Preset(s)
```

### Programming Model Types

| Type | Presets |
|------|---------|
| `AdvancedToggleProgrammingModel` | PrimaryPreset (off/recall) + SecondaryPreset (on/activate) |
| `SingleActionProgrammingModel` | Single Preset |
| `SingleSceneRaiseProgrammingModel` | Single Preset |
| `SingleSceneLowerProgrammingModel` | Single Preset |

## 5. RF Network Credentials

Available via LEAP `/link/{id}`:

**CCA (433 MHz):**
- Channel (e.g., 26)
- SubnetAddress (e.g., 33495 = 0x82D7)

**CCX (Thread):**
- Channel (e.g., 25)
- PAN ID (e.g., 25327 = <pan-id>)
- Extended PAN ID
- **NetworkMasterKey** (128-bit AES, decrypts all Thread traffic)

These match values extracted from the Designer SQL database.

## 6. Designer & LocalDB

Lutron Designer stores project data in SQL Server LocalDB with a dynamic instance name.

### Finding the Active Database

```powershell
# Find pipe (Designer must be open with a project)
[System.IO.Directory]::GetFiles("\\.\pipe\") | Where-Object { $_ -like "*LOCALDB*" }

# Connect
sqlcmd -S "np:\\.\pipe\LOCALDB#XXXXXXXX\tsql\query" -No -d Project -Q "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES"
```

### 4 Databases

| Database | Contents |
|----------|----------|
| **Project** | Active project data (268 tables) |
| **SqlModelInfo.mdf** | Device model definitions, dimming curves |
| **SqlReferenceInfo.mdf** | Reference/lookup data |
| **SqlApplicationData.mdf** | Per-version app settings |

### Certificate Tables

| Table | Column | Contents |
|-------|--------|----------|
| `tblProcessorSystem` | `SubsystemCertificateV2` | Root CA cert (PKCS#12, empty password) |
| `tblProcessorSystem` | `SubSystemPrivateKeyV2` | Root CA private key (DER EC) |
| `tblProcessor` | `ProcessorCertificate` | Server cert (PKCS#12, empty password) |
| `tblProcessor` | `LoobKey` | Intermediate CA cert (DER X.509) |
| `tblPegasusLink` | `NetworkMasterKey` | Thread network key |

### Key Project Tables

| Table | Purpose |
|-------|---------|
| `tblProject` | Project metadata, ProductType (3=RA3, 4=HW) |
| `tblZone` | Lighting zones |
| `tblArea` | Rooms and areas |
| `tblDevice` | Physical devices |
| `tblScene` | Lighting scenes |
| `tblProgrammingModel` | Button programming (AllowDoubleTap, HoldPresetId) |
| `tblPreset` / `tblPresetAssignment` | Preset actions and zone linkages |
| `tblIntegrationID` | Integration IDs |

## 7. Database Editing

### File Structure

```
.ra3 or .hw (ZIP archive)
  └── <uuid>.lut (MTF backup — Microsoft Tape Format)
      └── Project.mdf + Project_log.ldf (SQL Server database)
```

`.ra3` vs `.hw` extension alone is cosmetic; behavior is driven by metadata inside the DB (`tblProject.ProductType`, `tblVersion.ProductType`, `tblVersionHistory.ProductType`) and downstream transfer/runtime logic.

Database version: **957** (SQL Server 2022 RTM). Most SQL Server installations will upgrade past 957, making the file unreadable by Designer.

### Method 1: Live Editing (Recommended)

Edit while Designer has the project open:
1. Open project in Designer
2. Find pipe: `Get-ChildItem "\\.\pipe\" | Where-Object {$_.Name -like "*LOCALDB*"}`
3. Connect via SSMS or sqlcmd with `-No` flag
4. Make changes, close Designer normally to save

### Method 2: Docker (SQL Server 2022 RTM)

```bash
docker run -e "ACCEPT_EULA=Y" -e "MSSQL_SA_PASSWORD=LutronPass123" \
  -p 1433:1433 --name sql2022rtm \
  -v "$(pwd)":/data \
  -d mcr.microsoft.com/mssql/server:2022-RTM-ubuntu-20.04
```

```sql
-- Attach (use FORCE_REBUILD_LOG since .ldf won't match)
CREATE DATABASE [Project] ON (FILENAME = '/data/Project.mdf') FOR ATTACH_FORCE_REBUILD_LOG;

-- Edit, then detach
EXEC sp_detach_db 'Project', 'true';
```

Extraction/repacking uses `lutron-tool.py extract` and `lutron-tool.py pack`.

### Method 3: Binary Editing

For same-length UTF-16LE string replacements only. Cannot change string length (breaks row storage).

## 8. RA3 vs HomeWorks

Both use **identical table structures**. Differences are feature flags:

| Field | RA3 | HomeWorks |
|-------|-----|-----------|
| ProductType (tblProject) | 3 | 4 |
| AllowDoubleTap | 0 | 1 |
| HoldPresetId | NULL | Set |

Enable HW features in RA3:
```sql
UPDATE tblProgrammingModel SET AllowDoubleTap = 1, DoubleTapPresetID = <preset_id> WHERE ProgrammingModelID = <id>;
```

### Validated: RA3 Double-Tap on ATPM (2026-02-18)

This behavior was validated on a live RA3 project:

- Programming model: `ATPM` (`ObjectType=74`)
- Test row: `ProgrammingModelID=1091`
- Action: set `AllowDoubleTap=1`, `DoubleTapPresetID=947`
- Result: double-tap behavior worked after transfer

Apply:

```sql
UPDATE tblProgrammingModel
SET
  AllowDoubleTap = 1,
  DoubleTapPresetID = 947,
  HeldButtonAction = 0,
  HoldTime = 0,
  HoldPresetId = NULL,
  NeedsTransfer = 1
WHERE ProgrammingModelID = 1091;
```

Verify:

```sql
SELECT ProgrammingModelID, Name, ObjectType, AllowDoubleTap, DoubleTapPresetID, HoldPresetId
FROM tblProgrammingModel
WHERE ProgrammingModelID = 1091;
```

Rollback:

```sql
UPDATE tblProgrammingModel
SET
  AllowDoubleTap = 0,
  DoubleTapPresetID = NULL,
  HeldButtonAction = 0,
  HoldTime = 0,
  HoldPresetId = NULL,
  NeedsTransfer = 1
WHERE ProgrammingModelID = 1091;
```

Notes:

- Designer UI may show stale values until project close/reopen.
- Save in Designer after DB edits; otherwise edits may not persist across reopen.
- Keep tests isolated (single feature edit at a time) to reduce transfer/linking failures.

## 9. Cloud & Firmware

### Cloud Endpoints

| Endpoint | Purpose |
|----------|---------|
| `device-login.lutron.com` | Device authentication |
| `a32jcyk7azp7b5-ats.iot.us-east-1.amazonaws.com:8883` | MQTT broker |
| `firmwareupdates.lutron.com` | Firmware API |
| `provision.iot.lutron.io` | Device provisioning |

### Firmware Packages

**RA3 (Phoenix)**: APT-style — kernel, rootfs, spl, uboot as .deb packages.

**Vive**: ZIP bundle — `firmware.tar.enc` (AES-128-CBC, key RSA-encrypted), signed manifest.

### mDNS Discovery

Service `_lutron._tcp.local` with TXT record containing MAC, firmware version, device class, claim status, and serial number. `CLAIM_STATUS=Unclaimed` indicates factory-reset processor awaiting pairing.

## 10. Cycle/Hold Dimming Reverse-Engineering (HomeWorks Baseline)

Captured from HomeWorks project DB (`ProductType=4`) with Office Entryway keypad:

- `PM 499` (`ATPM`, button 2) and `PM 626` (`ATPM`, button 1) behaved as cycle-dim candidates.
- `PM 503` (`ATPM`, button 3) behaved as hold-preset style.

### Fingerprint: Cycle-Dim Style (`ATPM`)

```sql
-- Known HW cycle-like rows
SELECT ProgrammingModelID, Name, ObjectType, HeldButtonAction, HoldPresetId,
       AllowDoubleTap, DoubleTapPresetID, OnPresetID, OffPresetID
FROM dbo.tblProgrammingModel
WHERE ProgrammingModelID IN (499,626);
```

Observed values:

- `ObjectType = 74` (`ATPM`)
- `HeldButtonAction = 1`
- `HoldPresetId = NULL`
- `AllowDoubleTap = 0`
- `DoubleTapPresetID = NULL`
- valid `OnPresetID` + `OffPresetID`

### Fingerprint: Hold-Preset Style (`ATPM`)

```sql
-- Known HW hold-style rows
SELECT ProgrammingModelID, Name, ObjectType, HeldButtonAction, HoldPresetId,
       AllowDoubleTap, DoubleTapPresetID, OnPresetID, OffPresetID
FROM dbo.tblProgrammingModel
WHERE ProgrammingModelID IN (503,540,569);
```

Observed values:

- `ObjectType = 74` (`ATPM`)
- `HeldButtonAction = 0`
- `HoldPresetId IS NOT NULL`
- optional `DoubleTapPresetID` may coexist

### New Finding: RA3 "Cycle Attempt" vs HW Working Rows (2026-02-19)

Direct comparison of your RA3 test row (`PM 1221`) against known-working HW ATPM rows (`PM 540`, `PM 569`) shows three critical deltas:

1. Preset linkage:
   - RA3 test: `DoubleTapPresetID=NULL`, `HoldPresetId=NULL`
   - HW working: `DoubleTapPresetID=<id>`, `HoldPresetId=<id>`

2. Action mode flags:
   - RA3 test: `AllowDoubleTap=0`, `HeldButtonAction=1`
   - HW working: `AllowDoubleTap=1`, `HeldButtonAction=0`

3. LED logic mode:
   - RA3 test: `LedLogic=1`
   - HW working: `LedLogic=13`

This indicates the HomeWorks "cycle/hold dim" behavior on these ATPM rows is not represented by `HeldButtonAction=1` alone. In this sample, working rows are closer to a combined hold+doubletap preset model with a distinct LED logic mode.

Reference rows:

```sql
-- RA3 test row
SELECT ProgrammingModelID, ObjectType, Name, LedLogic, AllowDoubleTap, HeldButtonAction,
       DoubleTapPresetID, HoldPresetId, OnPresetID, OffPresetID, ParentID, ParentType
FROM dbo.tblProgrammingModel
WHERE ProgrammingModelID = 1221;

-- HW working rows
SELECT ProgrammingModelID, ObjectType, Name, LedLogic, AllowDoubleTap, HeldButtonAction,
       DoubleTapPresetID, HoldPresetId, OnPresetID, OffPresetID, ParentID, ParentType
FROM dbo.tblProgrammingModel
WHERE ProgrammingModelID IN (540,569);
```

### Validation Timeline Note (Office Doorway Button 2)

`Office > Doorway > Position 1 > Button 2` (`PM 1221`) was validated as working during live testing before the HW-style scaffold automation script was added.

- Initial confusion came from testing the wrong physical button.
- The later script run standardized DB state (`LedLogic=13`, hold+double presets populated), but did not establish first proof of runtime behavior for that button.

### Preset Parameter Decode (Confirmed in HW DB)

For these ATPM presets, values in `tblAssignmentCommandParameter` decode through
`AllPresetAssignmentsWithAssignmentCommandParameter` as:

- `ParameterType=1` -> `fade`
- `ParameterType=2` -> `delay`
- `ParameterType=3` -> `primary_level`

For `AssignmentCommandType=2` (zone level command), this is the active mapping used by the view.

Example (HW PM 540 / 569):

- `OnPreset` rows: `fade=3`, `delay=0`, `primary_level=75`
- `OffPreset` rows: `fade=10`, `delay=0`, `primary_level=0`
- `DoubleTapPreset` rows: `fade=0`, `delay=0`, `primary_level=100`
- `HoldPreset` rows: `fade=40`, `delay=30`, `primary_level=0`

### Strong Correlation: ATPM Presets <-> ZoneControlUI Local Button Fields

On HW rows with `LedLogic=13` (`PM 540`, `PM 569`), the preset values align with
`tblZoneControlUI` for the same device/zone:

- `LocalButtonPresetLevel` (`190` ~= `75%`) -> `OnPreset primary_level=75`
- `LocalButtonDoubleTapPresetLevel` (`255` = `100%`) -> `DoubleTap primary_level=100`
- `PressFadeOnTimeOrRateValue=3` -> `OnPreset fade=3`
- `PressFadeOffTimeOrRateValue=10` -> `OffPreset fade=10`
- `LongFadeToOffPrefadeTime=30` -> `HoldPreset delay=30`
- `LongFadeToOffTimeOrRateValue=40` -> `HoldPreset fade=40`

This suggests these rows are generated from local zone-control UI behavior, not just
generic keypad toggle rows.

### Caution on Comparing PM 1221 vs PM 540/569

`PM 1221` (RA3 test) is on model `5197` (`RRST-HN3RL-XX`, button numbers `4/6/7/17/18`).
`PM 540/569` are on model `730` (`HQR-3LD`, includes button `0` local-control semantics).

### HQR-3LD Visibility Gap: Missing Local Button Chain

In the converted HomeWorks-mode project, Office lamp dimmers were present as `HQR-3LD` zones but did not appear in the expected per-device programming UI. Root cause was not model lookup ambiguity; it was missing local programming rows.

Validated state:
- Office devices `3272` and `3289` had:
  - `tblControlStationDevice.ModelInfoID = 730 (HQR-3LD)`
  - valid `tblZoneControlUI` + zone assignments (`3278`, `3295`)
  - existing `tblButtonGroup` rows (`3723`, `3724`)
- But both were missing:
  - `tblKeypadButton` (`ButtonNumber=0`) and downstream rows in:
    - `tblProgrammingModel`
    - `tblPreset`
    - `tblPresetAssignment`
    - `tblAssignmentCommandParameter`

Working comparison device:
- `3767` (`TESTING`) included the full chain and was programmable in UI.

Implication:
- For HQR-3LD, model conversion alone is insufficient.
- HomeWorks UI visibility for local device programming depends on the full local-button chain, not just `ModelInfoID` + zone records.

Repair script:
- `<project-root>/tools/sql/hw-add-hqr3ld-local-programming.sql`
- Dry-run currently reports:
  - `3272`: `WILL_ADD_CHAIN`
  - `3289`: `WILL_ADD_CHAIN`

Applied result (HomeWorks-mode project):
- `3272` and `3289` now each have:
  - `tblKeypadButton` local row (`ButtonNumber=0`)
  - `tblProgrammingModel` (`ATPM`, `ObjectType=74`)
  - 4 presets (`On/Off/Hold/DoubleTap`)
  - 4 preset assignments to their zones (`3278`, `3295`)
- `sel_ProgrammingModelIssues` post-check: `0` corruption rows.
- `tblProject.NeedsSave = 1`.

Follow-up fix (Guest Room):
- Found remaining non-programmable lamp dimmer:
  - `3233` (`Guest Room > Desk > Position 1`) was still `RRD-3LD` (`ModelInfoID=461`) and missing local chain.
- Updated repair workflow to auto-target all project 3LD dimmers:
  - normalizes legacy `RRD-3LD (461)` -> `HQR-3LD (730)`
  - adds missing local `Button 0` programming chain only where absent.
- Post-fix verification:
  - `3233`, `3272`, `3289` all now `HQR-3LD (730)`
  - all have `HasLocalButton0=1` and `HasProgrammingModel=1`
  - integrity check remains clean (`sel_ProgrammingModelIssues = 0`).

Follow-up fix (all 3PD lamp dimmers, including Laundry):
- Extended script to also target 3PD models:
  - `HQR-3PD-1 (1300)` and legacy `RR-3PD-1 (1166)`
- Added missing local chain for all converted 3PD devices:
  - Dining Room `2804`
  - Foyer `2770`
  - Hallway `2855`
  - Kitchen `266`, `2821`
  - Laundry Room `3043`
  - Living Room `2787`
  - Master Bedroom `2838`
- Post-apply verification:
  - every project lamp dimmer (`HQR-3LD` + `HQR-3PD-1`) now has:
    - `HasLocalButton0=1`
    - `HasProgrammingModel=1`
  - integrity check clean (`sel_ProgrammingModelIssues = 0`)
  - project remains HomeWorks mode (`ProductType=4`) with `NeedsSave=1`.

### L01 Pico behavior and root cause (updated)

Validated behavior:
- `PJ2-4B-XXX-L01` can expose/program all four buttons in HomeWorks UI.
- This was confirmed with newly created `TESTTEST` (`ControlStationDeviceID=3913`) before the later alignment script changes.

Root cause for Office/Guest mismatch:
- Converted L01 devices carried stale conversion-era bindings:
  - `tblControlStationDevice.AssociatedTemplateId = 1173` (expected `424`)
  - `tblButtonGroup.ButtonGroupInfoID = 1463` (expected `1459` for `ModelInfoID=3608`)
  - SSRLPM rows (`ObjectType=76`) had `LedLogic = 4` (native profile uses `0`)
- In `SQLMODELINFO.MDF`, `TBLBUTTONGROUPINFOMODELINFOMAP` maps `ModelInfoID=3608` to `ButtonGroupInfoID=1459`, not `1463`.

### L01 Pico normalization scripts

1) Programming cleanup script:
- `<project-root>/tools/sql/hw-normalize-l01-pico-programming.sql`
- Removes legacy `tblPresetAssignment` + `tblAssignmentCommandParameter` rows under L01 button presets.

2) Template/binding repair script:
- `<project-root>/tools/sql/hw-fix-l01-pico-template-bindings.sql`
- Aligns all `PJ2-4B-XXX-L01` devices to canonical bindings:
  - `AssociatedTemplateId -> 424`
  - `ButtonGroupInfoID -> 1459`
  - SSRLPM (`ObjectType=76`) `LedLogic -> 0`
  - marks PM rows `NeedsTransfer=1`
  - sets `tblProject.NeedsSave=1`

Applied repair result:
- Updated rows:
  - `UpdatedAssociatedTemplateId = 2`
  - `UpdatedButtonGroupInfoID = 4`
  - `UpdatedSSRLPMRows = 6`
  - `UpdatedProjectNeedsSave = 1`
- Post-check: all current L01 4B devices `365`, `1152`, `1176`, `2919`, `3913` report:
  - `AssociatedTemplateId = 424`
  - `ButtonGroupInfoID = 1459`
  - SSRLPM `LedLogic = 0`
  - zero pending deltas in dry-run output
- Integrity check remains clean (`sel_ProgrammingModelIssues = 0` from prior validation).

So `1221` vs `540/569` may be cross-model behavior, not a like-for-like programming model comparison.

### Important: Model Capability Check (RA3 vs HW Hybrid Keypads)

In `SQLMODELINFO.MDF` (v26.0.1.100), both HomeWorks and RA3 hybrid 3BRL keypads map to the same button action capability list:

- HW: `HRST-HN3RL-XX` (`ModelInfoID=5194`)
- RA3: `RRST-HN3RL-XX` (`ModelInfoID=5197`)
- both -> `BUTTONACTIONLISTID=2` (`Press/Release/Multi-tap/Hold`)
- action types: `Press`, `Release`, `Hold`, `MultiTap`

This indicates cycle/hold gating is not explained by model action-list capabilities alone.

```sql
-- Run in SQLMODELINFO.MDF
SELECT kci.MODELINFOID, mi.LUTRONMODELNUMBERBASE, kci.BUTTONACTIONLISTID, bal.DESCRIPTION
FROM dbo.TBLKEYPADCONTROLLERINFO kci
JOIN dbo.TBLMODELINFO mi ON mi.MODELINFOID = kci.MODELINFOID
JOIN dbo.TBLBUTTONACTIONLIST bal ON bal.BUTTONACTIONLISTID = kci.BUTTONACTIONLISTID
WHERE kci.MODELINFOID IN (5194,5197);
```

### Transfer/Integrity Sanity Checks

```sql
EXEC dbo.sel_ProgrammingModelIssues;
EXEC dbo.sel_CheckCorruptBtnProgramming @ProgrammingParentID = <button_id>;
```

If these are clean but runtime behavior differs, the blocker is likely feature gating during transfer/runtime interpretation rather than row-level corruption.

## RA3 System Internals (from Designer Transfer Log)

### Source
Transfer log from `Example Residence-template-v26.0.0.110.ra3` (software v26.0.0.110)

### Processor
- **Codename: "Janus"** (JanusProcRA3)
- Schema version: **168**
- Database: **268 tables** written on each transfer
- Transfer process: write all 268 tables → integrity check → upload → apply → reboot (~1 min) → RF device transfer (~2 min)
- Session GUID verification ensures transfer integrity

### CcaTransferlessActivationSupported (Table 268)
Last table in the schema. Confirms RA3 supports **"transferless activation"** — activating/pairing
CCA devices without a full database transfer. Relevant to CCA pairing reverse engineering.

### Internal Codenames
| Codename | Context | Likely Meaning |
|----------|---------|----------------|
| Janus | JanusProcRA3 | RA3 processor |
| Pegasus | PegasusLink, PegasusLinkNode | A link/network type (unknown specifics) |
| Hyperion | Hyperion, HyperionAreaParameters, HyperionWindowType, HyperionShadowSettings | Daylight harvesting / facade management system |
| Kaleido | AssignmentCommandActivateKaleidoDisplay | Ketra Kaleido color display product |
| McCasey | McCaseyDimCurve | A dimming curve algorithm (internal name) |

### Communication Links
- **GreenPhyLinkNode** (table 235) — HomePlug Green PHY (powerline communication over copper wire)
  - RA3 uses **PoE/Ethernet** for processor ↔ repeater networking, NOT powerline
  - GreenPhy is likely used for **companion dimmer ↔ master dimmer** communication
    over the shared traveler/copper wire between ganged devices
  - Also possibly used for wired connections within an enclosure (e.g., dimmer modules in a panel)
- **PegasusLink / PegasusLinkNode** (tables 228-229) — unknown link type
- **Link / LinkNode** (tables 33, 36) — generic link abstraction
- **BaudRateLinkConfiguration** (table 37) — serial link config (for integration ports)

### Dimming Curves (4 Types)
| Table | Curve Type | Notes |
|-------|-----------|-------|
| WarmDimCurve (245) | Warm dim | CCT shift as brightness decreases (incandescent emulation) |
| XYSpline11KnotDimCurve (246) | CIE xy spline | 11-knot spline in CIE xy color space |
| CCTSpline11KnotDimCurve (247) | CCT spline | 11-knot spline in correlated color temperature |
| McCaseyDimCurve (248) | "McCasey" | Unknown algorithm — internal Lutron name |

### Key Database Tables (Grouped by Function)

#### Device & Hardware
- LeapDeviceType (1), ModelInfo (2), EnclosureDevice (32), Enclosure (120)
- ControlStationDevice (28), ControlStation (121)
- RfPropertyAddress (43), RfController (46)
- SwitchLegController (49), SwitchLeg (114)
- ShadeSwitchLegController (50), ShadeSwitchLeg (115)
- VenetianSwitchLegController (51), VenetianSwitchLeg (116)
- ChannelSwitchLegController (52), MotorSwitchLegController (53)
- SliderCsd (29), DmxCsd (30), ReceptacleCsd (31)

#### Buttons & Programming
- Button (55), ButtonGroup (44), ButtonController (47)
- Led (38), LedController (45)
- PresetAssignment (65), Preset (150), Scene (149), SceneController (113)
- SingleActionProgrammingModel (144)
- DualActionProgrammingModel (145)
- MasterRaiseLowerProgrammingModel (146)
- SingleSceneRaiseLowerProgrammingModel (147)
- AdvancedToggleProgrammingModel (148)
- SimpleConditionalProgrammingModel (142), ConditionalStates (143)
- AdvancedConditionalProgrammingModel (197) — ACPM conditional logic engine
- AcpmTrigger (198), AcpmExecutionAction (199), AcpmDelayAction (200)
- AcpmConditionalAction (201), AcpmCondition (202), AcpmRelationship (203)
- AcpmRangeBasedCondition (204)

#### Zones & Areas
- Zone (122), Area (128), SpaceType (129)
- HvacZone (123), PhantomHvacZone (124)
- ShadeZone (125), VenetianZone (126), SoftSheerZone (127)
- ChromaZone (224) — color tuning zone (Ketra)

#### Sensors
- Sensor (118), OccupancySensor (119)
- PicoSensorConnection (108) — Pico remote associations
- RfOccVacSensorConnection (105), RfDaylightingSensorConnection (106)
- RfShadowSensorConnection (107), RfTemperatureSensorConnection (109)
- SensorAssociation (112), SensorGroup (209), SensorSettings (250)

#### Scheduling & Time
- TimeClock (151), TimeClockEvent (140), TimeClockMode (4)
- Schedule (18), WeeklyEventSchedule (15), ByDateEventSchedule (14)
- Sequence (61), SequenceStep (63)

#### Integration
- IntegrationController (34), IntegrationPort (35), IntegrationDevice (175)
- IntegrationCommandSet (166), IntegrationCommand (170)
- IntegrationCommandProperty (171), IntegrationCommandEvent (264)
- StringConversion (167) — protocol string conversion for 3rd party

#### Ketra / Advanced Lighting
- Fixture (9), LedFixture (10), LedClassicFixture (11)
- CompositeEmitterController (225), EmitterController (226)
- CompositeEmitter (230), Emitter (234), EmitterChannelConfig (233)
- DeviceEmitterProperties (227), DualCctConfig (231)
- UniversalLedChannelConfig (232)
- NaturalShow (236), NaturalShowStep (237), NaturalShowCurveGuide (238)
- ColorSwatchTemplate (64), ColorTableKey (155), ColorTableRow (156)
- SmartLamp (222), LinearSmartLamp (223)

#### Daylighting / Facade
- DaylightingGroup (131), DaylightingRegion (132)
- DaylightingSetpointDefinition (24), DaylightingSensorConnection (93)
- Facade (205), NaturalLightOptimizer (206), NaturalLightOptimizerStage (207)
- NaturalLightOptimizerFadeFighterProgramming (251)

#### Touchscreen UI
- AreaTouchscreenUi (159), DeviceTouchscreenUi (160)
- KeypadTouchscreenUi (162), ZoneTouchscreenUi (163)
- ButtonTouchscreenUi (164), LabelTouchscreenUi (165)

#### Presence Detection (newer feature)
- PresenceDetectionButtonList (254), PresenceDetectionDeviceList (255)
- PresenceDetectionDoorList (256), PresenceDetectionOccupancyGroupList (257)
- PresenceDetectionSensorConnectionList (258), PresenceDetectionGroup (259)

#### Assignment Commands (Action Parameters)
~30 AssignmentCommand* tables (66-101, 239, 252, 262-263) covering:
- GoToLevel, GoToSpeed, GoToShadeLevelWithSpeed
- GoToPrimaryAndSecondaryLevels (dual-channel)
- GoToLiftAndTilt (venetian blinds)
- GoToFlash, Pulse, GoToSwitchedLevel
- SetHyperionMode, HyperionEnableState
- OpenCloseVenetianBlind, Open, Close
- ActivateNaturalShow, ActivateKaleidoDisplay
- AdjustRuntimeHighEndTrimWithGoToLevel — trim adjustment command!
- GoToLoadState, GoToLockState, GoToScene
- SetTimeclockState, UpdateHvacData, PartitionState
- OccupancyActiveState, OccupiedLevel, UnoccupiedLevel
- GoToDaylighting, DaylightingTsp
- UpdateRentableSpaceState, SetNaturalLightOptimizerEnabledState

#### Other
- LoadShed (176), LoadType (177), LoadState (221)
- PowerSupplyOutput (178), PowerInterfaceAssignment (180)
- FanConfiguration (59), Speaker (56)
- Door (215), PartitionWall (135)
- RentableSpace (253), RentableSpaceProgrammingCriteria (260)
- GlobalPreference (210), DatabaseMetadata (243)
- DeviceFirmwareUpdateSchedule (244)
- CcaTransferlessActivationSupported (268)

### Lutron Designer LocalDB Access
- VM: `user@10.0.0.5` (SSH, password: alex)
- Named pipe: `np:\\.\pipe\LOCALDB#CEA130DB\tsql\query` (pipe hash changes per instance start)
- Instance: `LutronLocalDb2022Gamma`
- Connect: `sqlcmd -S "np:\\.\pipe\LOCALDB#CEA130DB\tsql\query" -No` (must disable encryption)
- **Project** DB = active project data (268 tables from transfer log)
- **SqlModelInfo.mdf** = device model definitions (curves, hardware specs, button types)
- **SqlReferenceInfo.mdf** = reference/lookup data
- **SqlApplicationData.mdf** = per-version app settings
- Use `USE [full_mdf_path]` to switch to non-Project databases

### Device Transfer Status Patterns
- **"Device not addressed"** = device exists in project but not physically paired to RF network
  - All "Digital" position devices consistently showed this (Sunnata/Diva smart dimmers)
  - Powder Room devices also not addressed
- **"Transfer Complete"** = device on CCA network, config received via RF
  - Pico remotes (positions without load names: Bedside, Desk, Coffee Table, etc.)
  - In-wall switches/dimmers with load names (Cabinet, Backsplash, Doorway, etc.)
  - RF CCO (Fireplace Blower)

### Device Naming Convention
`Area\Location\Position N [LoadName-ComponentNumber]`
- Component number after load name (e.g., "Lamp-4") = LEAP component/zone number
- Positions without bracketed names = Pico remotes
- "Digital" positions = smart dimmers (Sunnata/Diva with digital features)
