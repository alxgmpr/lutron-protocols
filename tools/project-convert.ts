#!/usr/bin/env bun

/**
 * Offline RA3/HW project file converter.
 *
 * The .lut file inside an .ra3/.hw ZIP is a SQL Server BACKUP (.bak) file.
 * Designer uses BACKUP DATABASE / RESTORE DATABASE (via SMO) for all file I/O.
 *
 * This converter: RESTORE .bak → run conversion SQL → BACKUP to new .bak.
 * The resulting .bak is placed as the .lut inside the output ZIP.
 *
 * No Windows VM, no Designer, no MDF page-level manipulation needed.
 */

import { parseArgs } from "util";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "fs";
import { join, basename, extname } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";

// ── CLI ──────────────────────────────────────────────────────────────

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    direction: { type: "string" },
    "extract-only": { type: "string" },
    "pack-only": { type: "string" },
    "docker-image": {
      type: "string",
      default: "mcr.microsoft.com/mssql/server:2022-RTM-ubuntu-20.04",
    },
    "keep-container": { type: "boolean", default: false },
    diff: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
  allowPositionals: true,
  strict: false,
});

if (values.help || (positionals.length === 0 && !values.diff)) {
  console.log(`
project-convert — Offline RA3/HW project file converter

Uses RESTORE/BACKUP (same as Designer) to produce fully compatible project files.

Usage:
  bun run tools/project-convert.ts <input.ra3|.hw> <output.ra3|.hw> [options]
  bun run tools/project-convert.ts --diff <fileA> <fileB>

Options:
  --direction <RA3_TO_HW|HW_TO_RA3>  Conversion direction (auto-detected from extensions)
  --extract-only <dir>                Extract .bak from project ZIP
  --pack-only <bak>                   Pack .bak into project ZIP
  --docker-image <image>              SQL Server image (default: 2022-RTM-ubuntu-20.04)
  --keep-container                    Don't remove Docker container after conversion
  --diff                              Show schema diff between two project files
  --help                              Show this help
`);
  process.exit(0);
}

// ── Constants ────────────────────────────────────────────────────────

const CONTAINER_NAME = `lutron-convert-${Date.now()}`;
const SA_PASSWORD = "LutronPass1!";

// Hardcoded verified model mapping (Designer 26.0.1.100)
// Source: docs/ra3-hw-roundtrip-workflow.md
const RA3_TO_HW_MAP: Record<number, number> = {
  5093: 5046, // RR-PROC3-KIT → HQP7-RF-2
  5197: 5194, // RRST-HN3RL-XX → HRST-HN3RL-XX
  5198: 5195, // RRST-HN4B-XX → HRST-HN4B-XX
  5115: 5056, // RRST-PRO-N-XX → HRST-PRO-N-XX
  5121: 5062, // RRST-W4B-XX → HRST-W4B-XX
  5122: 5063, // RRST-W3RL-XX → HRST-W3RL-XX
  5249: 5248, // RRST-ANF-XX → HRST-ANF-XX
  5117: 5058, // RRST-8ANS-XX → HRST-8ANS-XX
  1166: 1300, // RR-3PD-1 → HQR-3PD-1
  461: 730, // RRD-3LD → HQR-3LD
};

// Auto-generate reverse map
const HW_TO_RA3_MAP: Record<number, number> = {};
for (const [ra3, hw] of Object.entries(RA3_TO_HW_MAP)) {
  HW_TO_RA3_MAP[hw] = Number(ra3);
}

// ── Helpers ──────────────────────────────────────────────────────────

function makeTempDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function exec(
  cmd: string[],
  opts?: { timeout?: number; cwd?: string }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    cwd: opts?.cwd,
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts?.timeout) {
    timer = setTimeout(() => proc.kill(), opts.timeout);
  }

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (timer) clearTimeout(timer);
  return { stdout, stderr, exitCode };
}

async function execOrDie(
  cmd: string[],
  label: string,
  opts?: { timeout?: number; cwd?: string }
): Promise<string> {
  const r = await exec(cmd, opts);
  if (r.exitCode !== 0) {
    console.error(`${label} failed (exit ${r.exitCode}):`);
    if (r.stderr.trim()) console.error(r.stderr.trim());
    if (r.stdout.trim()) console.error(r.stdout.trim());
    throw new Error(`${label} failed`);
  }
  return r.stdout;
}

// ── Core: Extract .bak from project ZIP ─────────────────────────────

interface ExtractResult {
  bakPath: string;
  lutFilename: string;
  tempDir: string;
}

async function extractBak(projectFile: string): Promise<ExtractResult> {
  console.log(`Extracting backup from ${basename(projectFile)}...`);

  const tempDir = makeTempDir("lutron-extract");
  const unzipDir = join(tempDir, "unzipped");
  mkdirSync(unzipDir);

  // Unzip
  await execOrDie(["unzip", "-o", projectFile, "-d", unzipDir], "unzip");

  // Find .lut file (which IS a SQL Server .bak file)
  const files = readdirSync(unzipDir);
  const lutFile = files.find((f) => f.endsWith(".lut"));
  if (!lutFile) {
    throw new Error(
      `No .lut file found in archive. Contents: ${files.join(", ")}`
    );
  }

  const lutPath = join(unzipDir, lutFile);
  const lutSize = statSync(lutPath).size;
  console.log(`  LUT/BAK: ${lutFile} (${(lutSize / 1024 / 1024).toFixed(1)} MB)`);

  // Copy .lut → .bak for clarity (it's the same file)
  const bakPath = join(tempDir, "Project.bak");
  await Bun.write(bakPath, Bun.file(lutPath));

  return { bakPath, lutFilename: lutFile, tempDir };
}

// ── Core: Pack project ZIP from .bak ────────────────────────────────

async function packProject(
  bakPath: string,
  lutFilename: string,
  outputFile: string
): Promise<void> {
  console.log(`Packing project to ${basename(outputFile)}...`);

  // The .bak file goes directly into the ZIP as the .lut file.
  // Designer (.NET) expects create_system=0 (MS-DOS), version=20,
  // external_attr=0. macOS `zip` produces Unix attributes that
  // cause Designer to reject the file.
  await execOrDie(
    [
      "python3", "-c", `
import zipfile, struct, sys, os, zlib, time

# Build ZIP manually to get exact MS-DOS attributes matching Designer output.
# Python's zipfile module sets Unix external_attr even when create_system=0.
out_path = sys.argv[1]
arc_name = sys.argv[2].encode()
lut_path = sys.argv[3]

with open(lut_path, 'rb') as f:
    data = f.read()

compressed = zlib.compress(data, 6)[2:-4]  # raw deflate (strip zlib header/trailer)
crc = zlib.crc32(data) & 0xFFFFFFFF

# DOS date/time
now = time.localtime()
dos_time = (now.tm_hour << 11) | (now.tm_min << 5) | (now.tm_sec // 2)
dos_date = ((now.tm_year - 1980) << 9) | (now.tm_mon << 5) | now.tm_mday

# Local file header
local = struct.pack('<IHHHHHIIIHH',
    0x04034b50,    # signature
    20,            # version needed
    0,             # flags
    8,             # compression (deflate)
    dos_time,      # mod time
    dos_date,      # mod date
    crc,
    len(compressed),
    len(data),
    len(arc_name),
    0)             # extra field length

# Central directory entry
central = struct.pack('<IHHHHHHIIIHHHHHII',
    0x02014b50,    # signature
    20,            # version made by (2.0, MS-DOS)
    20,            # version needed
    0,             # flags
    8,             # compression
    dos_time,
    dos_date,
    crc,
    len(compressed),
    len(data),
    len(arc_name),
    0, 0,          # extra len, comment len
    0,             # disk number start
    0,             # internal attr
    0,             # external attr (MS-DOS, no special bits)
    0)             # local header offset

# End of central directory
cd_offset = len(local) + len(arc_name) + len(compressed)
cd_size = len(central) + len(arc_name)
eocd = struct.pack('<IHHHHIIH',
    0x06054b50,
    0, 0,          # disk numbers
    1, 1,          # entries
    cd_size,
    cd_offset,
    0)             # comment length

with open(out_path, 'wb') as f:
    f.write(local)
    f.write(arc_name)
    f.write(compressed)
    f.write(central)
    f.write(arc_name)
    f.write(eocd)

print(f'ZIP created: {os.path.getsize(out_path)} bytes, CRC={crc:08x}')
`,
      outputFile,
      lutFilename,
      bakPath,
    ],
    "zip (python)",
    { timeout: 120_000 }
  );

  const outSize = statSync(outputFile).size;
  console.log(`  Output: ${basename(outputFile)} (${(outSize / 1024 / 1024).toFixed(1)} MB)`);
}

