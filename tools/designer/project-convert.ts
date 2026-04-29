#!/usr/bin/env npx tsx

/**
 * Offline RA3/HW project file converter.
 *
 * The .lut file inside an .ra3/.hw ZIP is a SQL Server BACKUP (.bak) file.
 * Designer uses BACKUP DATABASE / RESTORE DATABASE (via SMO) for all file I/O.
 *
 * This converter: SCP .bak to VM → RESTORE into LocalDB → run conversion SQL
 * → BACKUP → SCP back. Uses the same LocalDB instance as Designer to ensure
 * backup format compatibility. See also designer-project.ts for Docker-based
 * read/write without the VM (uses SQL Server 2022 RTM pinned image).
 */

import { execFileSync } from "child_process";
import { randomUUID } from "crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { basename, dirname, extname, join } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import { config } from "../../lib/config";

const __dir = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));

// ── CLI ──────────────────────────────────────────────────────────────

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    direction: { type: "string" },
    "extract-only": { type: "string" },
    "pack-only": { type: "string" },
    "vm-host": { type: "string", default: config.designer.host },
    "vm-user": { type: "string", default: config.designer.user },
    "vm-pass": { type: "string", default: config.designer.pass },
    diff: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
  allowPositionals: true,
  strict: false,
});

if (values.help || (positionals.length === 0 && !values.diff)) {
  console.log(`
project-convert — Offline RA3/HW project file converter

Uses the Designer VM's LocalDB (via SSH) for RESTORE/BACKUP to ensure format compatibility.

Usage:
  bun run tools/project-convert.ts <input.ra3|.hw> <output.ra3|.hw> [options]
  bun run tools/project-convert.ts --diff <fileA> <fileB>

Options:
  --direction <RA3_TO_HW|HW_TO_RA3>  Conversion direction (auto-detected from extensions)
  --extract-only <dir>                Extract .bak from project ZIP
  --pack-only <bak>                   Pack .bak into project ZIP
  --vm-host <host>                    Designer VM IP (default: config.json)
  --vm-user <user>                    VM SSH user (default: config.json)
  --vm-pass <pass>                    VM SSH password (default: config.json)
  --diff                              Show schema diff between two project files
  --help                              Show this help
`);
  process.exit(0);
}

// ── VM Config ────────────────────────────────────────────────────────

const VM_HOST = values["vm-host"] as string;
const VM_USER = values["vm-user"] as string;
const VM_PASS = values["vm-pass"] as string;
const VM_WORK_DIR = "C:\\Temp\\lutron-convert"; // Working directory on VM

// ── Device-agnostic model mapping engine ────────────────────────────
//
// Builds RA3→HW model ID map at runtime from prefix rules + SQLMODELINFO extract.
// No hardcoded per-device model IDs — works for any RA3 project.
//
// Prefix rules (RA3→HW):
//   RRST-* → HRST-*        (seeTouch keypads)
//   RRD-*  → HQRD-*        (dimmers, with fallback to HQR-* if HQRD doesn't exist)
//   RR-*   → HQR-*         (plug-in dimmers, accessories)
//   PJ*, LMJ* → identity   (picos, powpaks — shared across systems)
//
// Manual overrides (for models that don't follow prefix rules):
const MANUAL_OVERRIDES: Record<string, string> = {
  "RR-PROC3-KIT": "HQP7-RF-2",
  "RR-PROC3-CW": "HQP7-RF-2",
};

interface ModelEntry {
  id: number;
  name: string;
}

function loadModelInfo(): ModelEntry[] {
  const path = join(__dir, "data/model-info.json");
  if (!existsSync(path)) {
    throw new Error(
      `Model info not found: ${path}\nRun: bun run tools/build-model-info.ts`,
    );
  }
  const data = JSON.parse(readFileSync(path, "utf-8"));
  return data.models;
}

