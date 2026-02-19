#!/usr/bin/env bun

/**
 * Offline RA3/HW project file converter.
 *
 * Extracts .ra3/.hw (ZIP → MTF .lut → MDF), runs model-ID + ProductType
 * conversion inside a Docker SQL Server 2022 container, and repacks.
 *
 * No Windows VM, no Designer, no SQLMODELINFO dependency.
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
    template: { type: "string" },
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

Usage:
  bun run tools/project-convert.ts <input.ra3|.hw> <output.ra3|.hw> [options]
  bun run tools/project-convert.ts --diff <fileA> <fileB>

Options:
  --direction <RA3_TO_HW|HW_TO_RA3>  Conversion direction (auto-detected from extensions)
  --extract-only <dir>                Extract MDF to directory, don't convert
  --pack-only <mdf> --template <lut>  Pack MDF back using template LUT
  --docker-image <image>              SQL Server image (default: 2022-RTM-ubuntu-20.04)
  --keep-container                    Don't remove Docker container after conversion
  --diff                              Show schema diff between two project files
  --help                              Show this help
`);
  process.exit(0);
}

// ── Constants ────────────────────────────────────────────────────────

const MTF_HEADER_SIZE = 0x4000; // 16 KB MTF header
const ESET_ALIGNMENT = 0x1000; // 4 KB alignment for MTF structural blocks
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

const SQL_PAGE_SIZE = 8192; // SQL Server page size
const SQL_PAGE_HEADER_SIZE = 96; // SQL Server page header (LSN, checksum, etc.)

/** Known MTF structural block signatures (4-byte ASCII at block start) */
const MTF_SIGNATURES = new Set(["SFMB", "ESET", "TSMP"]);

function isMtfBlock(buf: Buffer, offset: number): boolean {
  if (offset + 4 > buf.length) return false;
  const magic = buf.subarray(offset, offset + 4).toString("ascii");
  return MTF_SIGNATURES.has(magic);
}

/**
 * Find where the MTF structural footer starts in the LUT.
 *
 * The LUT ends with a sequence of 4K-aligned MTF blocks (SFMB, ESET, TSMP).
 * Scan backward from the end at 4K intervals; the lowest contiguous MTF block
 * is where the footer begins. Everything before that is MDF data.
 */
function findMtfFooterStart(buf: Buffer): number {
  let footerStart = buf.length;

  for (
    let off = buf.length - ESET_ALIGNMENT;
    off >= MTF_HEADER_SIZE;
    off -= ESET_ALIGNMENT
  ) {
    if (isMtfBlock(buf, off)) {
      footerStart = off;
    } else {
      // Not an MTF block — this is the last MDF region byte (possibly zero page).
      // The footer starts at the first MTF block above.
      break;
    }
  }

  if (footerStart >= buf.length) {
    throw new Error("No MTF footer blocks found in LUT");
  }
  return footerStart;
}

/** Align offset up to next 4K boundary */
function align4K(offset: number): number {
  return (offset + ESET_ALIGNMENT - 1) & ~(ESET_ALIGNMENT - 1);
}

/**
 * Compute SQL Server page checksum (PAGE_VERIFY = CHECKSUM).
 *
 * Algorithm: XOR all 32-bit words on the page (with the checksum field at
 * bytes 60-63 zeroed), rotating the accumulator left by 1 bit after each
 * 512-byte sector. Verified against 3718 real pages from Designer MDF.
 */
function sqlPageChecksum(page: Buffer): number {
  const saved = page.readUInt32LE(60);
  page.writeUInt32LE(0, 60);
  let c = 0;
  for (let sector = 0; sector < 16; sector++) {
    for (let i = 0; i < 512; i += 4) {
      c = (c ^ page.readUInt32LE(sector * 512 + i)) >>> 0;
    }
    if (sector < 15) c = ((c << 1) | (c >>> 31)) >>> 0;
  }
  page.writeUInt32LE(saved, 60);
  return c;
}

// ── Core: Extract MDF ────────────────────────────────────────────────