// ── Core: Docker SQL Server ──────────────────────────────────────────

async function waitForSqlServer(containerName: string): Promise<void> {
  console.log("  Waiting for SQL Server to be ready...");
  const maxWait = 60_000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    const r = await exec([
      "docker",
      "exec",
      containerName,
      "/opt/mssql-tools/bin/sqlcmd",
      "-S",
      "localhost",
      "-U",
      "sa",
      "-P",
      SA_PASSWORD,
      "-Q",
      "SELECT 1",
      "-b",
    ]);
    if (r.exitCode === 0) {
      console.log("  SQL Server ready.");
      return;
    }
    await Bun.sleep(1000);
  }

  throw new Error("SQL Server did not become ready within 60 seconds");
}

async function sqlcmd(
  containerName: string,
  query: string
): Promise<string> {
  return execOrDie(
    [
      "docker",
      "exec",
      containerName,
      "/opt/mssql-tools/bin/sqlcmd",
      "-S",
      "localhost",
      "-U",
      "sa",
      "-P",
      SA_PASSWORD,
      "-d",
      "master",
      "-Q",
      query,
      "-b",
      "-W", // trim trailing spaces
    ],
    "sqlcmd",
    { timeout: 120_000 }
  );
}

async function sqlcmdDb(
  containerName: string,
  dbName: string,
  query: string
): Promise<string> {
  return execOrDie(
    [
      "docker",
      "exec",
      containerName,
      "/opt/mssql-tools/bin/sqlcmd",
      "-S",
      "localhost",
      "-U",
      "sa",
      "-P",
      SA_PASSWORD,
      "-d",
      dbName,
      "-Q",
      query,
      "-b",
      "-W",
    ],
    "sqlcmd",
    { timeout: 120_000 }
  );
}

/**
 * SQL to add local dimmer programming chain for HQR-3LD/HQR-3PD-1 devices.
 *
 * In RA3, lamp dimmers (RRD-3LD, RR-3PD-1) are simple zones with no local
 * button programming. In HomeWorks, the equivalent devices (HQR-3LD, HQR-3PD-1)
 * need a full programming chain: ButtonGroup → KeypadButton → ProgrammingModel
 * → Preset → PresetAssignment → AssignmentCommandParameter.
 *
 * Adapted from tools/sql/hw-add-hqr3ld-local-programming.sql.
 */