function buildModelMap(direction: "RA3_TO_HW" | "HW_TO_RA3"): {
  map: Record<number, number>;
  log: string[];
} {
  const models = loadModelInfo();
  const log: string[] = [];

  // Build name→id lookup (prefer highest ID for duplicates = newest revision)
  const nameToId = new Map<string, number>();
  for (const m of models) {
    const existing = nameToId.get(m.name);
    if (!existing || m.id > existing) {
      nameToId.set(m.name, m.id);
    }
  }

  // Build id→name lookup
  const idToName = new Map<number, string>();
  for (const m of models) {
    idToName.set(m.id, m.name);
  }

  // Prefix rules: [sourcePrefix, targetPrefixes (try in order)]
  const prefixRules: [string, string[]][] =
    direction === "RA3_TO_HW"
      ? [
          ["RRST-", ["HRST-"]],
          ["RRD-", ["HQRD-", "HQR-"]],
          ["RR-", ["HQR-"]],
        ]
      : [
          ["HRST-", ["RRST-"]],
          ["HQRD-", ["RRD-"]],
          ["HQR-", ["RR-", "RRD-"]],
        ];

  const overrides =
    direction === "RA3_TO_HW"
      ? MANUAL_OVERRIDES
      : Object.fromEntries(
          Object.entries(MANUAL_OVERRIDES).map(([k, v]) => [v, k]),
        );

  const map: Record<number, number> = {};

  // Collect all source-side model IDs
  for (const m of models) {
    const name = m.name;

    // Skip identity-mapped models (picos, powpaks, etc.)
    if (
      name.startsWith("PJ") ||
      name.startsWith("LMJ") ||
      name.startsWith("HQ-") ||
      name.startsWith("HQW") ||
      name.startsWith("HQWI") ||
      name.startsWith("HQT-")
    ) {
      continue;
    }

    // Check manual overrides first
    if (overrides[name]) {
      const targetId = nameToId.get(overrides[name]);
      if (targetId !== undefined) {
        map[m.id] = targetId;
        log.push(
          `  ${name} (${m.id}) → ${overrides[name]} (${targetId}) [override]`,
        );
        continue;
      }
    }

    // Apply prefix rules
    for (const [srcPrefix, tgtPrefixes] of prefixRules) {
      if (!name.startsWith(srcPrefix)) continue;
      const suffix = name.slice(srcPrefix.length);

      let matched = false;
      for (const tgtPrefix of tgtPrefixes) {
        const targetName = tgtPrefix + suffix;
        const targetId = nameToId.get(targetName);
        if (targetId !== undefined) {
          map[m.id] = targetId;
          log.push(`  ${name} (${m.id}) → ${targetName} (${targetId})`);
          matched = true;
          break;
        }
      }

      if (!matched) {
        log.push(
          `  ${name} (${m.id}) → NO MATCH (tried: ${tgtPrefixes.map((p) => p + suffix).join(", ")})`,
        );
      }
      break; // Only apply first matching prefix rule
    }
  }

  return { map, log };
}

// Build maps lazily on first use
let _ra3ToHw: Record<number, number> | null = null;
let _hwToRa3: Record<number, number> | null = null;
let _mapLog: string[] = [];

function getModelMap(
  direction: "RA3_TO_HW" | "HW_TO_RA3",
): Record<number, number> {
  if (direction === "RA3_TO_HW") {
    if (!_ra3ToHw) {
      const result = buildModelMap("RA3_TO_HW");
      _ra3ToHw = result.map;
      _mapLog = result.log;
    }
    return _ra3ToHw;
  } else {
    if (!_hwToRa3) {
      const result = buildModelMap("HW_TO_RA3");
      _hwToRa3 = result.map;
      _mapLog = result.log;
    }
    return _hwToRa3;
  }
}

function getMapLog(): string[] {
  return _mapLog;
}