interface ExtractResult {
  mdfPath: string;
  templateLutPath: string;
  lutFilename: string;
  tempDir: string;
  /** Original MDF size stored in the LUT (before zero-padding for SQL Server) */
  originalStoredSize: number;
}

async function extractMdf(projectFile: string): Promise<ExtractResult> {
  console.log(`Extracting MDF from ${basename(projectFile)}...`);

  const tempDir = makeTempDir("lutron-extract");
  const unzipDir = join(tempDir, "unzipped");
  mkdirSync(unzipDir);

  // Unzip
  await execOrDie(["unzip", "-o", projectFile, "-d", unzipDir], "unzip");

  // Find .lut file
  const files = readdirSync(unzipDir);
  const lutFile = files.find((f) => f.endsWith(".lut"));
  if (!lutFile) {
    throw new Error(
      `No .lut file found in archive. Contents: ${files.join(", ")}`
    );
  }

  const lutPath = join(unzipDir, lutFile);
  const lutBuf = Buffer.from(await Bun.file(lutPath).arrayBuffer());
  console.log(`  LUT: ${lutFile} (${(lutBuf.length / 1024 / 1024).toFixed(1)} MB)`);

  if (lutBuf.length < MTF_HEADER_SIZE + 8192) {
    throw new Error(`LUT file too small: ${lutBuf.length} bytes`);
  }

  // Find where the MTF footer blocks (SFMB, ESET, TSMP) start.
  // Everything between the 16KB header and the footer is MDF data.
  const footerStart = findMtfFooterStart(lutBuf);
  const storedSize = footerStart - MTF_HEADER_SIZE;
  const footerSize = lutBuf.length - footerStart;

  // Read expected file size from page 0 file header.
  // SQL Server records the total file size (in 8KB pages) at MDF offset 254 (uint32 LE).
  // The LUT only stores used pages; we must zero-pad to the expected size.
  const MDF_SIZE_FIELD_OFFSET = 254; // page 0 body offset 158
  const expectedPages = lutBuf.readUInt32LE(MTF_HEADER_SIZE + MDF_SIZE_FIELD_OFFSET);
  const expectedSize = expectedPages * SQL_PAGE_SIZE;

  console.log(`  Stored: ${storedSize} bytes (${storedSize / SQL_PAGE_SIZE} pages), expected: ${expectedSize} bytes (${expectedPages} pages), footer: ${footerSize} bytes`);

  // Write MDF: stored SQL pages + zero padding to expected size
  const mdfPath = join(tempDir, "Project.mdf");
  if (expectedSize > storedSize) {
    const mdfBuf = Buffer.concat([
      lutBuf.subarray(MTF_HEADER_SIZE, footerStart),
      Buffer.alloc(expectedSize - storedSize, 0),
    ]);
    await Bun.write(mdfPath, mdfBuf);
    console.log(`  Padded MDF: ${storedSize} → ${expectedSize} bytes (+${expectedSize - storedSize} zero bytes)`);
  } else {
    await Bun.write(mdfPath, lutBuf.subarray(MTF_HEADER_SIZE, footerStart));
  }

  // Keep full LUT as template
  const templateLutPath = join(tempDir, "template.lut");
  await Bun.write(templateLutPath, lutBuf);

  return { mdfPath, templateLutPath, lutFilename: lutFile, tempDir, originalStoredSize: storedSize };
}

// ── Core: Pack Project ───────────────────────────────────────────────