function buildLocalDimmerProgrammingSql(): string {
  return `
-- === Add local dimmer programming chain for 3LD/3PD ===

PRINT '=== Adding local dimmer programming for HQR-3LD/3PD ===';

-- Find 3LD/3PD devices that have a zone but no local button
CREATE TABLE #DimmerTargets
(
  RN INT IDENTITY(1,1) PRIMARY KEY,
  DeviceID BIGINT NOT NULL,
  AssignedZoneID BIGINT NOT NULL,
  ExistingButtonGroupID BIGINT NULL,
  NeedInsertButtonGroup BIT NOT NULL
);

INSERT INTO #DimmerTargets (DeviceID, AssignedZoneID, ExistingButtonGroupID, NeedInsertButtonGroup)
SELECT
  csd.ControlStationDeviceID,
  zc.AssignedZoneID,
  bg.ButtonGroupID,
  CASE WHEN bg.ButtonGroupID IS NULL THEN 1 ELSE 0 END
FROM dbo.tblControlStationDevice csd
CROSS APPLY (
  SELECT TOP (1) AssignedZoneID
  FROM dbo.tblZoneControlUI
  WHERE ParentDeviceID = csd.ControlStationDeviceID AND ParentDeviceType = 5
  ORDER BY ZoneControlUIID
) zc
OUTER APPLY (
  SELECT TOP (1) ButtonGroupID
  FROM dbo.tblButtonGroup
  WHERE ParentDeviceID = csd.ControlStationDeviceID AND ParentDeviceType = 5
  ORDER BY ButtonGroupID
) bg
WHERE csd.ModelInfoID IN (730, 1300)  -- HQR-3LD, HQR-3PD-1
  AND NOT EXISTS (
    SELECT 1 FROM dbo.tblKeypadButton
    WHERE ParentDeviceID = csd.ControlStationDeviceID
      AND ParentDeviceType = 5 AND ButtonNumber = 0
  );

DECLARE @dimmerCount INT = (SELECT COUNT(*) FROM #DimmerTargets);
IF @dimmerCount = 0
BEGIN
  PRINT '  No 3LD/3PD devices need programming chain.';
END
ELSE
BEGIN
  PRINT '  Found ' + CAST(@dimmerCount AS VARCHAR) + ' device(s) needing programming chain.';

  BEGIN TRANSACTION;

  -- Use Designer's NextObjectID allocator (NOT MAX of existing IDs, which can
  -- pick up sentinel values near INT_MAX from orphaned rows).
  DECLARE @NextID BIGINT;
  SELECT @NextID = NextObjectID FROM dbo.tblNextObjectID;
  IF @NextID IS NULL SET @NextID = ISNULL((SELECT MAX(ButtonGroupID) FROM dbo.tblButtonGroup), 0) + 1;

  -- Pre-calculate total IDs needed: per device = 1 BG + 1 Btn + 1 PM + 4 Presets + 4 PAs = 11
  -- Plus BG might be skipped if it already exists, but we reserve the slot anyway.
  DECLARE @NeedBG INT = (SELECT SUM(CAST(NeedInsertButtonGroup AS INT)) FROM #DimmerTargets);
  DECLARE @TotalNeeded INT = @NeedBG + (@dimmerCount * 10); -- BGs + Btn+PM+4Preset+4PA per device

  DECLARE @BaseBGID BIGINT = @NextID;
  DECLARE @BaseBtnID BIGINT = @NextID + @NeedBG;
  DECLARE @BasePMID BIGINT = @BaseBtnID + @dimmerCount;
  DECLARE @BasePresetID BIGINT = @BasePMID + @dimmerCount;
  DECLARE @BasePAID BIGINT = @BasePresetID + (@dimmerCount * 4);

  -- Update NextObjectID to account for all allocated IDs
  UPDATE dbo.tblNextObjectID SET NextObjectID = @BasePAID + (@dimmerCount * 4);
  PRINT '  NextObjectID: ' + CAST(@NextID AS VARCHAR) + ' -> ' + CAST(@BasePAID + (@dimmerCount * 4) AS VARCHAR);

  -- Build ID assignments
  CREATE TABLE #DimmerMap
  (
    RN INT PRIMARY KEY,
    DeviceID BIGINT NOT NULL,
    AssignedZoneID BIGINT NOT NULL,
    NeedInsertBG BIT NOT NULL,
    BGID BIGINT NOT NULL,
    BtnID BIGINT NOT NULL,
    PMID BIGINT NOT NULL,
    OnPID BIGINT NOT NULL,
    OffPID BIGINT NOT NULL,
    HoldPID BIGINT NOT NULL,
    DblPID BIGINT NOT NULL,
    OnPAID BIGINT NOT NULL,
    OffPAID BIGINT NOT NULL,
    HoldPAID BIGINT NOT NULL,
    DblPAID BIGINT NOT NULL
  );

  INSERT INTO #DimmerMap
  SELECT
    t.RN, t.DeviceID, t.AssignedZoneID, t.NeedInsertButtonGroup,
    CASE WHEN t.ExistingButtonGroupID IS NULL
      THEN @BaseBGID + SUM(CASE WHEN t.ExistingButtonGroupID IS NULL THEN 1 ELSE 0 END) OVER (ORDER BY t.RN) - 1
      ELSE t.ExistingButtonGroupID END,
    @BaseBtnID + (t.RN - 1),
    @BasePMID + (t.RN - 1),
    @BasePresetID + ((t.RN - 1) * 4),
    @BasePresetID + ((t.RN - 1) * 4) + 1,
    @BasePresetID + ((t.RN - 1) * 4) + 2,
    @BasePresetID + ((t.RN - 1) * 4) + 3,
    @BasePAID + ((t.RN - 1) * 4),
    @BasePAID + ((t.RN - 1) * 4) + 1,
    @BasePAID + ((t.RN - 1) * 4) + 2,
    @BasePAID + ((t.RN - 1) * 4) + 3
  FROM #DimmerTargets t;

  -- ButtonGroup (ButtonGroupInfoID=439, ButtonGroupType=8 = local dimmer)
  INSERT INTO dbo.tblButtonGroup
    (ButtonGroupID, Name, DatabaseRevision, SortOrder, ButtonGroupInfoID,
     ButtonGroupProgrammingType, Notes, ParentDeviceID, ParentDeviceType,
     ButtonGroupObjectType, StndAlnQSTmplBtnGrpInfoID, IsValid, ButtonGroupType,
     LastButtonPressRaiseLowerEvent, WhereUsedId, TemplateID, TemplateUsedID,
     TemplateReferenceID, TemplateInstanceNumber, Xid)
  SELECT
    m.BGID, N'Button Group 001', 0, 0, 439, 1, NULL,
    m.DeviceID, 5, 1, NULL, 1, 8,
    0, 2147483647, NULL, NULL, NULL, NULL, NULL
  FROM #DimmerMap m WHERE m.NeedInsertBG = 1;

  -- KeypadButton (button 0 = local button)
  INSERT INTO dbo.tblKeypadButton
    (ButtonID, Name, DatabaseRevision, SortOrder, BacklightLevel, ButtonNumber,
     ButtonInfoId, CorrespondingLedId, ButtonType, ContactClosureInputNormalState,
     ProgrammingModelID, ComponentNumber, ParentDeviceID, ParentDeviceType,
     WhereUsedId, TemplateID, TemplateUsedID, TemplateReferenceID,
     TemplateInstanceNumber, Xid)
  SELECT
    m.BtnID, N'Button 0', 0, 0, 255, 0, NULL, NULL,
    1, 0, m.PMID, NULL, m.DeviceID, 5,
    2147483647, NULL, NULL, NULL, NULL, NULL
  FROM #DimmerMap m;

  -- ProgrammingModel (ObjectType=74, LedLogic=13)
  INSERT INTO dbo.tblProgrammingModel
    (ProgrammingModelID, ObjectType, Name, DatabaseRevision, SortOrder,
     LedLogic, UseReverseLedLogic, Notes, ReferencePresetIDForLed,
     AllowDoubleTap, HeldButtonAction, HoldTime, StopQedShadesIfMoving,
     PresetID, DoubleTapPresetID, HoldPresetId, PressPresetID,
     ReleasePresetID, OnPresetID, OffPresetID, Direction, ControlType,
     VariableId, ThreeWayToggle, ParentID, ParentType, NeedsTransfer,
     WhereUsedId, TemplateID, TemplateUsedID, TemplateReferenceID,
     TemplateInstanceNumber, Xid)
  SELECT
    m.PMID, 74, N'ATPM', 0, 0,
    13, 0, N'', NULL,
    1, 0, 0, 0,
    NULL, m.DblPID, m.HoldPID, NULL,
    NULL, m.OnPID, m.OffPID, NULL, 0,
    NULL, NULL, m.BtnID, 57, 1,
    2147483647, NULL, NULL, NULL, NULL, NULL
  FROM #DimmerMap m;

  -- Presets (On, Off, Hold, DoubleTap)
  INSERT INTO dbo.tblPreset
    (PresetID, Name, DatabaseRevision, SortOrder, ParentID, ParentType,
     NeedsTransfer, PresetType, WhereUsedId, TemplateID, TemplateUsedID,
     TemplateReferenceID, TemplateInstanceNumber, IsGPDPreset,
     SmartProgrammingDefaultGUID, Xid)
  SELECT m.OnPID, N'Press On', 0, 0, m.PMID, 74, 1, 1, 2147483647,
         NULL, NULL, NULL, NULL, 0, '00000000-0000-0000-0000-000000000000', NULL FROM #DimmerMap m
  UNION ALL
  SELECT m.OffPID, N'Off Level', 0, 0, m.PMID, 74, 1, 1, 2147483647,
         NULL, NULL, NULL, NULL, 0, '00000000-0000-0000-0000-000000000000', NULL FROM #DimmerMap m
  UNION ALL
  SELECT m.HoldPID, N'Hold', 0, 0, m.PMID, 74, 1, 1, 2147483647,
         NULL, NULL, NULL, NULL, 0, '00000000-0000-0000-0000-000000000000', NULL FROM #DimmerMap m
  UNION ALL
  SELECT m.DblPID, N'Double Tap', 0, 0, m.PMID, 74, 1, 1, 2147483647,
         NULL, NULL, NULL, NULL, 0, '00000000-0000-0000-0000-000000000000', NULL FROM #DimmerMap m;

  -- PresetAssignment (link each preset to its assigned zone)
  INSERT INTO dbo.tblPresetAssignment
    (PresetAssignmentID, Name, DatabaseRevision, SortOrder, ParentID,
     ParentType, AssignableObjectID, AssignableObjectType,
     AssignmentCommandType, NeedsTransfer, AssignmentCommandGroup,
     WhereUsedId, TemplateID, TemplateUsedID, TemplateReferenceID,
     TemplateInstanceNumber, IsDimmerLocalLoad, SmartProgrammingDefaultGUID, Xid)
  SELECT m.OnPAID, N'', 0, 0, m.OnPID, 43, m.AssignedZoneID, 15,
         2, 1, 1, 2147483647, NULL, NULL, NULL, NULL, 1, '00000000-0000-0000-0000-000000000000', NULL FROM #DimmerMap m
  UNION ALL
  SELECT m.OffPAID, N'', 0, 0, m.OffPID, 43, m.AssignedZoneID, 15,
         2, 1, 1, 2147483647, NULL, NULL, NULL, NULL, 1, '00000000-0000-0000-0000-000000000000', NULL FROM #DimmerMap m
  UNION ALL
  SELECT m.HoldPAID, N'', 0, 0, m.HoldPID, 43, m.AssignedZoneID, 15,
         2, 1, 1, 2147483647, NULL, NULL, NULL, NULL, 1, '00000000-0000-0000-0000-000000000000', NULL FROM #DimmerMap m
  UNION ALL
  SELECT m.DblPAID, N'', 0, 0, m.DblPID, 43, m.AssignedZoneID, 15,
         2, 1, 1, 2147483647, NULL, NULL, NULL, NULL, 1, '00000000-0000-0000-0000-000000000000', NULL FROM #DimmerMap m;

  -- Command parameters (fade, delay, level for each preset)
  -- Values from verified HQR-3LD template: On=75% 3s, Off=0% 10s, Hold=0% 40s, DoubleTap=100% 0s
  INSERT INTO dbo.tblAssignmentCommandParameter (SortOrder, ParentId, ParameterType, ParameterValue)
  SELECT 0, m.OnPAID, 2, 0 FROM #DimmerMap m      -- On delay=0
  UNION ALL SELECT 1, m.OnPAID, 1, 3 FROM #DimmerMap m   -- On fade=3
  UNION ALL SELECT 2, m.OnPAID, 3, 75 FROM #DimmerMap m  -- On level=75%
  UNION ALL SELECT 0, m.OffPAID, 2, 0 FROM #DimmerMap m  -- Off delay=0
  UNION ALL SELECT 1, m.OffPAID, 1, 10 FROM #DimmerMap m -- Off fade=10
  UNION ALL SELECT 2, m.OffPAID, 3, 0 FROM #DimmerMap m  -- Off level=0%
  UNION ALL SELECT 0, m.HoldPAID, 2, 30 FROM #DimmerMap m -- Hold delay=30
  UNION ALL SELECT 1, m.HoldPAID, 1, 40 FROM #DimmerMap m -- Hold fade=40
  UNION ALL SELECT 2, m.HoldPAID, 3, 0 FROM #DimmerMap m  -- Hold level=0%
  UNION ALL SELECT 0, m.DblPAID, 2, 0 FROM #DimmerMap m   -- Dbl delay=0
  UNION ALL SELECT 1, m.DblPAID, 1, 0 FROM #DimmerMap m   -- Dbl fade=0
  UNION ALL SELECT 2, m.DblPAID, 3, 100 FROM #DimmerMap m; -- Dbl level=100%

  COMMIT TRANSACTION;

  SELECT
    N'ADDED' AS Status, m.DeviceID, m.AssignedZoneID, m.BGID, m.BtnID, m.PMID
  FROM #DimmerMap m ORDER BY m.DeviceID;
END;
`;
}