/** Get HW-side dimmer model IDs that need local button programming chains. */
function getDimmerModelIds(): number[] {
  const models = loadModelInfo();
  const ids: number[] = [];
  for (const m of models) {
    // HQR-3LD, HQR-3PD, HQRD-* dimmers — any HW model that's a dimmer target
    if (
      m.name.startsWith("HQRD-") ||
      (m.name.startsWith("HQR-") && /-(3LD|3PD|[0-9]*D)/.test(m.name))
    ) {
      ids.push(m.id);
    }
  }
  return ids;
}

// ── Helpers ──────────────────────────────────────────────────────────

function makeTempDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function exec(
  cmd: string[],
  opts?: { timeout?: number; cwd?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const [bin, ...args] = cmd;
  try {
    const stdout = execFileSync(bin, args, {
      encoding: "utf8",
      timeout: opts?.timeout,
      cwd: opts?.cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      exitCode: err.status ?? 1,
    };
  }
}

async function execOrDie(
  cmd: string[],
  label: string,
  opts?: { timeout?: number; cwd?: string },
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
      `No .lut file found in archive. Contents: ${files.join(", ")}`,
    );
  }

  const lutPath = join(unzipDir, lutFile);
  const lutSize = statSync(lutPath).size;
  console.log(
    `  LUT/BAK: ${lutFile} (${(lutSize / 1024 / 1024).toFixed(1)} MB)`,
  );

  // Copy .lut → .bak for clarity (it's the same file)
  const bakPath = join(tempDir, "Project.bak");
  copyFileSync(lutPath, bakPath);

  return { bakPath, lutFilename: lutFile, tempDir };
}

// ── Core: Pack project ZIP from .bak ────────────────────────────────