async function packProject(
  mdfPath: string,
  templateLutPath: string,
  lutFilename: string,
  outputFile: string
): Promise<void> {
  console.log(`Packing project to ${basename(outputFile)}...`);

  const templateBuf = Buffer.from(
    await Bun.file(templateLutPath).arrayBuffer()
  );
  const newMdf = Buffer.from(await Bun.file(mdfPath).arrayBuffer());

  // Extract template header (first 16KB)
  const header = Buffer.from(templateBuf.subarray(0, MTF_HEADER_SIZE));

  // Find the actual MTF footer blocks in the template (SFMB, ESET, TSMP).
  const templateFooterStart = findMtfFooterStart(templateBuf);
  const mtfFooter = Buffer.from(templateBuf.subarray(templateFooterStart));

  // MDF must be 4K-aligned so the MTF footer starts at a 4K boundary.
  const newFooterOffset = align4K(MTF_HEADER_SIZE + newMdf.length);
  const paddingNeeded = newFooterOffset - MTF_HEADER_SIZE - newMdf.length;

  // Build new LUT: header + MDF + padding-to-4K + MTF footer
  const newLut = Buffer.concat([
    header,
    newMdf,
    Buffer.alloc(paddingNeeded, 0),
    mtfFooter,
  ]);

  // The last SFMB block contains a uint64 LE pointer at offset 0x48 to the
  // first SFMB (footer start). Update it to reflect the new footer position.
  // Scan backward to find the last SFMB.
  for (let off = newLut.length - ESET_ALIGNMENT; off >= newFooterOffset; off -= ESET_ALIGNMENT) {
    if (newLut.subarray(off, off + 4).toString("ascii") === "SFMB") {
      const currentPtr = newLut.readUInt32LE(off + 0x48);
      // Only patch if the pointer looks like a footer offset (> MTF_HEADER_SIZE)
      if (currentPtr >= MTF_HEADER_SIZE && currentPtr !== newFooterOffset) {
        console.log(`  Patching SFMB footer pointer: 0x${currentPtr.toString(16)} → 0x${newFooterOffset.toString(16)}`);
        newLut.writeUInt32LE(newFooterOffset, off + 0x48);
        // Upper 32 bits of uint64 — zero since offsets fit in 32 bits
        newLut.writeUInt32LE(0, off + 0x4c);
      }
      break; // Only patch the last SFMB
    }
  }

  console.log(`  New LUT: ${(newLut.length / 1024 / 1024).toFixed(1)} MB (MDF: ${(newMdf.length / 1024 / 1024).toFixed(1)} MB, footer: ${mtfFooter.length} bytes)`);

  // Write LUT to temp file, then zip with matching ZIP metadata.
  // Designer (.NET) expects create_system=0 (MS-DOS), version=20,
  // external_attr=0. macOS `zip` produces Unix attributes that
  // cause Designer to reject the file.
  const packDir = makeTempDir("lutron-pack");
  const lutPath = join(packDir, lutFilename);
  await Bun.write(lutPath, newLut);

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

# DOS date/time (2026-02-19 12:00:00)
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
      lutPath,
    ],
    "zip (python)",
    { timeout: 120_000 }
  );

  // Clean up pack temp dir
  rmSync(packDir, { recursive: true, force: true });

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
  mdfPath: string,
  direction: string,
  dockerImage: string,
  keepContainer: boolean,
  originalStoredSize?: number
): Promise<string> {
  console.log(`Running ${direction} conversion in Docker...`);

  const mdfDir = join(mdfPath, "..");
  const absMdfDir =
    mdfDir.startsWith("/") ? mdfDir : join(process.cwd(), mdfDir);

  // Check Docker is available
  const dockerCheck = await exec(["docker", "info"]);
  if (dockerCheck.exitCode !== 0) {
    throw new Error(
      "Docker is not running. Install Docker Desktop: https://www.docker.com/products/docker-desktop/"
    );
  }

  // Snapshot the ENTIRE original MDF before Docker touches it.
  const originalMdf = Buffer.from(await Bun.file(mdfPath).arrayBuffer());
  console.log(`  Snapshot original MDF: ${originalMdf.length} bytes (${originalMdf.length / SQL_PAGE_SIZE} pages)`);

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
      `${absMdfDir}:/data`,
      dockerImage,
    ],
    "docker run"
  );

  try {
    await waitForSqlServer(CONTAINER_NAME);

    // Fix MDF permissions inside container
    await execOrDie(
      ["docker", "exec", CONTAINER_NAME, "chmod", "777", "/data/Project.mdf"],
      "chmod mdf"
    );

    // === Two-pass approach ===
    //
    // Docker SQL Server's attach/detach modifies system pages AND internal
    // system catalog data pages (sysschobjs, etc.). These modifications make
    // the MDF incompatible with Designer. To isolate ONLY our conversion
    // changes, we do two attach/detach cycles:
    //
    // Pass 1: Attach + detach with NO conversion → "baseline" MDF
    //   (captures Docker's inherent modifications)
    // Pass 2: Attach + convert + detach → "converted" MDF
    //   (captures Docker's modifications + our changes)
    //
    // Pages that differ between baseline and converted = ONLY our changes.
    // We transplant those into the original MDF, bypassing all Docker artifacts.

    // -- Pass 1: baseline (no conversion) --
    console.log("  Pass 1: baseline attach/detach (no conversion)...");
    await sqlcmd(
      CONTAINER_NAME,
      `CREATE DATABASE [Project] ON (FILENAME = '/data/Project.mdf') FOR ATTACH_FORCE_REBUILD_LOG;`
    );
    await sqlcmd(
      CONTAINER_NAME,
      `ALTER DATABASE [Project] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; EXEC sp_detach_db 'Project', 'true';`
    );
    const baselineMdf = Buffer.from(await Bun.file(mdfPath).arrayBuffer());
    console.log("  Baseline captured.");

    // Restore original MDF for pass 2.
    // Delete the LDF from pass 1 first — otherwise pass 2 attach fails with
    // "Cannot create file '/data/Project_log.ldf' because it already exists."
    await Bun.write(mdfPath, originalMdf);
    await execOrDie(
      ["docker", "exec", CONTAINER_NAME, "rm", "-f", "/data/Project_log.ldf"],
      "delete ldf"
    );
    await execOrDie(
      ["docker", "exec", CONTAINER_NAME, "chmod", "777", "/data/Project.mdf"],
      "chmod mdf"
    );

    // -- Pass 2: conversion --
    console.log("  Pass 2: attach + conversion...");
    await sqlcmd(
      CONTAINER_NAME,
      `CREATE DATABASE [Project] ON (FILENAME = '/data/Project.mdf') FOR ATTACH_FORCE_REBUILD_LOG;`
    );

    console.log(`  Running ${direction} conversion SQL...`);
    const conversionSql = buildConversionSql(direction);
    const result = await sqlcmdDb(CONTAINER_NAME, "Project", conversionSql);
    console.log(result);

    console.log("  Detaching database...");
    await sqlcmd(
      CONTAINER_NAME,
      `ALTER DATABASE [Project] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; EXEC sp_detach_db 'Project', 'true';`
    );
    const convertedMdf = Buffer.from(await Bun.file(mdfPath).arrayBuffer());

    // -- Page-level diff: baseline vs converted --
    //
    // Both Docker passes modify the same system/catalog pages (boot page,
    // file header, GAM, PFS, system catalog data pages) with Docker-specific
    // artifacts. Pages that differ between baseline and converted are ONLY
    // the user data pages our conversion SQL touched.
    //
    // For those pages, we patch ONLY the row data area (bytes 96+), keeping
    // the original page header (LSN, checksum, flags) intact. Then we
    // recalculate the page checksum to cover the modified row data.
    const resultMdf = Buffer.from(originalMdf); // start from pristine original
    const totalPages = Math.min(
      baselineMdf.length, convertedMdf.length, originalMdf.length
    ) / SQL_PAGE_SIZE;
    let userPagesCopied = 0;

    for (let p = 0; p < totalPages; p++) {
      const off = p * SQL_PAGE_SIZE;
      const basePage = baselineMdf.subarray(off, off + SQL_PAGE_SIZE);
      const convPage = convertedMdf.subarray(off, off + SQL_PAGE_SIZE);

      if (basePage.equals(convPage)) continue; // same in both passes → Docker artifact or unchanged

      // This page differs between baseline and converted → our conversion SQL changed it.
      // Patch only the ROW DATA portion (bytes 96+) into the original page,
      // preserving the original page header (LSN, checksum, tornBits, etc.).
      const origPage = resultMdf.subarray(off, off + SQL_PAGE_SIZE);
      let bytesPatched = 0;
      for (let b = SQL_PAGE_HEADER_SIZE; b < SQL_PAGE_SIZE; b++) {
        if (basePage[b] !== convPage[b]) {
          origPage[b] = convPage[b];
          bytesPatched++;
        }
      }

      // Recalculate checksum to cover the modified row data + original header.
      const oldChecksum = origPage.readUInt32LE(60);
      const newChecksum = sqlPageChecksum(origPage);
      origPage.writeUInt32LE(newChecksum, 60);

      userPagesCopied++;
      if (userPagesCopied <= 10) {
        console.log(`    Page ${p}: ${bytesPatched} data bytes patched, checksum 0x${oldChecksum.toString(16)} → 0x${newChecksum.toString(16)}`);
      }
    }

    console.log(`  Page diff: ${userPagesCopied} pages with conversion changes patched into original`);

    // Truncate back to original stored size (strip zero padding).
    const finalSize = originalStoredSize ?? resultMdf.length;
    const finalMdf = finalSize < resultMdf.length
      ? resultMdf.subarray(0, finalSize)
      : resultMdf;

    if (finalSize < resultMdf.length) {
      console.log(`  Truncated MDF: ${resultMdf.length} → ${finalSize} bytes (back to original stored size)`);
    }

    await Bun.write(mdfPath, finalMdf);
    return mdfPath;
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

  const extractA = await extractMdf(fileA);
  const extractB = await extractMdf(fileB);

  // Set up shared data directory with both MDFs
  const diffDir = makeTempDir("lutron-diff");
  const mdfAPath = join(diffDir, "ProjectA.mdf");
  const mdfBPath = join(diffDir, "ProjectB.mdf");

  // Copy MDFs to shared dir
  await Bun.write(mdfAPath, Bun.file(extractA.mdfPath));
  await Bun.write(mdfBPath, Bun.file(extractB.mdfPath));

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
        "chmod 777 /data/*.mdf",
      ],
      "chmod"
    );

    // Attach both
    console.log("Attaching databases...");
    const attachSql = `
      CREATE DATABASE [ProjectA] ON (FILENAME = '/data/ProjectA.mdf') FOR ATTACH_FORCE_REBUILD_LOG;
      CREATE DATABASE [ProjectB] ON (FILENAME = '/data/ProjectB.mdf') FOR ATTACH_FORCE_REBUILD_LOG;
    `;
    await sqlcmd(containerName, attachSql);

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

    // Detach both
    await sqlcmd(
      containerName,
      `ALTER DATABASE [ProjectA] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; EXEC sp_detach_db 'ProjectA', 'true';
       ALTER DATABASE [ProjectB] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; EXEC sp_detach_db 'ProjectB', 'true';`
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

    const result = await extractMdf(input);
    const outMdf = join(outDir, "Project.mdf");
    const outTemplate = join(outDir, "template.lut");
    const outMeta = join(outDir, "metadata.json");

    await Bun.write(outMdf, Bun.file(result.mdfPath));
    await Bun.write(outTemplate, Bun.file(result.templateLutPath));
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
    console.log(`  ${outMdf}`);
    console.log(`  ${outTemplate}`);
    console.log(`  ${outMeta}`);
    return;
  }

  // -- Pack-only mode --
  if (values["pack-only"]) {
    const mdfPath = values["pack-only"] as string;
    const templatePath = values.template as string;
    if (!templatePath) {
      console.error("--pack-only requires --template <lut>");
      process.exit(1);
    }
    const output = positionals[0];
    if (!output) {
      console.error("Provide an output filename.");
      process.exit(1);
    }

    if (!existsSync(mdfPath)) {
      console.error(`MDF not found: ${mdfPath}`);
      process.exit(1);
    }
    if (!existsSync(templatePath)) {
      console.error(`Template not found: ${templatePath}`);
      process.exit(1);
    }

    // Need a lutFilename — try to extract from template dir metadata
    const metaPath = join(templatePath, "..", "metadata.json");
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
    await packProject(mdfPath, templatePath, lutFilename, absOutput);
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

  // Step 1: Extract
  const extracted = await extractMdf(input);

  try {
    // Step 2: Convert
    await runConversion(
      extracted.mdfPath,
      direction,
      dockerImage,
      keepContainer,
      extracted.originalStoredSize
    );

    // Step 3: Repack
    await packProject(
      extracted.mdfPath,
      extracted.templateLutPath,
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