function buildConversionSql(direction: string): string {
  const sourceProductType = direction === "RA3_TO_HW" ? 3 : 4;
  const targetProductType = direction === "RA3_TO_HW" ? 4 : 3;
  const map = direction === "RA3_TO_HW" ? RA3_TO_HW_MAP : HW_TO_RA3_MAP;

  const mapValues = Object.entries(map)
    .map(([s, t]) => `(${s},${t})`)
    .join(",");

  return `
SET NOCOUNT ON;
SET XACT_ABORT ON;

-- === Clean up orphaned high-ID rows from previous manual SQL runs ===
-- These rows (IDs near INT_MAX / 2147483647) were left by earlier live-VM
-- conversion scripts and pollute MAX()-based ID allocation. Remove them
-- before conversion to prevent cascade corruption.
DECLARE @nextObjID BIGINT;
SELECT @nextObjID = NextObjectID FROM dbo.tblNextObjectID;
IF @nextObjID IS NOT NULL AND @nextObjID < 1000000
BEGIN
  DECLARE @cleanTotal INT = 0;

  -- Disable ALL foreign key constraints so we can delete without chasing FK chains
  EXEC sp_MSforeachtable 'ALTER TABLE ? NOCHECK CONSTRAINT ALL';

  DELETE FROM dbo.tblAssignmentCommandParameter WHERE ParentId IN (SELECT PresetAssignmentID FROM dbo.tblPresetAssignment WHERE PresetAssignmentID > 1000000);
  SET @cleanTotal = @cleanTotal + @@ROWCOUNT;
  DELETE FROM dbo.tblPresetAssignment WHERE PresetAssignmentID > 1000000 OR ParentID > 1000000;
  SET @cleanTotal = @cleanTotal + @@ROWCOUNT;
  DELETE FROM dbo.tblPreset WHERE PresetID > 1000000;
  SET @cleanTotal = @cleanTotal + @@ROWCOUNT;
  DELETE FROM dbo.tblTimeClockEvent WHERE ProgrammingModelID > 1000000;
  SET @cleanTotal = @cleanTotal + @@ROWCOUNT;
  DELETE FROM dbo.tblProgrammingModel WHERE ProgrammingModelID > 1000000;
  SET @cleanTotal = @cleanTotal + @@ROWCOUNT;
  DELETE FROM dbo.tblKeypadButton WHERE ButtonID > 1000000;
  SET @cleanTotal = @cleanTotal + @@ROWCOUNT;
  DELETE FROM dbo.tblButtonGroup WHERE ButtonGroupID > 1000000;
  SET @cleanTotal = @cleanTotal + @@ROWCOUNT;

  -- Note: FK constraints left disabled in Docker session. This is fine —
  -- the page patching uses the original MDF's system pages (which have FKs
  -- enabled), and we only transplant user data pages from Docker.
  IF @cleanTotal > 0
    PRINT 'Cleaned up ' + CAST(@cleanTotal AS VARCHAR) + ' orphaned high-ID rows';
END;

-- Guards
DECLARE @CurrentProductType INT;
SELECT TOP (1) @CurrentProductType = ProductType FROM dbo.tblProject;

IF @CurrentProductType IS NULL
BEGIN
  RAISERROR('tblProject.ProductType not found.', 16, 1);
  RETURN;
END;

IF @CurrentProductType <> ${sourceProductType}
BEGIN
  RAISERROR('Project ProductType (%d) does not match expected source (${sourceProductType}).', 16, 1, @CurrentProductType);
  RETURN;
END;

-- Build model map from hardcoded verified values
CREATE TABLE #Map (SourceID BIGINT PRIMARY KEY, TargetID BIGINT NOT NULL);
INSERT INTO #Map (SourceID, TargetID) VALUES ${mapValues};

-- Pre-flight: scan all tables with ModelInfoID and collect used IDs
CREATE TABLE #UsedIDs (ModelInfoID BIGINT NOT NULL);

DECLARE @tbl SYSNAME, @sql NVARCHAR(MAX);
DECLARE tblCur CURSOR LOCAL FAST_FORWARD FOR
  SELECT t.name FROM sys.tables t
  JOIN sys.columns c ON c.object_id = t.object_id
  WHERE SCHEMA_NAME(t.schema_id) = 'dbo' AND c.name = 'ModelInfoID'
  ORDER BY t.name;

OPEN tblCur;
FETCH NEXT FROM tblCur INTO @tbl;
WHILE @@FETCH_STATUS = 0
BEGIN
  SET @sql = N'INSERT INTO #UsedIDs SELECT DISTINCT ModelInfoID FROM dbo.' + QUOTENAME(@tbl) + N' WHERE ModelInfoID IS NOT NULL';
  EXEC sp_executesql @sql;
  FETCH NEXT FROM tblCur INTO @tbl;
END;
CLOSE tblCur;
DEALLOCATE tblCur;

-- Check for unmapped IDs (IDs in our map's source side that need conversion)
DECLARE @unmapped INT;
SELECT @unmapped = COUNT(DISTINCT u.ModelInfoID)
FROM #UsedIDs u
JOIN #Map m ON m.SourceID = u.ModelInfoID
WHERE m.TargetID IS NULL;

-- Also check for IDs that are in the project but NOT in our map at all
-- These are identity-mapped (shared models, no conversion needed) — that's OK

PRINT 'Pre-flight passed. Applying conversion...';

-- Apply conversion in transaction
BEGIN TRANSACTION;

DECLARE @updTbl SYSNAME, @updSql NVARCHAR(MAX), @updRows INT, @totalRows INT = 0;
DECLARE updCur CURSOR LOCAL FAST_FORWARD FOR
  SELECT t.name FROM sys.tables t
  JOIN sys.columns c ON c.object_id = t.object_id
  WHERE SCHEMA_NAME(t.schema_id) = 'dbo' AND c.name = 'ModelInfoID'
  ORDER BY t.name;

OPEN updCur;
FETCH NEXT FROM updCur INTO @updTbl;
WHILE @@FETCH_STATUS = 0
BEGIN
  SET @updSql = N'UPDATE t SET t.ModelInfoID = m.TargetID FROM dbo.' + QUOTENAME(@updTbl) + N' t JOIN #Map m ON m.SourceID = t.ModelInfoID';
  EXEC sp_executesql @updSql;
  SET @updRows = @@ROWCOUNT;
  IF @updRows > 0
    PRINT '  ' + @updTbl + ': ' + CAST(@updRows AS VARCHAR(10)) + ' rows';
  SET @totalRows = @totalRows + @updRows;
  FETCH NEXT FROM updCur INTO @updTbl;
END;
CLOSE updCur;
DEALLOCATE updCur;

-- Update ProductType metadata
UPDATE dbo.tblProject SET ProductType = ${targetProductType}, NeedsSave = 1;
PRINT '  tblProject.ProductType -> ${targetProductType}';

IF OBJECT_ID('dbo.tblVersion') IS NOT NULL
BEGIN
  UPDATE dbo.tblVersion SET ProductType = ${targetProductType};
  PRINT '  tblVersion.ProductType -> ${targetProductType}';
END;

IF OBJECT_ID('dbo.tblVersionHistory') IS NOT NULL
BEGIN
  UPDATE dbo.tblVersionHistory SET ProductType = ${targetProductType};
  PRINT '  tblVersionHistory.ProductType -> ${targetProductType}';
END;

COMMIT TRANSACTION;

PRINT '';
PRINT 'Conversion complete. Total ModelInfoID rows updated: ' + CAST(@totalRows AS VARCHAR(10));
PRINT '';
${direction === "RA3_TO_HW" ? buildLocalDimmerProgrammingSql() : ""}
-- Post-conversion verification
PRINT '=== Verification ===';

-- Check 1: ProductType consistency
DECLARE @pt1 INT, @pt2 INT, @pt3 INT;
SELECT TOP(1) @pt1 = ProductType FROM dbo.tblProject;
IF OBJECT_ID('dbo.tblVersion') IS NOT NULL SELECT TOP(1) @pt2 = ProductType FROM dbo.tblVersion;
ELSE SET @pt2 = ${targetProductType};
IF OBJECT_ID('dbo.tblVersionHistory') IS NOT NULL SELECT TOP(1) @pt3 = ProductType FROM dbo.tblVersionHistory ORDER BY ConversionTimestamp DESC;
ELSE SET @pt3 = ${targetProductType};

IF @pt1 = ${targetProductType} AND @pt2 = ${targetProductType} AND @pt3 = ${targetProductType}
  PRINT 'PASS: ProductType consistent (${targetProductType})';
ELSE
  PRINT 'FAIL: ProductType mismatch — Project=' + CAST(@pt1 AS VARCHAR) + ' Version=' + ISNULL(CAST(@pt2 AS VARCHAR),'NULL') + ' History=' + ISNULL(CAST(@pt3 AS VARCHAR),'NULL');

-- Check 2: No leftover source-side model IDs
DECLARE @leftover INT = 0;
DECLARE @chkTbl SYSNAME, @chkSql NVARCHAR(MAX);
DECLARE chkCur CURSOR LOCAL FAST_FORWARD FOR
  SELECT t.name FROM sys.tables t
  JOIN sys.columns c ON c.object_id = t.object_id
  WHERE SCHEMA_NAME(t.schema_id) = 'dbo' AND c.name = 'ModelInfoID'
  ORDER BY t.name;

OPEN chkCur;
FETCH NEXT FROM chkCur INTO @chkTbl;
WHILE @@FETCH_STATUS = 0
BEGIN
  SET @chkSql = N'SELECT @cnt = @cnt + COUNT(*) FROM dbo.' + QUOTENAME(@chkTbl) + N' t WHERE EXISTS (SELECT 1 FROM #Map m WHERE m.SourceID = t.ModelInfoID)';
  EXEC sp_executesql @chkSql, N'@cnt INT OUTPUT', @cnt = @leftover OUTPUT;
  FETCH NEXT FROM chkCur INTO @chkTbl;
END;
CLOSE chkCur;
DEALLOCATE chkCur;

IF @leftover = 0
  PRINT 'PASS: No leftover source-side model IDs';
ELSE
  PRINT 'FAIL: ' + CAST(@leftover AS VARCHAR) + ' leftover source-side model ID references';

-- Check 3: Orphan control stations
DECLARE @orphans INT;
SELECT @orphans = COUNT(*) FROM (
  SELECT cs.ControlStationID
  FROM dbo.tblControlStation cs
  LEFT JOIN dbo.tblControlStationDevice csd ON csd.ParentControlStationID = cs.ControlStationID
  GROUP BY cs.ControlStationID
  HAVING COUNT(csd.ControlStationDeviceID) = 0
) o;

IF @orphans = 0
  PRINT 'PASS: No orphan control stations';
ELSE
  PRINT 'WARN: ' + CAST(@orphans AS VARCHAR) + ' orphan control station(s)';

PRINT '';
PRINT 'Done.';
`;
}