async function packProject(
  bakPath: string,
  lutFilename: string,
  outputFile: string,
): Promise<void> {
  console.log(`Packing project to ${basename(outputFile)}...`);

  // The .bak file goes directly into the ZIP as the .lut file.
  // Designer (.NET) expects create_system=0 (MS-DOS), version=20,
  // external_attr=0. macOS `zip` produces Unix attributes that
  // cause Designer to reject the file.
  await execOrDie(
    [
      "python3",
      "-c",
      `
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
    { timeout: 120_000 },
  );

  const outSize = statSync(outputFile).size;
  console.log(
    `  Output: ${basename(outputFile)} (${(outSize / 1024 / 1024).toFixed(1)} MB)`,
  );
}

// ── SSH + PowerShell execution ───────────────────────────────────────
// Same pattern as mcp-designer-db.ts: UTF-16LE base64 EncodedCommand

function encodePowerShell(script: string): string {
  const buf = Buffer.from(script, "utf16le");
  return buf.toString("base64");
}

// SSH ControlMaster for connection multiplexing (avoids rate-limit failures)
const SSH_CONTROL_PATH = `/tmp/lut-ssh-${process.pid}`;
const SSH_OPTS = [
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "PreferredAuthentications=password",
  "-o",
  "LogLevel=ERROR",
  "-o",
  `ControlPath=${SSH_CONTROL_PATH}`,
  "-o",
  "ControlMaster=auto",
  "-o",
  "ControlPersist=60",
];

async function execPowerShell(
  script: string,
  timeout = 120_000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const encoded = encodePowerShell(script);
  try {
    const stdout = execFileSync(
      "/opt/homebrew/bin/sshpass",
      [
        "-p",
        VM_PASS,
        "ssh",
        ...SSH_OPTS,
        `${VM_USER}@${VM_HOST}`,
        "powershell",
        "-EncodedCommand",
        encoded,
      ],
      { encoding: "utf8", timeout, maxBuffer: 10 * 1024 * 1024 },
    );
    return {
      stdout: stdout.replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
      stderr: "",
      exitCode: 0,
    };
  } catch (err: any) {
    return {
      stdout: (err.stdout ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
      stderr: (err.stderr ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
      exitCode: err.status ?? 1,
    };
  }
}

async function scp(
  localPath: string,
  remotePath: string,
  direction: "upload" | "download",
  timeout = 120_000,
): Promise<void> {
  // Windows OpenSSH SCP requires forward slashes in remote paths
  const remotePathFixed = remotePath.replace(/\\/g, "/");
  const args =
    direction === "upload"
      ? [localPath, `${VM_USER}@${VM_HOST}:${remotePathFixed}`]
      : [`${VM_USER}@${VM_HOST}:${remotePathFixed}`, localPath];

  await execOrDie(
    ["/opt/homebrew/bin/sshpass", "-p", VM_PASS, "scp", ...SSH_OPTS, ...args],
    `scp ${direction}`,
    { timeout },
  );
}

/** Discover the LocalDB named pipe (same approach as MCP server). */
async function discoverPipe(): Promise<string> {
  const script = `
$ErrorActionPreference = "Continue"
if ($PSVersionTable.PSVersion.Major -ge 7) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$pipes = Get-ChildItem "\\\\.\\pipe\\" |
  Select-Object -ExpandProperty Name |
  Where-Object { $_ -like "*LOCALDB*" }

if (-not $pipes) {
  Write-Error "No LOCALDB pipe found. Is Designer running?"
  exit 1
}

$foundServer = $null
foreach ($pipe in $pipes) {
  if ($pipe -match "\\\\tsql\\\\query$") {
    $server = "np:\\\\.\\pipe\\$pipe"
  } else {
    $server = "np:\\\\.\\pipe\\$pipe\\tsql\\query"
  }
  & sqlcmd -S $server -E -No -d master -Q "SET NOCOUNT ON; SELECT 1;" -h -1 -W 1>$null 2>$null
  if ($LASTEXITCODE -eq 0) {
    $foundServer = $server
    break
  }
}

if (-not $foundServer) {
  Write-Error "Could not connect to any LOCALDB pipe."
  exit 1
}

Write-Output $foundServer
`;

  const result = await execPowerShell(script, 20_000);
  if (result.exitCode !== 0) {
    throw new Error(
      `Pipe discovery failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout.trim().split("\n")[0].trim();
}

/** Run sqlcmd against a specific database on the VM's LocalDB.
 *  For large SQL, SCP the file to the VM first to avoid SSH command line limits. */
async function vmSqlcmd(
  pipe: string,
  dbName: string,
  sql: string,
  timeout = 120_000,
): Promise<string> {
  // Estimate encoded command size: UTF-16LE doubles, base64 adds 33%
  const estimatedCmdLen = sql.length * 2 * 1.34 + 500;
  const USE_FILE = estimatedCmdLen > 20_000;

  if (USE_FILE) {
    // SCP the SQL file to the VM, then execute with sqlcmd -i
    const localTmp = join(tmpdir(), `convert-${Date.now()}.sql`);
    const remoteTmp = `${VM_WORK_DIR}\\convert-${Date.now()}.sql`;
    writeFileSync(localTmp, sql);

    try {
      await scp(localTmp, remoteTmp, "upload", 30_000);

      const script = `
$ErrorActionPreference = "Continue"
if ($PSVersionTable.PSVersion.Major -ge 7) {
  $PSNativeCommandUseErrorActionPreference = $false
}
& sqlcmd -S '${pipe.replace(/'/g, "''")}' -E -No -d '${dbName.replace(/'/g, "''")}' -b -W -i '${remoteTmp.replace(/'/g, "''")}'
exit $LASTEXITCODE
`;
      const result = await execPowerShell(script, timeout);
      if (result.exitCode !== 0) {
        const combined = result.stderr + result.stdout;
        throw new Error(
          `SQL error (exit ${result.exitCode}): ${combined.trim()}`,
        );
      }
      return result.stdout;
    } finally {
      rmSync(localTmp, { force: true });
      await execPowerShell(
        `Remove-Item -Path '${remoteTmp}' -Force -ErrorAction SilentlyContinue`,
        5_000,
      ).catch(() => {});
    }
  }

  // Small SQL: embed directly in PowerShell here-string
  const script = `
$ErrorActionPreference = "Continue"
if ($PSVersionTable.PSVersion.Major -ge 7) {
  $PSNativeCommandUseErrorActionPreference = $false
}
$tempFile = [System.IO.Path]::GetTempFileName() + ".sql"
@'
${sql}
'@ | Set-Content -Path $tempFile -Encoding UTF8
try {
  & sqlcmd -S '${pipe.replace(/'/g, "''")}' -E -No -d '${dbName.replace(/'/g, "''")}' -b -W -i $tempFile
  exit $LASTEXITCODE
} finally {
  Remove-Item -Path $tempFile -Force -ErrorAction SilentlyContinue
}
`;

  const result = await execPowerShell(script, timeout);
  if (result.exitCode !== 0) {
    const combined = result.stderr + result.stdout;
    throw new Error(`SQL error (exit ${result.exitCode}): ${combined.trim()}`);
  }
  return result.stdout;
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
WHERE csd.ModelInfoID IN (${getDimmerModelIds().join(", ")})  -- All HW dimmer models (device-agnostic)
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
  const map = getModelMap(direction as "RA3_TO_HW" | "HW_TO_RA3");
  const log = getMapLog();

  if (log.length > 0) {
    console.log(`\nModel mapping (${Object.keys(map).length} entries):`);
    for (const line of log) console.log(line);
    console.log();
  }

  if (Object.keys(map).length === 0) {
    throw new Error(
      "No model mappings found. Check tools/data/model-info.json",
    );
  }

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

  -- Temporarily disable FK constraints for cleanup, then re-enable
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

  -- Re-enable FK constraints (CHECK = enabled for new operations, not re-validated)
  EXEC sp_MSforeachtable 'ALTER TABLE ? CHECK CONSTRAINT ALL';

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

function _buildVerifySql(direction: string): string {
  const targetProductType = direction === "RA3_TO_HW" ? 4 : 3;
  const map = getModelMap(direction as "RA3_TO_HW" | "HW_TO_RA3");

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
): Promise<string> {
  console.log(`Running ${direction} conversion via VM LocalDB (${VM_HOST})...`);

  const bakSize = statSync(bakPath).size;
  console.log(`  Input backup: ${(bakSize / 1024 / 1024).toFixed(1)} MB`);

  // Discover LocalDB pipe
  console.log("  Discovering LocalDB pipe...");
  const pipe = await discoverPipe();
  console.log(`  Pipe: ${pipe}`);

  // Create working directory on VM
  const dbName = `Convert_${Date.now()}`;
  const remoteBak = `${VM_WORK_DIR}\\Project.bak`;
  const remoteConvertedBak = `${VM_WORK_DIR}\\Converted.bak`;
  const remoteMdf = `${VM_WORK_DIR}\\${dbName}.mdf`;
  const remoteLdf = `${VM_WORK_DIR}\\${dbName}_log.ldf`;

  await execPowerShell(
    `New-Item -ItemType Directory -Force -Path '${VM_WORK_DIR}' | Out-Null`,
    10_000,
  );

  // Upload .bak to VM
  console.log("  Uploading backup to VM...");
  await scp(bakPath, remoteBak, "upload", 120_000);

  try {
    // Discover logical file names from backup
    console.log("  Reading backup file list...");
    const fileListResult = await vmSqlcmd(
      pipe,
      "master",
      `RESTORE FILELISTONLY FROM DISK = '${remoteBak.replace(/'/g, "''")}';`,
      30_000,
    );

    // Parse output for logical names
    let mdfLogical = "Project";
    let ldfLogical = "Project_log";
    for (const line of fileListResult.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("-") || trimmed.startsWith("Logical"))
        continue;
      // sqlcmd default output: columns separated by spaces, Type is 3rd column
      // Look for lines containing .mdf or .ldf paths
      if (trimmed.includes(".mdf") && !trimmed.includes(".ldf")) {
        const name = trimmed.split(/\s+/)[0];
        if (name && name !== "LogicalName") mdfLogical = name;
      } else if (trimmed.includes(".ldf") || trimmed.includes(".LDF")) {
        const name = trimmed.split(/\s+/)[0];
        if (name && name !== "LogicalName") ldfLogical = name;
      }
    }
    console.log(`  Logical names: data='${mdfLogical}', log='${ldfLogical}'`);

    // RESTORE DATABASE
    console.log("  Restoring database from backup...");
    await vmSqlcmd(
      pipe,
      "master",
      `RESTORE DATABASE [${dbName}]
       FROM DISK = '${remoteBak.replace(/'/g, "''")}'
       WITH MOVE '${mdfLogical}' TO '${remoteMdf.replace(/'/g, "''")}',
            MOVE '${ldfLogical}' TO '${remoteLdf.replace(/'/g, "''")}',
            REPLACE;`,
      120_000,
    );

    // Run conversion SQL
    console.log(`  Running ${direction} conversion SQL...`);
    const conversionSql = buildConversionSql(direction);
    const result = await vmSqlcmd(pipe, dbName, conversionSql, 120_000);
    console.log(result);

    // BACKUP converted database
    console.log("  Backing up converted database...");
    await vmSqlcmd(
      pipe,
      "master",
      `BACKUP DATABASE [${dbName}] TO DISK = '${remoteConvertedBak.replace(/'/g, "''")}' WITH INIT;`,
      120_000,
    );

    // Download converted .bak
    console.log("  Downloading converted backup...");
    const localOutput = join(bakPath, "..", "Converted.bak");
    await scp(localOutput, remoteConvertedBak, "download", 120_000);

    const outSize = statSync(localOutput).size;
    console.log(`  Output backup: ${(outSize / 1024 / 1024).toFixed(1)} MB`);

    return localOutput;
  } finally {
    // Clean up: drop database and remove temp files on VM
    console.log("  Cleaning up VM...");
    try {
      await vmSqlcmd(
        pipe,
        "master",
        `IF DB_ID('${dbName}') IS NOT NULL
         BEGIN
           ALTER DATABASE [${dbName}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
           DROP DATABASE [${dbName}];
         END`,
        30_000,
      );
    } catch {
      // Best-effort cleanup
    }
    try {
      await execPowerShell(
        `Remove-Item -Path '${VM_WORK_DIR}\\*' -Force -ErrorAction SilentlyContinue`,
        10_000,
      );
    } catch {
      // Best-effort cleanup
    }
  }
}

// ── Diff Mode ────────────────────────────────────────────────────────

async function runDiff(fileA: string, fileB: string): Promise<void> {
  console.log(`Diffing ${basename(fileA)} vs ${basename(fileB)}...\n`);

  const extractA = await extractBak(fileA);
  const extractB = await extractBak(fileB);

  const dbNameA = `DiffA_${Date.now()}`;
  const dbNameB = `DiffB_${Date.now()}`;

  try {
    console.log("Discovering LocalDB pipe...");
    const pipe = await discoverPipe();

    // Create working directory on VM
    await execPowerShell(
      `New-Item -ItemType Directory -Force -Path '${VM_WORK_DIR}' | Out-Null`,
      10_000,
    );

    // Upload both backups
    console.log("Uploading backups to VM...");
    await scp(extractA.bakPath, `${VM_WORK_DIR}\\ProjectA.bak`, "upload");
    await scp(extractB.bakPath, `${VM_WORK_DIR}\\ProjectB.bak`, "upload");

    // Restore both
    console.log("Restoring databases...");
    await vmSqlcmd(
      pipe,
      "master",
      `RESTORE DATABASE [${dbNameA}]
       FROM DISK = '${VM_WORK_DIR}\\ProjectA.bak'
       WITH MOVE 'Project' TO '${VM_WORK_DIR}\\${dbNameA}.mdf',
            MOVE 'Project_log' TO '${VM_WORK_DIR}\\${dbNameA}_log.ldf', REPLACE;`,
    );
    await vmSqlcmd(
      pipe,
      "master",
      `RESTORE DATABASE [${dbNameB}]
       FROM DISK = '${VM_WORK_DIR}\\ProjectB.bak'
       WITH MOVE 'Project' TO '${VM_WORK_DIR}\\${dbNameB}.mdf',
            MOVE 'Project_log' TO '${VM_WORK_DIR}\\${dbNameB}_log.ldf', REPLACE;`,
    );

    // Run diff queries
    const diffSql = `
SET NOCOUNT ON;

PRINT '## Schema Diff: ${basename(fileA)} vs ${basename(fileB)}';
PRINT '';

PRINT '### ProductType';
DECLARE @ptA INT, @ptB INT;
SELECT TOP(1) @ptA = ProductType FROM [${dbNameA}].dbo.tblProject;
SELECT TOP(1) @ptB = ProductType FROM [${dbNameB}].dbo.tblProject;
PRINT '  A (${basename(fileA)}): ' + ISNULL(CAST(@ptA AS VARCHAR), 'NULL') + CASE @ptA WHEN 3 THEN ' (RA3)' WHEN 4 THEN ' (HW)' ELSE '' END;
PRINT '  B (${basename(fileB)}): ' + ISNULL(CAST(@ptB AS VARCHAR), 'NULL') + CASE @ptB WHEN 3 THEN ' (RA3)' WHEN 4 THEN ' (HW)' ELSE '' END;
PRINT '';

PRINT '### Table Counts';
PRINT '';

DECLARE @nameA SYSNAME, @sql NVARCHAR(MAX);

CREATE TABLE #TablesA (name SYSNAME);
INSERT INTO #TablesA SELECT name FROM [${dbNameA}].sys.tables WHERE SCHEMA_NAME(schema_id) = 'dbo' ORDER BY name;

CREATE TABLE #TablesB (name SYSNAME);
INSERT INTO #TablesB SELECT name FROM [${dbNameB}].sys.tables WHERE SCHEMA_NAME(schema_id) = 'dbo' ORDER BY name;

DECLARE @onlyA INT = (SELECT COUNT(*) FROM #TablesA WHERE name NOT IN (SELECT name FROM #TablesB));
IF @onlyA > 0
BEGIN
  PRINT 'Tables only in A: ' + CAST(@onlyA AS VARCHAR);
  SELECT a.name AS [Only in A] FROM #TablesA a WHERE a.name NOT IN (SELECT name FROM #TablesB) ORDER BY a.name;
END;

DECLARE @onlyB INT = (SELECT COUNT(*) FROM #TablesB WHERE name NOT IN (SELECT name FROM #TablesA));
IF @onlyB > 0
BEGIN
  PRINT 'Tables only in B: ' + CAST(@onlyB AS VARCHAR);
  SELECT b.name AS [Only in B] FROM #TablesB b WHERE b.name NOT IN (SELECT name FROM #TablesA) ORDER BY b.name;
END;

IF @onlyA = 0 AND @onlyB = 0
  PRINT 'Same table set in both databases.';

PRINT '';
PRINT '### ModelInfoID Table Row Counts';

CREATE TABLE #RowDiff (TableName SYSNAME, RowsA BIGINT, RowsB BIGINT);

DECLARE rowCur CURSOR LOCAL FAST_FORWARD FOR
  SELECT a.name FROM #TablesA a
  JOIN #TablesB b ON a.name = b.name
  JOIN [${dbNameA}].sys.columns c ON c.object_id = OBJECT_ID('[${dbNameA}].dbo.' + QUOTENAME(a.name))
  WHERE c.name = 'ModelInfoID'
  ORDER BY a.name;

OPEN rowCur;
FETCH NEXT FROM rowCur INTO @nameA;
WHILE @@FETCH_STATUS = 0
BEGIN
  SET @sql = N'
    DECLARE @cA BIGINT, @cB BIGINT;
    SELECT @cA = COUNT(*) FROM [${dbNameA}].dbo.' + QUOTENAME(@nameA) + N';
    SELECT @cB = COUNT(*) FROM [${dbNameB}].dbo.' + QUOTENAME(@nameA) + N';
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
FROM #RowDiff WHERE RowsA <> RowsB
ORDER BY ABS(RowsA - RowsB) DESC;

IF NOT EXISTS (SELECT 1 FROM #RowDiff WHERE RowsA <> RowsB)
  PRINT 'All ModelInfoID tables have matching row counts.';

PRINT '';
PRINT 'Done.';
`;

    const result = await vmSqlcmd(pipe, "master", diffSql, 120_000);
    console.log(result);
  } finally {
    // Clean up databases and files on VM
    console.log("Cleaning up...");
    const pipe = await discoverPipe().catch(() => null);
    if (pipe) {
      try {
        await vmSqlcmd(
          pipe,
          "master",
          `IF DB_ID('${dbNameA}') IS NOT NULL BEGIN ALTER DATABASE [${dbNameA}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${dbNameA}]; END;
           IF DB_ID('${dbNameB}') IS NOT NULL BEGIN ALTER DATABASE [${dbNameB}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${dbNameB}]; END;`,
        );
      } catch {
        /* best-effort */
      }
    }
    try {
      await execPowerShell(
        `Remove-Item -Path '${VM_WORK_DIR}\\*' -Force -ErrorAction SilentlyContinue`,
        10_000,
      );
    } catch {
      /* best-effort */
    }
    rmSync(extractA.tempDir, { recursive: true, force: true });
    rmSync(extractB.tempDir, { recursive: true, force: true });
  }
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // -- Diff mode --
  if (values.diff) {
    if (positionals.length < 2) {
      console.error("--diff requires two project files.");
      process.exit(1);
    }
    await runDiff(positionals[0], positionals[1]);
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

    copyFileSync(result.bakPath, outBak);
    writeFileSync(
      outMeta,
      JSON.stringify(
        { lutFilename: result.lutFilename, sourceFile: basename(input) },
        null,
        2,
      ),
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
      const meta = JSON.parse(readFileSync(metaPath, "utf8"));
      lutFilename = meta.lutFilename;
    } else {
      // Generate a UUID-based name
      lutFilename = `${randomUUID()}.lut`;
      console.log(
        `  No metadata.json found, using generated LUT name: ${lutFilename}`,
      );
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
        "Same input/output extension (.ra3). Specify --direction explicitly.",
      );
      process.exit(1);
    } else if (inExt === ".hw" && outExt === ".hw") {
      console.error(
        "Same input/output extension (.hw). Specify --direction explicitly.",
      );
      process.exit(1);
    } else {
      console.error(
        `Cannot auto-detect direction from extensions ${inExt} -> ${outExt}. Use --direction.`,
      );
      process.exit(1);
    }
    console.log(`Auto-detected direction: ${direction}\n`);
  }

  if (direction !== "RA3_TO_HW" && direction !== "HW_TO_RA3") {
    console.error(
      `Invalid direction: ${direction}. Use RA3_TO_HW or HW_TO_RA3.`,
    );
    process.exit(1);
  }

  const absOutput = output.startsWith("/")
    ? output
    : join(process.cwd(), output);

  // Step 1: Extract .bak from ZIP
  const extracted = await extractBak(input);

  try {
    // Step 2: RESTORE → convert → BACKUP (on VM's LocalDB)
    const convertedBak = await runConversion(extracted.bakPath, direction);

    // Step 3: Pack .bak as .lut into ZIP
    await packProject(convertedBak, extracted.lutFilename, absOutput);

    console.log(
      `\nConversion complete: ${basename(input)} -> ${basename(output)}`,
    );
  } finally {
    // Clean up temp dir
    rmSync(extracted.tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`\nFatal: ${err.message}`);
  process.exit(1);
});