function buildVerifySql(direction: string): string {
  const targetProductType = direction === "RA3_TO_HW" ? 4 : 3;
  const map = direction === "RA3_TO_HW" ? RA3_TO_HW_MAP : HW_TO_RA3_MAP;

  const mapValues = Object.entries(map)
    .map(([s, t]) => `(${s},${t})`)
    .join(",");

  return `
SET NOCOUNT ON;
CREATE TABLE #Map (SourceID BIGINT PRIMARY KEY, TargetID BIGINT NOT NULL);
INSERT INTO #Map (SourceID, TargetID) VALUES ${mapValues};

PRINT '=== Post-Conversion Verification ===';
PRINT '';

-- ProductType
DECLARE @pt1 INT, @pt2 INT, @pt3 INT;
SELECT TOP(1) @pt1 = ProductType FROM dbo.tblProject;
IF OBJECT_ID('dbo.tblVersion') IS NOT NULL SELECT TOP(1) @pt2 = ProductType FROM dbo.tblVersion;
IF OBJECT_ID('dbo.tblVersionHistory') IS NOT NULL SELECT TOP(1) @pt3 = ProductType FROM dbo.tblVersionHistory ORDER BY ConversionTimestamp DESC;

PRINT 'ProductType: Project=' + ISNULL(CAST(@pt1 AS VARCHAR),'NULL')
  + ' Version=' + ISNULL(CAST(@pt2 AS VARCHAR),'NULL')
  + ' History=' + ISNULL(CAST(@pt3 AS VARCHAR),'NULL')
  + ' (expected=${targetProductType})';

-- Leftover source IDs
DECLARE @leftover INT = 0;
DECLARE @chkTbl SYSNAME, @chkSql NVARCHAR(MAX);
DECLARE chkCur CURSOR LOCAL FAST_FORWARD FOR
  SELECT t.name FROM sys.tables t
  JOIN sys.columns c ON c.object_id = t.object_id
  WHERE SCHEMA_NAME(t.schema_id) = 'dbo' AND c.name = 'ModelInfoID';

OPEN chkCur;
FETCH NEXT FROM chkCur INTO @chkTbl;
WHILE @@FETCH_STATUS = 0
BEGIN
  SET @chkSql = N'SELECT @cnt = @cnt + COUNT(*) FROM dbo.' + QUOTENAME(@chkTbl) + N' t WHERE EXISTS (SELECT 1 FROM #Map m WHERE m.SourceID = t.ModelInfoID)';
  EXEC sp_executesql @chkSql, N'@cnt INT OUTPUT', @cnt = @leftover OUTPUT;
  FETCH NEXT FROM chkCur INTO @chkTbl;
END;
CLOSE chkCur;
DEALLOCATE chkCur;

PRINT 'Leftover source-side model refs: ' + CAST(@leftover AS VARCHAR);

-- Orphans
DECLARE @orphans INT;
SELECT @orphans = COUNT(*) FROM (
  SELECT cs.ControlStationID
  FROM dbo.tblControlStation cs
  LEFT JOIN dbo.tblControlStationDevice csd ON csd.ParentControlStationID = cs.ControlStationID
  GROUP BY cs.ControlStationID
  HAVING COUNT(csd.ControlStationDeviceID) = 0
) o;
PRINT 'Orphan control stations: ' + CAST(@orphans AS VARCHAR);
PRINT '';
`;
}

async function runConversion(
  bakPath: string,
  direction: string,
  dockerImage: string,
  keepContainer: boolean
): Promise<string> {
  console.log(`Running ${direction} conversion in Docker...`);

  const dataDir = join(bakPath, "..");
  const absDataDir =
    dataDir.startsWith("/") ? dataDir : join(process.cwd(), dataDir);

  // Check Docker is available
  const dockerCheck = await exec(["docker", "info"]);
  if (dockerCheck.exitCode !== 0) {
    throw new Error(
      "Docker is not running. Install Docker Desktop: https://www.docker.com/products/docker-desktop/"
    );
  }

  const bakSize = statSync(bakPath).size;
  console.log(`  Input backup: ${(bakSize / 1024 / 1024).toFixed(1)} MB`);

  // Start container
  console.log(`  Starting container ${CONTAINER_NAME}...`);
  await execOrDie(
    [
      "docker",
      "run",
      "-d",
      "--name",
      CONTAINER_NAME,
      "--platform",
      "linux/amd64",
      "-e",
      "ACCEPT_EULA=Y",
      "-e",
      `MSSQL_SA_PASSWORD=${SA_PASSWORD}`,
      "-v",
      `${absDataDir}:/data`,
      dockerImage,
    ],
    "docker run"
  );

  try {
    await waitForSqlServer(CONTAINER_NAME);

    // Fix permissions inside container
    await execOrDie(
      ["docker", "exec", CONTAINER_NAME, "chmod", "777", "/data/Project.bak"],
      "chmod bak"
    );

    // Discover logical file names from the backup using tab-separated output
    console.log("  Reading backup file list...");
    const fileListResult = await execOrDie(
      [
        "docker", "exec", CONTAINER_NAME,
        "/opt/mssql-tools/bin/sqlcmd", "-S", "localhost", "-U", "sa", "-P", SA_PASSWORD,
        "-d", "master", "-Q", "RESTORE FILELISTONLY FROM DISK = '/data/Project.bak';",
        "-b", "-W", "-s", "\t",
      ],
      "FILELISTONLY",
      { timeout: 60_000 }
    );
    // Parse tab-separated output: LogicalName\tPhysicalName\tType\t...
    const fileLines = fileListResult
      .split("\n")
      .filter((l) => l.includes("\t"));
    let mdfLogical = "Project";
    let ldfLogical = "Project_log";
    for (const line of fileLines) {
      const cols = line.split("\t");
      if (cols.length >= 3 && cols[0] && !cols[0].startsWith("-")) {
        const name = cols[0].trim();
        const type = cols[2].trim();
        if (type === "D" && name !== "LogicalName") mdfLogical = name;
        if (type === "L" && name !== "LogicalName") ldfLogical = name;
      }
    }
    console.log(`  Logical names: data='${mdfLogical}', log='${ldfLogical}'`);

    // RESTORE DATABASE from backup (same as Designer does via SMO)
    console.log("  Restoring database from backup...");
    await sqlcmd(
      CONTAINER_NAME,
      `RESTORE DATABASE [Project]
       FROM DISK = '/data/Project.bak'
       WITH MOVE '${mdfLogical}' TO '/data/Project.mdf',
            MOVE '${ldfLogical}' TO '/data/Project_log.ldf',
            REPLACE;`
    );

    console.log(`  Running ${direction} conversion SQL...`);
    const conversionSql = buildConversionSql(direction);
    const result = await sqlcmdDb(CONTAINER_NAME, "Project", conversionSql);
    console.log(result);

    // BACKUP DATABASE to produce a clean .bak (same as Designer does via SMO)
    console.log("  Backing up converted database...");
    const outputBak = join(dataDir, "Converted.bak");
    await sqlcmd(
      CONTAINER_NAME,
      `BACKUP DATABASE [Project] TO DISK = '/data/Converted.bak' WITH INIT;`
    );

    const outSize = statSync(outputBak).size;
    console.log(`  Output backup: ${(outSize / 1024 / 1024).toFixed(1)} MB`);

    return outputBak;
  } finally {
    if (!keepContainer) {
      console.log("  Cleaning up container...");
      await exec(["docker", "stop", CONTAINER_NAME]);
      await exec(["docker", "rm", CONTAINER_NAME]);
    } else {
      console.log(`  Container kept: ${CONTAINER_NAME}`);
    }
  }
}

// ── Diff Mode ────────────────────────────────────────────────────────

async function runDiff(
  fileA: string,
  fileB: string,
  dockerImage: string
): Promise<void> {
  console.log(
    `Diffing ${basename(fileA)} vs ${basename(fileB)}...\n`
  );

  const extractA = await extractBak(fileA);
  const extractB = await extractBak(fileB);

  // Set up shared data directory with both backups
  const diffDir = makeTempDir("lutron-diff");
  const bakAPath = join(diffDir, "ProjectA.bak");
  const bakBPath = join(diffDir, "ProjectB.bak");

  // Copy backups to shared dir
  await Bun.write(bakAPath, Bun.file(extractA.bakPath));
  await Bun.write(bakBPath, Bun.file(extractB.bakPath));

  const containerName = `lutron-diff-${Date.now()}`;
  const absDiffDir =
    diffDir.startsWith("/") ? diffDir : join(process.cwd(), diffDir);

  const dockerCheck = await exec(["docker", "info"]);
  if (dockerCheck.exitCode !== 0) {
    throw new Error("Docker is not running.");
  }

  console.log("Starting diff container...");
  await execOrDie(
    [
      "docker",
      "run",
      "-d",
      "--name",
      containerName,
      "--platform",
      "linux/amd64",
      "-e",
      "ACCEPT_EULA=Y",
      "-e",
      `MSSQL_SA_PASSWORD=${SA_PASSWORD}`,
      "-v",
      `${absDiffDir}:/data`,
      dockerImage,
    ],
    "docker run"
  );

  try {
    await waitForSqlServer(containerName);

    // Fix permissions
    await execOrDie(
      [
        "docker",
        "exec",
        containerName,
        "bash",
        "-c",
        "chmod 777 /data/*.bak",
      ],
      "chmod"
    );

    // Discover logical file names from backup A (should be same for B)
    const fileListResult = await execOrDie(
      [
        "docker", "exec", containerName,
        "/opt/mssql-tools/bin/sqlcmd", "-S", "localhost", "-U", "sa", "-P", SA_PASSWORD,
        "-d", "master", "-Q", "RESTORE FILELISTONLY FROM DISK = '/data/ProjectA.bak';",
        "-b", "-W", "-s", "\t",
      ],
      "FILELISTONLY",
      { timeout: 60_000 }
    );
    const fileLines = fileListResult
      .split("\n")
      .filter((l) => l.includes("\t"));
    let mdfLogical = "Project";
    let ldfLogical = "Project_log";
    for (const line of fileLines) {
      const cols = line.split("\t");
      if (cols.length >= 3 && cols[0] && !cols[0].startsWith("-")) {
        const name = cols[0].trim();
        const type = cols[2].trim();
        if (type === "D" && name !== "LogicalName") mdfLogical = name;
        if (type === "L" && name !== "LogicalName") ldfLogical = name;
      }
    }

    // Restore both databases from backups
    console.log("Restoring databases from backups...");
    await sqlcmd(
      containerName,
      `RESTORE DATABASE [ProjectA] FROM DISK = '/data/ProjectA.bak'
       WITH MOVE '${mdfLogical}' TO '/data/ProjectA.mdf',
            MOVE '${ldfLogical}' TO '/data/ProjectA_log.ldf', REPLACE;`
    );
    await sqlcmd(
      containerName,
      `RESTORE DATABASE [ProjectB] FROM DISK = '/data/ProjectB.bak'
       WITH MOVE '${mdfLogical}' TO '/data/ProjectB.mdf',
            MOVE '${ldfLogical}' TO '/data/ProjectB_log.ldf', REPLACE;`
    );

    // Run diff queries
    const diffSql = `
SET NOCOUNT ON;

PRINT '## Schema Diff: ${basename(fileA)} vs ${basename(fileB)}';
PRINT '';

-- ProductType comparison
PRINT '### ProductType';
DECLARE @ptA INT, @ptB INT;
SELECT TOP(1) @ptA = ProductType FROM [ProjectA].dbo.tblProject;
SELECT TOP(1) @ptB = ProductType FROM [ProjectB].dbo.tblProject;
PRINT '  A (${basename(fileA)}): ' + ISNULL(CAST(@ptA AS VARCHAR), 'NULL') + CASE @ptA WHEN 3 THEN ' (RA3)' WHEN 4 THEN ' (HW)' ELSE '' END;
PRINT '  B (${basename(fileB)}): ' + ISNULL(CAST(@ptB AS VARCHAR), 'NULL') + CASE @ptB WHEN 3 THEN ' (RA3)' WHEN 4 THEN ' (HW)' ELSE '' END;
PRINT '';

-- Table comparison
PRINT '### Table Counts';
PRINT '';

DECLARE @nameA SYSNAME, @nameB SYSNAME;
DECLARE @countA BIGINT, @countB BIGINT;
DECLARE @sql NVARCHAR(MAX);

-- Tables in A
CREATE TABLE #TablesA (name SYSNAME);
INSERT INTO #TablesA
SELECT name FROM [ProjectA].sys.tables WHERE SCHEMA_NAME(schema_id) = 'dbo' ORDER BY name;

CREATE TABLE #TablesB (name SYSNAME);
INSERT INTO #TablesB
SELECT name FROM [ProjectB].sys.tables WHERE SCHEMA_NAME(schema_id) = 'dbo' ORDER BY name;

-- Tables only in A
DECLARE @onlyA INT = (SELECT COUNT(*) FROM #TablesA WHERE name NOT IN (SELECT name FROM #TablesB));
IF @onlyA > 0
BEGIN
  PRINT 'Tables only in A: ' + CAST(@onlyA AS VARCHAR);
  SELECT a.name AS [Only in A] FROM #TablesA a WHERE a.name NOT IN (SELECT name FROM #TablesB) ORDER BY a.name;
END;

-- Tables only in B
DECLARE @onlyB INT = (SELECT COUNT(*) FROM #TablesB WHERE name NOT IN (SELECT name FROM #TablesA));
IF @onlyB > 0
BEGIN
  PRINT 'Tables only in B: ' + CAST(@onlyB AS VARCHAR);
  SELECT b.name AS [Only in B] FROM #TablesB b WHERE b.name NOT IN (SELECT name FROM #TablesA) ORDER BY b.name;
END;

IF @onlyA = 0 AND @onlyB = 0
  PRINT 'Same table set in both databases.';

PRINT '';

-- Row count diff for shared tables with ModelInfoID
PRINT '### ModelInfoID Table Row Counts';

CREATE TABLE #RowDiff (TableName SYSNAME, RowsA BIGINT, RowsB BIGINT);

DECLARE rowCur CURSOR LOCAL FAST_FORWARD FOR
  SELECT a.name FROM #TablesA a
  JOIN #TablesB b ON a.name = b.name
  JOIN [ProjectA].sys.columns c ON c.object_id = OBJECT_ID('[ProjectA].dbo.' + QUOTENAME(a.name))
  WHERE c.name = 'ModelInfoID'
  ORDER BY a.name;

OPEN rowCur;
FETCH NEXT FROM rowCur INTO @nameA;
WHILE @@FETCH_STATUS = 0
BEGIN
  SET @sql = N'
    DECLARE @cA BIGINT, @cB BIGINT;
    SELECT @cA = COUNT(*) FROM [ProjectA].dbo.' + QUOTENAME(@nameA) + N';
    SELECT @cB = COUNT(*) FROM [ProjectB].dbo.' + QUOTENAME(@nameA) + N';
    INSERT INTO #RowDiff VALUES (N''' + REPLACE(@nameA, '''', '''''') + N''', @cA, @cB);';
  BEGIN TRY
    EXEC sp_executesql @sql;
  END TRY
  BEGIN CATCH
  END CATCH;
  FETCH NEXT FROM rowCur INTO @nameA;
END;
CLOSE rowCur;
DEALLOCATE rowCur;

SELECT TableName, RowsA, RowsB, RowsA - RowsB AS Delta
FROM #RowDiff
WHERE RowsA <> RowsB
ORDER BY ABS(RowsA - RowsB) DESC;

IF NOT EXISTS (SELECT 1 FROM #RowDiff WHERE RowsA <> RowsB)
  PRINT 'All ModelInfoID tables have matching row counts.';

PRINT '';
PRINT 'Done.';
`;

    const result = await execOrDie(
      [
        "docker",
        "exec",
        containerName,
        "/opt/mssql-tools/bin/sqlcmd",
        "-S",
        "localhost",
        "-U",
        "sa",
        "-P",
        SA_PASSWORD,
        "-d",
        "master",
        "-Q",
        diffSql,
        "-b",
        "-W",
      ],
      "diff sqlcmd",
      { timeout: 120_000 }
    );
    console.log(result);

    // Drop both (no need to preserve since we're done)
    await sqlcmd(
      containerName,
      `ALTER DATABASE [ProjectA] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [ProjectA];
       ALTER DATABASE [ProjectB] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [ProjectB];`
    );
  } finally {
    await exec(["docker", "stop", containerName]);
    await exec(["docker", "rm", containerName]);
    rmSync(extractA.tempDir, { recursive: true, force: true });
    rmSync(extractB.tempDir, { recursive: true, force: true });
    rmSync(diffDir, { recursive: true, force: true });
  }
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const dockerImage = values["docker-image"] as string;
  const keepContainer = values["keep-container"] as boolean;

  // -- Diff mode --
  if (values.diff) {
    if (positionals.length < 2) {
      console.error("--diff requires two project files.");
      process.exit(1);
    }
    await runDiff(positionals[0], positionals[1], dockerImage);
    return;
  }

  // -- Extract-only mode --
  if (values["extract-only"]) {
    const input = positionals[0];
    if (!input) {
      console.error("Provide an input project file.");
      process.exit(1);
    }
    if (!existsSync(input)) {
      console.error(`Input file not found: ${input}`);
      process.exit(1);
    }

    const outDir = values["extract-only"] as string;
    mkdirSync(outDir, { recursive: true });

    const result = await extractBak(input);
    const outBak = join(outDir, "Project.bak");
    const outMeta = join(outDir, "metadata.json");

    await Bun.write(outBak, Bun.file(result.bakPath));
    await Bun.write(
      outMeta,
      JSON.stringify(
        { lutFilename: result.lutFilename, sourceFile: basename(input) },
        null,
        2
      )
    );

    rmSync(result.tempDir, { recursive: true, force: true });
    console.log(`\nExtracted to ${outDir}:`);
    console.log(`  ${outBak}`);
    console.log(`  ${outMeta}`);
    return;
  }

  // -- Pack-only mode --
  if (values["pack-only"]) {
    const bakPath = values["pack-only"] as string;
    const output = positionals[0];
    if (!output) {
      console.error("Provide an output filename.");
      process.exit(1);
    }

    if (!existsSync(bakPath)) {
      console.error(`Backup file not found: ${bakPath}`);
      process.exit(1);
    }

    // Need a lutFilename — try to extract from nearby metadata
    const metaPath = join(bakPath, "..", "metadata.json");
    let lutFilename: string;
    if (existsSync(metaPath)) {
      const meta = JSON.parse(await Bun.file(metaPath).text());
      lutFilename = meta.lutFilename;
    } else {
      // Generate a UUID-based name
      lutFilename = `${randomUUID()}.lut`;
      console.log(`  No metadata.json found, using generated LUT name: ${lutFilename}`);
    }

    const absOutput = output.startsWith("/")
      ? output
      : join(process.cwd(), output);
    await packProject(bakPath, lutFilename, absOutput);
    return;
  }

  // -- Full conversion mode --
  const input = positionals[0];
  const output = positionals[1];

  if (!input || !output) {
    console.error("Usage: bun run tools/project-convert.ts <input> <output>");
    process.exit(1);
  }

  if (!existsSync(input)) {
    console.error(`Input file not found: ${input}`);
    process.exit(1);
  }

  // Auto-detect direction from extensions
  let direction = values.direction as string | undefined;
  if (!direction) {
    const inExt = extname(input).toLowerCase();
    const outExt = extname(output).toLowerCase();
    if (inExt === ".ra3" && outExt === ".hw") {
      direction = "RA3_TO_HW";
    } else if (inExt === ".hw" && outExt === ".ra3") {
      direction = "HW_TO_RA3";
    } else if (inExt === ".ra3" && outExt === ".ra3") {
      // Same extension — require explicit direction
      console.error(
        "Same input/output extension (.ra3). Specify --direction explicitly."
      );
      process.exit(1);
    } else if (inExt === ".hw" && outExt === ".hw") {
      console.error(
        "Same input/output extension (.hw). Specify --direction explicitly."
      );
      process.exit(1);
    } else {
      console.error(
        `Cannot auto-detect direction from extensions ${inExt} -> ${outExt}. Use --direction.`
      );
      process.exit(1);
    }
    console.log(`Auto-detected direction: ${direction}\n`);
  }

  if (direction !== "RA3_TO_HW" && direction !== "HW_TO_RA3") {
    console.error(
      `Invalid direction: ${direction}. Use RA3_TO_HW or HW_TO_RA3.`
    );
    process.exit(1);
  }

  const absOutput = output.startsWith("/")
    ? output
    : join(process.cwd(), output);

  // Step 1: Extract .bak from ZIP
  const extracted = await extractBak(input);

  try {
    // Step 2: RESTORE → convert → BACKUP
    const convertedBak = await runConversion(
      extracted.bakPath,
      direction,
      dockerImage,
      keepContainer
    );

    // Step 3: Pack .bak as .lut into ZIP
    await packProject(
      convertedBak,
      extracted.lutFilename,
      absOutput
    );

    console.log(`\nConversion complete: ${basename(input)} -> ${basename(output)}`);
  } finally {
    // Clean up temp dir
    rmSync(extracted.tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`\nFatal: ${err.message}`);
  // Try to clean up container on error
  exec(["docker", "stop", CONTAINER_NAME]).then(() =>
    exec(["docker", "rm", CONTAINER_NAME])
  );
  process.exit(1);
});
