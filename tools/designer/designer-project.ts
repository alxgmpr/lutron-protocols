#!/usr/bin/env npx tsx

/**
 * designer-project — Read/write Lutron Designer project files (.hw/.ra3).
 *
 * Reading: Docker SQL Server 2022 RTM (local, no VM needed)
 * Writing: Docker for BACKUP, then VM LocalDB for re-BACKUP (Linux SQL Server
 *          produces sysfiles1 incompatible with Windows LocalDB — cross-platform
 *          system table format difference, not a version issue).
 *
 * File format: .hw/.ra3 → ZIP → <uuid>.lut → SQL Server BACKUP (MTF tape format)
 *
 * Usage:
 *   npx tsx tools/designer-project.ts open <project.hw|.ra3>   Open project, start interactive SQL
 *   npx tsx tools/designer-project.ts query <sql>               Run SQL against open project
 *   npx tsx tools/designer-project.ts tables [filter]           List tables (optional LIKE filter)
 *   npx tsx tools/designer-project.ts describe <table>          Show table schema
 *   npx tsx tools/designer-project.ts dump <table> [limit]      Dump table rows (default 50)
 *   npx tsx tools/designer-project.ts save <output.hw|.ra3>     Save modified project (uses VM)
 *   npx tsx tools/designer-project.ts close                     Drop database, stop container
 *   npx tsx tools/designer-project.ts status                    Show container/database status
 *   npx tsx tools/designer-project.ts run-sql <file.sql>        Run SQL script file
 *   npx tsx tools/designer-project.ts add-device <area> <name> [--model <id>]  Add a device to an area
 */

import { execFileSync, execSync } from "child_process";
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
import { basename, dirname, join } from "path";
import { fileURLToPath } from "url";

const __dir = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dir, "..");

// ── Docker config ───────────────────────────────────────────────────

const CONTAINER_NAME = "lutron-sql2022";
const IMAGE = "mcr.microsoft.com/mssql/server:2022-RTM-ubuntu-20.04";
const SA_PASSWORD = "LutronDev123!";
const DB_NAME = "Project";
const DATA_DIR = "/var/opt/mssql/data"; // inside container

// sysfiles1 page splice: Linux SQL Server writes sysfiles1 with Linux paths
// (/var/opt/mssql/...) which Windows LocalDB rejects as "sysfiles1 is corrupted".
// Fix: save the original Windows sysfiles1 page during open, splice it back
// into the Docker backup during save. The page only contains status, fileid,
// logical name, and physical filename — no size/growth fields (those are in
// sys.database_files, a different table). So the splice is safe regardless of
// DB size changes.
const SYSFILES_PAGE_FILE = join(PROJECT_ROOT, ".designer-sysfiles1-page.bin");

// State file tracks the open project so commands work across invocations
const STATE_FILE = join(PROJECT_ROOT, ".designer-project-state.json");

interface ProjectState {
  sourceFile: string;
  lutFilename: string;
  containerId: string;
  openedAt: string;
}

// ── CLI ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

if (!command || command === "--help" || command === "-h") {
  console.log(
    readFileSync(fileURLToPath(import.meta.url), "utf8")
      .split("\n")
      .filter((l) => l.startsWith(" *"))
      .map((l) => l.replace(/^ \* ?/, ""))
      .join("\n"),
  );
  process.exit(0);
}

// ── Docker helpers ──────────────────────────────────────────────────

function docker(args: string[], opts?: { timeout?: number }): string {
  try {
    return execFileSync("docker", args, {
      encoding: "utf8",
      timeout: opts?.timeout ?? 30_000,
      maxBuffer: 10 * 1024 * 1024,
    }).trim();
  } catch (err: any) {
    const msg = (err.stderr ?? err.stdout ?? err.message ?? "").trim();
    throw new Error(`docker ${args[0]} failed: ${msg}`);
  }
}

function dockerExec(
  containerArgs: string[],
  opts?: { timeout?: number },
): string {
  return docker(["exec", CONTAINER_NAME, ...containerArgs], opts);
}

function sqlcmd(
  sql: string,
  opts?: { timeout?: number; raw?: boolean },
): string {
  const timeout = opts?.timeout ?? 60_000;
  const sqlcmdArgs = [
    "/opt/mssql-tools/bin/sqlcmd",
    "-S",
    "localhost",
    "-U",
    "sa",
    "-P",
    SA_PASSWORD,
    "-d",
    DB_NAME,
    "-Q",
    sql,
    "-W", // trim trailing spaces
    "-s",
    "\t", // tab separator
  ];
  if (!opts?.raw) {
    sqlcmdArgs.push("-h", "-1"); // no headers, no dashes
  }
  return dockerExec(sqlcmdArgs, { timeout });
}

function sqlcmdMaster(sql: string, opts?: { timeout?: number }): string {
  return dockerExec(
    [
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
      sql,
      "-W",
      "-h",
      "-1",
    ],
    opts,
  );
}

// ── Container lifecycle ─────────────────────────────────────────────

function isContainerRunning(): boolean {
  try {
    const status = docker([
      "inspect",
      "-f",
      "{{.State.Running}}",
      CONTAINER_NAME,
    ]);
    return status === "true";
  } catch {
    return false;
  }
}

function containerExists(): boolean {
  try {
    docker(["inspect", CONTAINER_NAME]);
    return true;
  } catch {
    return false;
  }
}

function ensureContainer(): void {
  if (isContainerRunning()) return;

  if (containerExists()) {
    console.log("Starting existing SQL Server container...");
    docker(["start", CONTAINER_NAME], { timeout: 30_000 });
  } else {
    console.log(`Pulling and starting SQL Server 2022 RTM container...`);
    docker(
      [
        "run",
        "-d",
        "--name",
        CONTAINER_NAME,
        "-e",
        "ACCEPT_EULA=Y",
        "-e",
        `MSSQL_SA_PASSWORD=${SA_PASSWORD}`,
        "-e",
        "MSSQL_PID=Developer",
        IMAGE,
      ],
      { timeout: 120_000 },
    );
  }

  // Wait for SQL Server to be ready
  console.log("Waiting for SQL Server to start...");
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const result = dockerExec(
        [
          "/opt/mssql-tools/bin/sqlcmd",
          "-S",
          "localhost",
          "-U",
          "sa",
          "-P",
          SA_PASSWORD,
          "-Q",
          "SELECT 1",
          "-h",
          "-1",
          "-W",
        ],
        { timeout: 5_000 },
      );
      if (result.includes("1")) {
        console.log("SQL Server ready.");
        return;
      }
    } catch {
      // Not ready yet
    }
    execSync("sleep 1");
  }
  throw new Error("SQL Server failed to start within 60 seconds");
}

// ── Project file handling ───────────────────────────────────────────

function extractBak(projectFile: string): {
  bakPath: string;
  lutFilename: string;
  tempDir: string;
} {
  const absPath = projectFile.startsWith("/")
    ? projectFile
    : join(process.cwd(), projectFile);
  if (!existsSync(absPath)) throw new Error(`File not found: ${absPath}`);

  console.log(`Extracting ${basename(absPath)}...`);
  const tempDir = join(tmpdir(), `designer-${randomUUID().slice(0, 8)}`);
  mkdirSync(tempDir, { recursive: true });

  execFileSync("unzip", ["-o", absPath, "-d", tempDir], {
    encoding: "utf8",
    timeout: 30_000,
  });

  const files = readdirSync(tempDir);
  const lutFile = files.find((f) => f.endsWith(".lut"));
  if (!lutFile) {
    throw new Error(`No .lut in archive. Contents: ${files.join(", ")}`);
  }

  const bakPath = join(tempDir, "Project.bak");
  copyFileSync(join(tempDir, lutFile), bakPath);

  const sizeMB = (statSync(bakPath).size / 1024 / 1024).toFixed(1);
  console.log(`  ${lutFile} → Project.bak (${sizeMB} MB)`);

  return { bakPath, lutFilename: lutFile, tempDir };
}

function packProject(
  bakPath: string,
  lutFilename: string,
  outputFile: string,
): void {
  console.log(`Packing ${basename(outputFile)}...`);

  // Build ZIP with exact MS-DOS attributes matching Designer output.
  // Python is required because macOS zip produces Unix attributes that Designer rejects.
  execFileSync(
    "python3",
    [
      "-c",
      `
import zipfile, struct, sys, os, zlib, time

out_path = sys.argv[1]
arc_name = sys.argv[2].encode()
lut_path = sys.argv[3]

with open(lut_path, 'rb') as f:
    data = f.read()

compressed = zlib.compress(data, 6)[2:-4]  # raw deflate
crc = zlib.crc32(data) & 0xFFFFFFFF

now = time.localtime()
dos_time = (now.tm_hour << 11) | (now.tm_min << 5) | (now.tm_sec // 2)
dos_date = ((now.tm_year - 1980) << 9) | (now.tm_mon << 5) | now.tm_mday

local = struct.pack('<IHHHHHIIIHH',
    0x04034b50, 20, 0, 8, dos_time, dos_date,
    crc, len(compressed), len(data), len(arc_name), 0)

central = struct.pack('<IHHHHHHIIIHHHHHII',
    0x02014b50, 20, 20, 0, 8, dos_time, dos_date,
    crc, len(compressed), len(data), len(arc_name),
    0, 0, 0, 0, 0, 0)

cd_offset = len(local) + len(arc_name) + len(compressed)
cd_size = len(central) + len(arc_name)
eocd = struct.pack('<IHHHHIIH',
    0x06054b50, 0, 0, 1, 1, cd_size, cd_offset, 0)

with open(out_path, 'wb') as f:
    f.write(local)
    f.write(arc_name)
    f.write(compressed)
    f.write(central)
    f.write(arc_name)
    f.write(eocd)

print(f'  {os.path.getsize(out_path) / 1024 / 1024:.1f} MB, CRC={crc:08x}')
`,
      outputFile,
      lutFilename,
      bakPath,
    ],
    { encoding: "utf8", timeout: 120_000 },
  );
}

// ── State management ────────────────────────────────────────────────

function saveState(state: ProjectState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadState(): ProjectState | null {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function clearState(): void {
  if (existsSync(STATE_FILE)) rmSync(STATE_FILE);
}

function requireState(): ProjectState {
  const state = loadState();
  if (!state) {
    throw new Error(
      "No project open. Run: npx tsx tools/designer-project.ts open <file>",
    );
  }
  return state;
}

// ── Commands ────────────────────────────────────────────────────────

// ── sysfiles1 page handling ─────────────────────────────────────────
//
// Find the sysfiles1 data page in a .bak file by searching for the
// nchar(128) 'Project' name field followed by the nchar(260) filename field
// containing a Windows drive letter path (C:\...).
// Returns the stream page index (0-based from 0x4000).

function findSysfilesPageIndex(bakData: Buffer): number {
  const PAGE_SIZE = 8192;
  const dataStart = 0x4000;

  // sysfiles1 record: status(4) + fileid(2) + name(nchar128=256) + filename(nchar260=520)
  // fileid=1 at record offset +0x08, filename at +0x10a
  // Search for fileid=1 (0x01 0x00) followed by 'P\0r\0o\0j\0e\0c\0t\0' at +0x0a
  const projectUtf16 = Buffer.from("Project", "utf16le");

  for (
    let pageOff = dataStart;
    pageOff + PAGE_SIZE <= bakData.length;
    pageOff += PAGE_SIZE
  ) {
    const pageType = bakData[pageOff + 1];
    if (pageType !== 1) continue; // only data pages

    // Scan for sysfiles1 records in this page
    for (let recOff = 0x60; recOff < PAGE_SIZE - 800; recOff += 1) {
      // Check fileid field at recOff + 0x08
      const fileid = bakData.readUInt16LE(pageOff + recOff + 0x08);
      if (fileid !== 1) continue;

      // Check name field at recOff + 0x0a matches 'Project'
      const nameSlice = bakData.subarray(
        pageOff + recOff + 0x0a,
        pageOff + recOff + 0x0a + projectUtf16.length,
      );
      if (!nameSlice.equals(projectUtf16)) continue;

      // Check filename field at recOff + 0x10a contains a drive letter or backslash
      const fnByte0 = bakData[pageOff + recOff + 0x10a]; // first char of filename
      const fnByte1 = bakData[pageOff + recOff + 0x10a + 2]; // second char (:)
      if (fnByte0 >= 0x41 && fnByte0 <= 0x5a && fnByte1 === 0x3a) {
        // Looks like C:\ — this is a Windows sysfiles1 record
        const pageIdx = (pageOff - dataStart) / PAGE_SIZE;
        return pageIdx;
      }
    }
  }
  throw new Error("Could not find sysfiles1 page in backup");
}

function saveSysfilesPage(bakPath: string): void {
  const data = readFileSync(bakPath);
  const pageIdx = findSysfilesPageIndex(data);
  const pageOff = 0x4000 + pageIdx * 8192;
  const page = data.subarray(pageOff, pageOff + 8192);
  writeFileSync(SYSFILES_PAGE_FILE, page);
  console.log(
    `  Saved sysfiles1 page (stream page ${pageIdx}) for splice on save`,
  );
}

function spliceSysfilesPage(bakPath: string): void {
  if (!existsSync(SYSFILES_PAGE_FILE)) {
    throw new Error(
      "No saved sysfiles1 page. Re-open the project to capture it.",
    );
  }
  const originalPage = readFileSync(SYSFILES_PAGE_FILE);
  if (originalPage.length !== 8192) {
    throw new Error(`Invalid sysfiles1 page size: ${originalPage.length}`);
  }

  const bakData = readFileSync(bakPath);

  // Find sysfiles1 in the Docker backup by looking for Linux paths
  const linuxMdf = Buffer.from("/var/opt/mssql/data/Project.mdf", "utf16le");
  const dataStart = 0x4000;
  let spliced = false;

  for (
    let pageOff = dataStart;
    pageOff + 8192 <= bakData.length;
    pageOff += 8192
  ) {
    if (bakData.subarray(pageOff, pageOff + 8192).includes(linuxMdf)) {
      // Found the page with Linux paths — replace with original Windows page
      originalPage.copy(bakData, pageOff);
      spliced = true;
      const pageIdx = (pageOff - dataStart) / 8192;
      console.log(`  Spliced sysfiles1 page at stream page ${pageIdx}`);
      break;
    }
  }

  if (!spliced) {
    throw new Error("Could not find sysfiles1 page with Linux paths in backup");
  }

  writeFileSync(bakPath, bakData);
}

function cmdOpen(projectFile: string): void {
  // Check for existing open project
  const existing = loadState();
  if (existing) {
    console.log(
      `Closing previously open project: ${basename(existing.sourceFile)}`,
    );
    try {
      cmdClose();
    } catch {
      // Best effort
    }
  }

  const { bakPath, lutFilename, tempDir } = extractBak(projectFile);

  // Save the original sysfiles1 page from the Windows-produced backup.
  // Linux SQL Server rewrites this page with Linux paths during RESTORE,
  // making it incompatible with Windows LocalDB. We splice it back during save.
  saveSysfilesPage(bakPath);

  ensureContainer();

  // Copy .bak into container
  console.log("Copying backup into container...");
  docker(["cp", bakPath, `${CONTAINER_NAME}:${DATA_DIR}/Project.bak`]);

  // Drop existing database if any
  try {
    sqlcmdMaster(
      `IF DB_ID('${DB_NAME}') IS NOT NULL BEGIN ALTER DATABASE [${DB_NAME}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${DB_NAME}]; END`,
    );
  } catch {
    // Fine if it doesn't exist
  }

  // Restore
  console.log("Restoring database...");

  // First, get the logical file names from the backup
  const fileList = sqlcmdMaster(
    `RESTORE FILELISTONLY FROM DISK = '${DATA_DIR}/Project.bak'`,
    { timeout: 60_000 },
  );

  // Parse logical names from the tab-separated file list output.
  // Each line: LogicalName\tPhysicalName\tType(D/L)\t...
  // -h -1 suppresses headers. Filter out "(N rows affected)" lines.
  const lines = fileList
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("("));
  const dataLogicalName =
    lines
      .find((l) => l.split("\t")[2]?.trim() === "D")
      ?.split("\t")[0]
      ?.trim() ?? "Project";
  const logLogicalName =
    lines
      .find((l) => l.split("\t")[2]?.trim() === "L")
      ?.split("\t")[0]
      ?.trim() ?? "Project_log";

  const restoreSql = `RESTORE DATABASE [${DB_NAME}] FROM DISK = '${DATA_DIR}/Project.bak' WITH MOVE '${dataLogicalName}' TO '${DATA_DIR}/Project.mdf', MOVE '${logLogicalName}' TO '${DATA_DIR}/Project_log.ldf', REPLACE`;

  const restoreResult = sqlcmdMaster(restoreSql, { timeout: 120_000 });
  if (/terminating abnormally|Msg \d+, Level 1[6-9]/i.test(restoreResult)) {
    throw new Error(`RESTORE failed:\n${restoreResult}`);
  }
  console.log("Database restored successfully.");

  // Verify DB version
  const verResult = sqlcmdMaster(
    "SET NOCOUNT ON; SELECT compatibility_level FROM sys.databases WHERE name = 'Project'",
  );
  const compatLevel = verResult.trim();
  console.log(`  Compatibility level: ${compatLevel}`);

  // Wait for Project DB to become accessible (emulated SQL Server can be slow)
  const dbDeadline = Date.now() + 15_000;
  while (Date.now() < dbDeadline) {
    try {
      sqlcmd("SET NOCOUNT ON; SELECT 1");
      break;
    } catch {
      execSync("sleep 1");
    }
  }

  // Clean up temp
  rmSync(tempDir, { recursive: true, force: true });

  // Save state
  const absPath = projectFile.startsWith("/")
    ? projectFile
    : join(process.cwd(), projectFile);
  saveState({
    sourceFile: absPath,
    lutFilename,
    containerId: CONTAINER_NAME,
    openedAt: new Date().toISOString(),
  });

  // Show summary
  const tableCount = sqlcmd(
    "SET NOCOUNT ON; SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE'",
  );
  console.log(`\nProject open: ${basename(absPath)}`);
  console.log(`  Tables: ${tableCount.trim()}`);
  console.log(
    `\nRun queries with: npx tsx tools/designer-project.ts query "SELECT ..."`,
  );
}

function cmdQuery(sql: string): void {
  requireState();
  const result = sqlcmd(sql, { raw: true, timeout: 120_000 });
  console.log(result);
}

function cmdTables(filter?: string): void {
  requireState();
  const where = filter
    ? `AND t.TABLE_NAME LIKE '${filter.replace(/'/g, "''")}'`
    : "";
  const sql = `
SET NOCOUNT ON;
SELECT t.TABLE_NAME, p.rows
FROM INFORMATION_SCHEMA.TABLES t
JOIN sys.partitions p ON p.object_id = OBJECT_ID(t.TABLE_SCHEMA + '.' + t.TABLE_NAME)
  AND p.index_id IN (0, 1)
WHERE t.TABLE_TYPE = 'BASE TABLE' ${where}
ORDER BY t.TABLE_NAME`;
  const result = sqlcmd(sql);
  // Format as aligned table
  const lines = result
    .trim()
    .split("\n")
    .filter((l) => l.trim());
  if (lines.length === 0) {
    console.log("No tables found.");
    return;
  }

  const maxName = Math.max(
    ...lines.map((l) => (l.split("\t")[0] ?? "").length),
  );
  console.log(`${"Table".padEnd(maxName)}  Rows`);
  console.log(`${"─".repeat(maxName)}  ────`);
  for (const line of lines) {
    const [name, rows] = line.split("\t");
    if (name) {
      console.log(`${name.padEnd(maxName)}  ${(rows ?? "").trim()}`);
    }
  }
  console.log(`\n${lines.length} tables`);
}

function cmdDescribe(table: string): void {
  requireState();
  const sql = `
SET NOCOUNT ON;
SELECT
  c.COLUMN_NAME,
  c.DATA_TYPE +
    CASE
      WHEN c.CHARACTER_MAXIMUM_LENGTH IS NOT NULL THEN '(' + CAST(c.CHARACTER_MAXIMUM_LENGTH AS VARCHAR) + ')'
      WHEN c.NUMERIC_PRECISION IS NOT NULL THEN '(' + CAST(c.NUMERIC_PRECISION AS VARCHAR) + ',' + CAST(c.NUMERIC_SCALE AS VARCHAR) + ')'
      ELSE ''
    END AS TYPE,
  c.IS_NULLABLE,
  CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 'PK' ELSE '' END AS PK
FROM INFORMATION_SCHEMA.COLUMNS c
LEFT JOIN (
  SELECT ku.TABLE_NAME, ku.COLUMN_NAME
  FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
  JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
  WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
) pk ON pk.TABLE_NAME = c.TABLE_NAME AND pk.COLUMN_NAME = c.COLUMN_NAME
WHERE c.TABLE_NAME = '${table.replace(/'/g, "''")}'
ORDER BY c.ORDINAL_POSITION`;
  const result = sqlcmd(sql);
  const lines = result
    .trim()
    .split("\n")
    .filter((l) => l.trim());
  if (lines.length === 0) {
    console.log(`Table '${table}' not found.`);
    return;
  }
  console.log(`${table} (${lines.length} columns):\n`);
  const maxCol = Math.max(...lines.map((l) => (l.split("\t")[0] ?? "").length));
  const maxType = Math.max(
    ...lines.map((l) => (l.split("\t")[1] ?? "").length),
  );
  for (const line of lines) {
    const [col, type, nullable, pk] = line.split("\t");
    const flags = [
      pk?.trim() === "PK" ? "PK" : "",
      nullable?.trim() === "YES" ? "NULL" : "NOT NULL",
    ]
      .filter(Boolean)
      .join(" ");
    console.log(
      `  ${(col ?? "").padEnd(maxCol)}  ${(type ?? "").padEnd(maxType)}  ${flags}`,
    );
  }
}

function cmdDump(table: string, limit = 50): void {
  requireState();
  const sql = `SET NOCOUNT ON; SELECT TOP ${limit} * FROM [${table.replace(/[[\]]/g, "")}]`;
  const result = sqlcmd(sql, { raw: true });
  console.log(result);
}

// ── (VM helpers removed — sysfiles1 page splice eliminates VM dependency) ──

function cmdSave(outputFile: string): void {
  const state = requireState();

  const tempDir = join(tmpdir(), `designer-save-${randomUUID().slice(0, 8)}`);
  mkdirSync(tempDir, { recursive: true });

  try {
    // Step 1: BACKUP from Docker
    console.log("Backing up from Docker...");
    try {
      dockerExec(["rm", "-f", `${DATA_DIR}/Output.bak`]);
    } catch {
      // Fine
    }
    sqlcmd(
      `BACKUP DATABASE [${DB_NAME}] TO DISK = '${DATA_DIR}/Output.bak' WITH INIT`,
      { timeout: 120_000 },
    );
    const bakPath = join(tempDir, "Output.bak");
    docker(["cp", `${CONTAINER_NAME}:${DATA_DIR}/Output.bak`, bakPath]);
    const sizeMB = (statSync(bakPath).size / 1024 / 1024).toFixed(1);
    console.log(`  Backup: ${sizeMB} MB`);

    // Step 2: Splice original Windows sysfiles1 page into the Docker backup.
    // Linux SQL Server writes sysfiles1 with Linux paths (/var/opt/mssql/...)
    // which Windows LocalDB rejects. The original page has Windows paths and
    // a valid Windows page checksum.
    console.log("Splicing sysfiles1 page...");
    spliceSysfilesPage(bakPath);

    // Step 3: Pack into project ZIP
    const absOutput = outputFile.startsWith("/")
      ? outputFile
      : join(process.cwd(), outputFile);
    packProject(bakPath, state.lutFilename, absOutput);

    console.log(`\nSaved: ${absOutput}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function cmdClose(): void {
  if (isContainerRunning()) {
    try {
      sqlcmdMaster(
        `IF DB_ID('${DB_NAME}') IS NOT NULL BEGIN ALTER DATABASE [${DB_NAME}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${DB_NAME}]; END`,
      );
    } catch {
      // Best effort
    }
    console.log(
      "Database dropped. Container still running (reuse with next open).",
    );
  }
  clearState();
  console.log("Project closed.");
}

function cmdStatus(): void {
  const state = loadState();
  const running = isContainerRunning();

  console.log(
    `Container: ${running ? "running" : containerExists() ? "stopped" : "not created"}`,
  );
  if (state) {
    console.log(`Project: ${basename(state.sourceFile)}`);
    console.log(`Opened: ${state.openedAt}`);
    console.log(`LUT: ${state.lutFilename}`);
    if (running) {
      try {
        const ver = sqlcmdMaster("SET NOCOUNT ON; SELECT @@VERSION");
        const firstLine = ver.trim().split("\n")[0];
        console.log(`SQL Server: ${firstLine}`);
      } catch {
        console.log("SQL Server: not responding");
      }
    }
  } else {
    console.log("No project open.");
  }
}

function cmdRunSql(filePath: string): void {
  requireState();
  const absPath = filePath.startsWith("/")
    ? filePath
    : join(process.cwd(), filePath);
  if (!existsSync(absPath)) throw new Error(`File not found: ${absPath}`);

  const sql = readFileSync(absPath, "utf8");
  console.log(`Running ${basename(absPath)}...`);
  const result = sqlcmd(sql, { raw: true, timeout: 300_000 });
  console.log(result);
}

// ── Add device ─────────────────────────────────────────────────────

// Known CCA dimmer models. ModelInfoID comes from Designer's SQLMODELINFO DB.
// BallastInfoModelInfoID is the fixture lighting reference for that model class.
const CCA_DIMMER_MODELS: Record<
  number,
  { name: string; ballastInfoId: number }
> = {
  730: { name: "HQR-3LD", ballastInfoId: 3345 },
  729: { name: "HQR-6LD", ballastInfoId: 3345 },
  1300: { name: "RRD-6NA", ballastInfoId: 3345 },
  1288: { name: "RRD-6CL", ballastInfoId: 3345 },
  1294: { name: "RRD-10ND", ballastInfoId: 3345 },
};

function sqlVal(v: string | number | null): string {
  if (v === null) return "NULL";
  if (typeof v === "number") return String(v);
  return `N'${v.replace(/'/g, "''")}'`;
}

function generateXid(): string {
  // Base64url-encoded 16-byte UUID, matching Designer's Xid format
  const bytes = Buffer.from(randomUUID().replace(/-/g, ""), "hex");
  return bytes.toString("base64url");
}

function allocateIds(count: number): { firstId: number; nextId: number } {
  const result = sqlcmd(
    `SET NOCOUNT ON; SELECT NextObjectID FROM tblNextObjectID`,
  );
  const firstId = parseInt(result.trim(), 10);
  if (Number.isNaN(firstId)) throw new Error("Failed to read NextObjectID");
  const nextId = firstId + count;
  sqlcmd(`SET NOCOUNT ON; UPDATE tblNextObjectID SET NextObjectID = ${nextId}`);
  return { firstId, nextId };
}

function findCcaLink(): { linkId: number; linkInfoId: number } {
  // CCA link has LinkInfoID = 11
  const result = sqlcmd(
    `SET NOCOUNT ON; SELECT LinkID, LinkInfoID FROM tblLink WHERE LinkInfoID = 11`,
  );
  const line = result.trim();
  if (!line) throw new Error("No CCA link (LinkInfoID=11) found in project");
  const [linkId, linkInfoId] = line.split("\t").map((s) => parseInt(s, 10));
  return { linkId, linkInfoId };
}

function findNextLinkAddress(linkId: number): number {
  const result = sqlcmd(
    `SET NOCOUNT ON; SELECT AddressOnLink FROM tblLinkNode WHERE LinkAssignedToID = ${linkId} ORDER BY AddressOnLink`,
  );
  const used = new Set(
    result
      .trim()
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => parseInt(l.trim(), 10)),
  );
  // Addresses start at 1, skip 255 (reserved for link owner)
  for (let addr = 1; addr < 255; addr++) {
    if (!used.has(addr)) return addr;
  }
  throw new Error("No available link addresses");
}

function findNextZoneNumber(areaId: number): number {
  const result = sqlcmd(
    `SET NOCOUNT ON; SELECT ISNULL(MAX(ZoneNumber), 0) FROM tblZone WHERE ParentID = ${areaId}`,
  );
  return parseInt(result.trim(), 10) + 1;
}

function findNextIntegrationId(): number {
  const result = sqlcmd(
    `SET NOCOUNT ON; SELECT ISNULL(MAX(IntegrationID), 0) FROM tblIntegrationID`,
  );
  return parseInt(result.trim(), 10) + 1;
}

function getAreaScenes(
  areaId: number,
): Array<{ sceneId: number; name: string }> {
  const result = sqlcmd(
    `SET NOCOUNT ON;
SELECT s.SceneID, s.Name
FROM tblScene s
JOIN tblSceneController sc ON s.ParentSceneControllerID = sc.SceneControllerID
WHERE sc.ParentID = ${areaId}
ORDER BY s.SceneID`,
  );
  return result
    .trim()
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      const [id, name] = l.split("\t");
      return { sceneId: parseInt(id, 10), name: name?.trim() ?? "" };
    });
}

function getSceneAssignmentCount(sceneId: number): number {
  const result = sqlcmd(
    `SET NOCOUNT ON; SELECT COUNT(*) FROM tblPresetAssignment WHERE ParentID = ${sceneId} AND ParentType = 41`,
  );
  return parseInt(result.trim(), 10);
}

function resolveArea(nameOrId: string): { areaId: number; areaName: string } {
  // Try as numeric ID first
  const asNum = parseInt(nameOrId, 10);
  if (!Number.isNaN(asNum)) {
    const result = sqlcmd(
      `SET NOCOUNT ON; SELECT AreaID, Name FROM tblArea WHERE AreaID = ${asNum}`,
    );
    const line = result.trim();
    if (!line) throw new Error(`Area ID ${asNum} not found`);
    const [id, name] = line.split("\t");
    return { areaId: parseInt(id, 10), areaName: name?.trim() ?? "" };
  }
  // Try name match
  const result = sqlcmd(
    `SET NOCOUNT ON; SELECT AreaID, Name FROM tblArea WHERE Name = ${sqlVal(nameOrId)}`,
  );
  const lines = result
    .trim()
    .split("\n")
    .filter((l) => l.trim());
  if (lines.length === 0) throw new Error(`Area "${nameOrId}" not found`);
  if (lines.length > 1)
    throw new Error(`Multiple areas named "${nameOrId}" — use area ID instead`);
  const [id, name] = lines[0].split("\t");
  return { areaId: parseInt(id, 10), areaName: name?.trim() ?? "" };
}

// Default scene levels: Off=0, Scene001=100, 002=75, 003=50, 004=25, others=100
function defaultSceneLevel(sceneName: string): number {
  if (/off/i.test(sceneName)) return 0;
  const m = sceneName.match(/Scene\s*0*(\d+)/i);
  if (m) {
    const num = parseInt(m[1], 10);
    if (num === 1) return 100;
    if (num === 2) return 75;
    if (num === 3) return 50;
    if (num === 4) return 25;
  }
  return 100;
}

function cmdAddDevice(areaName: string, deviceName: string): void {
  requireState();

  const getArg = (name: string) => {
    const i = args.indexOf(name);
    return i !== -1 ? args[i + 1] : undefined;
  };

  const modelId = parseInt(getArg("--model") ?? "730", 10);
  const model = CCA_DIMMER_MODELS[modelId];
  if (!model)
    throw new Error(
      `Unknown model ID ${modelId}. Known: ${Object.entries(CCA_DIMMER_MODELS)
        .map(([k, v]) => `${k}=${v.name}`)
        .join(", ")}`,
    );

  const { areaId, areaName: resolvedAreaName } = resolveArea(areaName);
  console.log(
    `Adding ${model.name} (${modelId}) to area "${resolvedAreaName}" (${areaId}) as "${deviceName}"...`,
  );

  // Find CCA link
  const { linkId } = findCcaLink();
  const linkAddress = findNextLinkAddress(linkId);
  const zoneNumber = findNextZoneNumber(areaId);
  const nextIID = findNextIntegrationId();
  const scenes = getAreaScenes(areaId);

  // Count IDs needed:
  // CS, ES_cs, CSD, ES_csd, LN, SLC, ZCUI, SFPAM, BG, KB, PM,
  // Preset×4, Zone, shared(Zonable/SL/DL), FA, Fixture(+FL),
  // PA for scenes + PA for 4 button presets
  const sceneCount = scenes.length;
  const paCount = sceneCount + 4; // scene PAs + button preset PAs
  const idCount = 19 + paCount; // 19 fixed objects + preset assignments
  const { firstId } = allocateIds(idCount);

  let id = firstId;
  const csId = id++;
  const esCSId = id++;
  const csdId = id++;
  const esCSDId = id++;
  const lnId = id++;
  const slcId = id++;
  const zcuiId = id++;
  const sfpamId = id++;
  const bgId = id++;
  const kbId = id++;
  const pmId = id++;
  const presetOnId = id++;
  const presetOffId = id++;
  const presetDtId = id++;
  const presetHoldId = id++;
  const zoneId = id++;
  const sharedId = id++; // ZonableID = SwitchLegID = DaylightableID
  const faId = id++;
  const fixtureId = id++;
  // Remaining IDs for preset assignments
  const scenePaIds = scenes.map(() => id++);
  const buttonPaOnId = id++;
  const buttonPaDtId = id++;
  const buttonPaOffId = id++;
  const buttonPaHoldId = id++;

  // Get existing CS SortOrder max for this area
  const csSortResult = sqlcmd(
    `SET NOCOUNT ON; SELECT ISNULL(MAX(SortOrder), -1) FROM tblControlStation WHERE ParentId = ${areaId}`,
  );
  const csSortOrder = parseInt(csSortResult.trim(), 10) + 1;

  // Get existing Zone SortOrder max for this area
  const zoneSortResult = sqlcmd(
    `SET NOCOUNT ON; SELECT ISNULL(MAX(SortOrder), -1) FROM tblZone WHERE ParentID = ${areaId}`,
  );
  const zoneSortOrder = parseInt(zoneSortResult.trim(), 10) + 1;

  // Build all INSERTs as a single transaction
  const statements: string[] = [];
  const s = (sql: string) => statements.push(sql);

  const guid = () => randomUUID().toUpperCase();
  const xid = () => generateXid();
  const WUI = 2147483647; // WhereUsedId sentinel

  // 1. ControlStation
  s(`INSERT INTO tblControlStation (ControlStationID, ParentId, ParentType, Name, ColorInfoId,
    DesignRevision, DatabaseRevision, BoxNumber, SortOrder, CustomSortOrder, ShadeGroupCount,
    HasTranslucentCover, UsePicoPedestal, PicoAdapterKitRequired, CustomFaceplateModelNumber,
    WhereUsedId, TemplateID, TemplateUsedID, TemplateReferenceID, TemplateInstanceNumber, Guid, Xid)
    VALUES (${csId}, ${areaId}, 2, ${sqlVal(deviceName)}, 18,
    1, 0, N'', ${csSortOrder}, ${csSortOrder}, 0,
    0, 0, 1, N'',
    ${WUI}, NULL, NULL, NULL, NULL, ${sqlVal(guid())}, ${sqlVal(xid())})`);

  // 2. EngravingStyle for CS
  s(`INSERT INTO tblEngravingStyle (EngravingStyleID, Name, DesignRevision, DatabaseRevision,
    SortOrder, FontType, FontSize, FontAlignment, ParentID, ParentDeviceType, WhereUsedId,
    TemplateID, TemplateUsedID, TemplateReferenceID, TemplateInstanceNumber, EngravingStyleType, Xid)
    VALUES (${esCSId}, N'Faceplate Engraving', 0, 0,
    0, 1, 12, 2, ${csId}, 4, ${WUI},
    NULL, NULL, NULL, NULL, 2, ${sqlVal(xid())})`);

  // 3. ControlStationDevice
  s(`INSERT INTO tblControlStationDevice (ControlStationDeviceID, Name, DesignRevision, DatabaseRevision,
    SortOrder, ModelInfoID, ModelIsLocked, ProgrammingID, RFDeviceSlot, SerialNumber, SerialNumberState,
    GangPosition, NumberOfFinsBroken, IsManuallyProgrammed, ParentControlStationID, HardwareRevision,
    IsAuto, Notes, AppliedEngravingType, PowerSupplyOutputAssignedToID, OrderOnCommunicationLink,
    IsSceneSaveEnabled, MasterSliderID, CustomButtonKitModelNumber, Comments, AssociatedTemplateId,
    WhereUsedId, TemplateID, TemplateUsedID, TemplateReferenceID, TemplateInstanceNumber,
    BacklightLevel, QuickTestStatus, InputReceived, AssociatedFixtureAssignmentID,
    IsEmergencyController, ProcessorAssignedViaEthernet, Guid, Xid)
    VALUES (${csdId}, N'Device 1', 1, 0,
    0, ${modelId}, 0, 0, 0, 0, 0,
    0, 0, 0, ${csId}, 0,
    0, N'', 0, NULL, 27,
    0, 0, N'', N'', 545,
    ${WUI}, NULL, NULL, NULL, NULL,
    0, 0, 0, NULL,
    0, NULL, ${sqlVal(guid())}, ${sqlVal(xid())})`);

  // 4. EngravingStyle for CSD
  s(`INSERT INTO tblEngravingStyle (EngravingStyleID, Name, DesignRevision, DatabaseRevision,
    SortOrder, FontType, FontSize, FontAlignment, ParentID, ParentDeviceType, WhereUsedId,
    TemplateID, TemplateUsedID, TemplateReferenceID, TemplateInstanceNumber, EngravingStyleType, Xid)
    VALUES (${esCSDId}, N'Button Engraving', 0, 0,
    0, 1, 10, 1, ${csdId}, 5, ${WUI},
    NULL, NULL, NULL, NULL, 1, ${sqlVal(xid())})`);

  // 5. LinkNode
  s(`INSERT INTO tblLinkNode (LinkNodeID, Name, DesignRevision, DatabaseRevision, SortOrder,
    AddressOnLink, LinkAssignedToID, LinkNodeNumber, ModelInfoID, LinkType, ParentDeviceID,
    ParentDeviceType, IsLinkOwner, IsLinkMaster, WhereUsedId, ObjectActivationState,
    TemplateID, TemplateUsedID, TemplateReferenceID, TemplateInstanceNumber, IsBallastAddressed, Xid)
    VALUES (${lnId}, N'Link Node 001', 1, 0, 0,
    ${linkAddress}, ${linkId}, 1, ${modelId}, 11, ${csdId},
    5, 0, 0, ${WUI}, 0,
    NULL, NULL, NULL, NULL, 0, ${sqlVal(xid())})`);

  // 6. SwitchLegController
  s(`INSERT INTO tblSwitchLegController (SwitchLegControllerID, Name, DesignRevision, DatabaseRevision,
    SortOrder, AccessoryControlType, IsSpare, OutputNumber, ParentDeviceID, ParentDeviceType,
    PowerBoosterModelInfoId, PowerBoosterChainCount, ObjectType, NumberOfChannels, AChannel, BChannel,
    CChannel, DaliEmergencyTestGroupId, NeedsTransfer, IsInvalidLoadInterfaceSolution, CustomSortOrder,
    WhereUsedId, TemplateID, TemplateUsedID, TemplateReferenceID, TemplateInstanceNumber, DimmingCurveType, Xid)
    VALUES (${slcId}, N'Switch Leg Controller 001', 1, 0,
    0, 0, 0, 1, ${csdId}, 5,
    NULL, 0, 3, NULL, NULL, NULL,
    NULL, NULL, 0, 0, 0,
    ${WUI}, NULL, NULL, NULL, NULL, 255, ${sqlVal(xid())})`);

  // 7. ZoneControlUI
  s(`INSERT INTO tblZoneControlUI (ZoneControlUIID, Name, DesignRevision, DatabaseRevision, SortOrder,
    AssignedZoneID, ControlNumber, DoubleTapFadeTimeOrRateValue, DoubleTapFadeType, IsSpare,
    LocalButtonDoubleTapPresetLevel, LocalButtonPresetLevel, LongFadeToOffPrefadeTime,
    LongFadeToOffTimeOrRateValue, LongFadeToOffType, PressFadeOffTimeOrRateValue, PressFadeOffType,
    PressFadeOnTimeOrRateValue, PressFadeOnType, RaiseLowerRate, SaveAlways, ParentDeviceID,
    ParentDeviceType, ObjectType, IsRemoteZone, TemperatureUnitType, SeeTempModeLedIntensityType,
    TemperatureLedIntensityType, SliderLowEndType, WhereUsedId, TemplateID, TemplateUsedID,
    TemplateReferenceID, TemplateInstanceNumber, ZoneOnIndicatorIntensity, ZoneOffIndicatorIntensity, Xid)
    VALUES (${zcuiId}, N'Zone Control UI 001', 1, 0, 0,
    ${zoneId}, 1, 2, 2, 0,
    255, 190, 30,
    40, 1, 1, 2,
    1, 1, 20, 0, ${csdId},
    5, 9, 0, NULL, NULL,
    NULL, 255, ${WUI}, NULL, NULL,
    NULL, NULL, 255, 255, ${sqlVal(xid())})`);

  // 8. ShortFormPropertyAddressMap (CCA only)
  s(`INSERT INTO tblShortFormPropertyAddressMap (ShortFormPropertyAddressMapID, Name, DesignRevision,
    DatabaseRevision, SortOrder, ShrtFrmPropAddrMapInfoID, PropertyAddress, LinkAssignedToID,
    ParentDeviceID, ParentDeviceType, WhereUsedId, TemplateID, TemplateUsedID, TemplateReferenceID,
    TemplateInstanceNumber)
    VALUES (${sfpamId}, N'Short Form Property Address Map 001', 1,
    0, 0, 74, ${linkAddress}, ${linkId},
    ${csdId}, 5, ${WUI}, NULL, NULL, NULL,
    NULL)`);

  // 9. ButtonGroup
  s(`INSERT INTO tblButtonGroup (ButtonGroupID, Name, DatabaseRevision, SortOrder, ButtonGroupInfoID,
    ButtonGroupProgrammingType, Notes, ParentDeviceID, ParentDeviceType, ButtonGroupObjectType,
    StndAlnQSTmplBtnGrpInfoID, IsValid, ButtonGroupType, LastButtonPressRaiseLowerEvent, WhereUsedId,
    TemplateID, TemplateUsedID, TemplateReferenceID, TemplateInstanceNumber, Xid)
    VALUES (${bgId}, N'Button Group 001', 0, 0, 439,
    1, N'', ${csdId}, 5, 1,
    NULL, 1, 8, 0, ${WUI},
    NULL, NULL, NULL, NULL, ${sqlVal(xid())})`);

  // 10. KeypadButton
  s(`INSERT INTO tblKeypadButton (ButtonID, Name, DatabaseRevision, SortOrder, BacklightLevel,
    ButtonNumber, ButtonInfoId, CorrespondingLedId, ButtonType, ContactClosureInputNormalState,
    ProgrammingModelID, ComponentNumber, ParentDeviceID, ParentDeviceType, WhereUsedId,
    TemplateID, TemplateUsedID, TemplateReferenceID, TemplateInstanceNumber, Xid)
    VALUES (${kbId}, N'Button 0', 0, 0, 255,
    0, NULL, NULL, 1, 0,
    ${pmId}, NULL, ${csdId}, 5, ${WUI},
    NULL, NULL, NULL, NULL, ${sqlVal(xid())})`);

  // 11. ProgrammingModel
  s(`INSERT INTO tblProgrammingModel (ProgrammingModelID, ObjectType, Name, DatabaseRevision, SortOrder,
    LedLogic, UseReverseLedLogic, Notes, ReferencePresetIDForLed, AllowDoubleTap, HeldButtonAction,
    HoldTime, StopQedShadesIfMoving, PresetID, DoubleTapPresetID, HoldPresetId, PressPresetID,
    ReleasePresetID, OnPresetID, OffPresetID, Direction, ControlType, VariableId, ThreeWayToggle,
    ParentID, ParentType, NeedsTransfer, WhereUsedId, TemplateID, TemplateUsedID, TemplateReferenceID,
    TemplateInstanceNumber, Xid)
    VALUES (${pmId}, 74, N'ATPM', 0, 0,
    13, 0, N'', NULL, 1, 0,
    0, 0, NULL, ${presetDtId}, ${presetHoldId}, NULL,
    NULL, ${presetOnId}, ${presetOffId}, NULL, 0, NULL, NULL,
    ${kbId}, 57, 1, ${WUI}, NULL, NULL, NULL,
    NULL, ${sqlVal(xid())})`);

  // 12-15. Presets (Press On, Off Level, Double Tap, Hold)
  for (const [pid, pname] of [
    [presetOnId, "Press On"],
    [presetOffId, "Off Level"],
    [presetDtId, "Double Tap"],
    [presetHoldId, "Hold"],
  ] as const) {
    s(`INSERT INTO tblPreset (PresetID, Name, DatabaseRevision, SortOrder, ParentID, ParentType,
      NeedsTransfer, PresetType, WhereUsedId, TemplateID, TemplateUsedID, TemplateReferenceID,
      TemplateInstanceNumber, IsGPDPreset, SmartProgrammingDefaultGUID, Xid)
      VALUES (${pid}, ${sqlVal(pname)}, 0, 0, ${pmId}, 74,
      1, 1, ${WUI}, NULL, NULL, NULL,
      NULL, 0, '00000000-0000-0000-0000-000000000000', ${sqlVal(xid())})`);
  }

  // 16. Zone
  s(`INSERT INTO tblZone (ZoneID, ParentID, Name, DesignRevision, DatabaseRevision, ZoneNumber,
    ShadeGroupAssignedToID, SortOrder, AddressOnLink, ZoneDescription, RaiseLowerConfiguration,
    ControlType, ObjectType, WhereUsedId, ZoneColorInfo, ObjectActivationState, TemplateID,
    TemplateUsedID, TemplateReferenceID, TemplateInstanceNumber, ZoneConfiguration, ZoneLayer, Guid, Xid)
    VALUES (${zoneId}, ${areaId}, ${sqlVal(deviceName)}, 1, 0, ${zoneNumber},
    NULL, ${zoneSortOrder}, NULL, N'', 0,
    1, 15, ${WUI}, 10, 0, NULL,
    NULL, NULL, NULL, 1, 0, ${sqlVal(guid())}, ${sqlVal(xid())})`);

  // 17a. Zonable (shared ID)
  s(`INSERT INTO tblZonable (ZonableID, ZonableObjectType, AssociatedZoneID, ControllerID, ControllerType)
    VALUES (${sharedId}, 10, ${zoneId}, ${slcId}, 3)`);

  // 17b. SwitchLeg (shared ID, ParentID = areaId)
  s(`INSERT INTO tblSwitchLeg (SwitchLegID, ParentID, Name, DesignRevision, DatabaseRevision,
    OverrideFixtureID, Gain, SortOrder, OutputNumberOnLink, AbsoluteMinimumLevel, BurnInTime,
    ElectronicBypassLevel, HighEnd, InrushDelay, LampRunHoursThreshold, LowEnd, ManualOverrideLevel,
    AbsoluteMaximumLevel, IsNightLight, EmergencyModeType, ProgrammedOffLevel, LoadType,
    ControllableOutputNumber, Feed, ObjectType, AFCI, BallastInterfaceID, LampLifeExpectancy,
    LampPreWarningTime, WhereUsedId, ObjectActivationState, TemplateID, TemplateUsedID,
    TemplateReferenceID, TemplateInstanceNumber, ELCDModelInfoID, Xid)
    VALUES (${sharedId}, ${areaId}, ${sqlVal(String(zoneNumber))}, 1, 0,
    NULL, NULL, ${zoneSortOrder}, 65535, 0, 100,
    0, 90, 0, 10000, 5, 100,
    100, 0, 1, 0, 1,
    NULL, NULL, 10, 0, NULL, 20000,
    100, ${WUI}, 0, NULL, NULL,
    NULL, NULL, NULL, ${sqlVal(xid())})`);

  // 17c. Daylightable (shared ID)
  s(`INSERT INTO tblDaylightable (DaylightableID, DaylightableObjectType, GainGroupID, DaylightingDesignType)
    VALUES (${sharedId}, 10, NULL, 1)`);

  // 18. Fixture (must be before FixtureAssignment due to FK)
  s(`INSERT INTO tblFixture (FixtureID, Name, DesignRevision, DatabaseRevision, ManufacturerModel,
    ManufacturerName, Notes, PriceCurrency, PriceValue, LoadTypePropertyType, LoadType, Voltage,
    FixtureWattage, SortOrder, ParentID, ParentType, ObjectType, FixtureDescription, FixtureInfoID,
    PhaseControl, AssociatedFixtureGroupId, FixtureControllerModelInfo, WhereUsedId, TemplateID,
    TemplateUsedID, TemplateReferenceID, TemplateInstanceNumber, Xid)
    VALUES (${fixtureId}, N'Override Fixture', 1, 0, N'',
    N'', N'', N'', 0, 4, 1, 4,
    10, -1, ${faId}, 7, 6, N'', 0,
    0, NULL, NULL, ${WUI}, NULL,
    NULL, NULL, NULL, ${sqlVal(xid())})`);

  // 19. FixtureAssignment
  s(`INSERT INTO tblFixtureAssignment (FixtureAssignmentID, ParentID, ParentType, Name, DesignRevision,
    DatabaseRevision, NumberofFixtures, SortOrder, FixtureID, WhereUsedId, TemplateID, TemplateUsedID,
    TemplateReferenceID, TemplateInstanceNumber, Xid)
    VALUES (${faId}, ${sharedId}, 10, N'FixtureAssignment 001', 1,
    0, 1, 0, ${fixtureId}, ${WUI}, NULL, NULL,
    NULL, NULL, ${sqlVal(xid())})`);

  // 20. FixtureLighting
  s(`INSERT INTO tblFixtureLighting (FixtureID, BallastInfoModelInfoID, BallastInterfaceModelInfoID,
    BlipTimeOffset, BlipWidth, ElectronicBypassTime, LampQuantity, LampWattage, LoadInterfaceModelInfoID,
    LoadInterfaceQuantity, Softstart, VoltageCompensationDisabled, VoltageCompensationAlgorithm,
    BlankingPulse, FrequencyFiltering, SoftwarePll, Slushing, LampType, DimmingRange, LowEnd, HighEnd,
    PhysicalLowEnd, PhysicalHighEnd, AbsoluteMinimumLevel, BallastFactor, SizeID, DefaultControlsID,
    MountingTypeID, OptionsID, LampLifeExpectancy, TemplateID, TemplateUsedID, TemplateReferenceID,
    TemplateInstanceNumber)
    VALUES (${fixtureId}, ${model.ballastInfoId}, NULL,
    0, 6, 0, 1, 0, NULL,
    0, 1, 0, 0,
    1, 1, 0, 3, 0, 0, 5, 90,
    2700, 6000, 0, 1.0, 0, 0,
    0, 0, 20000, NULL, NULL, NULL,
    NULL)`);

  // 20. DeviceLookup ×3
  s(`INSERT INTO tblDeviceLookup (DeviceObjectID, ComponentNumber, ObjectID, ObjectType, SystemID)
    VALUES (${csdId}, 3, ${zcuiId}, 9, NULL)`);
  s(`INSERT INTO tblDeviceLookup (DeviceObjectID, ComponentNumber, ObjectID, ObjectType, SystemID)
    VALUES (${csdId}, 5, ${sfpamId}, 138, NULL)`);
  s(`INSERT INTO tblDeviceLookup (DeviceObjectID, ComponentNumber, ObjectID, ObjectType, SystemID)
    VALUES (${csdId}, 5, ${sfpamId}, 138, NULL)`);

  // 21. IntegrationID ×2
  s(`INSERT INTO tblIntegrationID (DomainControlBaseObjectID, IntegrationID, DomainControlBaseObjectType)
    VALUES (${csdId}, ${nextIID}, 5)`);
  s(`INSERT INTO tblIntegrationID (DomainControlBaseObjectID, IntegrationID, DomainControlBaseObjectType)
    VALUES (${zoneId}, ${nextIID + 1}, 15)`);

  // 22. PresetAssignments for area scenes
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const paId = scenePaIds[i];
    const sortOrder = getSceneAssignmentCount(scene.sceneId);
    const level = defaultSceneLevel(scene.name);
    s(`INSERT INTO tblPresetAssignment (PresetAssignmentID, Name, DatabaseRevision, SortOrder,
      ParentID, ParentType, AssignableObjectID, AssignableObjectType, AssignmentCommandType,
      NeedsTransfer, AssignmentCommandGroup, WhereUsedId, TemplateID, TemplateUsedID,
      TemplateReferenceID, TemplateInstanceNumber, IsDimmerLocalLoad, SmartProgrammingDefaultGUID, Xid)
      VALUES (${paId}, N'''', 0, ${sortOrder},
      ${scene.sceneId}, 41, ${zoneId}, 15, 2,
      1, 1, ${WUI}, NULL, NULL,
      NULL, NULL, 0, '00000000-0000-0000-0000-000000000000', ${sqlVal(xid())})`);
    // 3 command parameters per scene PA: PT1=fade(8), PT2=delay(0), PT3=level
    s(`INSERT INTO tblAssignmentCommandParameter (SortOrder, ParentId, ParameterType, ParameterValue)
      VALUES (0, ${paId}, 1, 8), (1, ${paId}, 2, 0), (2, ${paId}, 3, ${level})`);
  }

  // 23. PresetAssignments for button presets (IsDimmerLocalLoad=1)
  // Press On preset
  s(`INSERT INTO tblPresetAssignment (PresetAssignmentID, Name, DatabaseRevision, SortOrder,
    ParentID, ParentType, AssignableObjectID, AssignableObjectType, AssignmentCommandType,
    NeedsTransfer, AssignmentCommandGroup, WhereUsedId, TemplateID, TemplateUsedID,
    TemplateReferenceID, TemplateInstanceNumber, IsDimmerLocalLoad, SmartProgrammingDefaultGUID, Xid)
    VALUES (${buttonPaOnId}, N'''', 0, 0,
    ${presetOnId}, 43, ${zoneId}, 15, 2,
    1, 1, ${WUI}, NULL, NULL,
    NULL, NULL, 1, '00000000-0000-0000-0000-000000000000', ${sqlVal(xid())})`);
  s(`INSERT INTO tblAssignmentCommandParameter (SortOrder, ParentId, ParameterType, ParameterValue)
    VALUES (0, ${buttonPaOnId}, 2, 0), (1, ${buttonPaOnId}, 1, 1), (2, ${buttonPaOnId}, 3, 75)`);

  // Double Tap preset
  s(`INSERT INTO tblPresetAssignment (PresetAssignmentID, Name, DatabaseRevision, SortOrder,
    ParentID, ParentType, AssignableObjectID, AssignableObjectType, AssignmentCommandType,
    NeedsTransfer, AssignmentCommandGroup, WhereUsedId, TemplateID, TemplateUsedID,
    TemplateReferenceID, TemplateInstanceNumber, IsDimmerLocalLoad, SmartProgrammingDefaultGUID, Xid)
    VALUES (${buttonPaDtId}, N'''', 0, 0,
    ${presetDtId}, 43, ${zoneId}, 15, 2,
    1, 1, ${WUI}, NULL, NULL,
    NULL, NULL, 1, '00000000-0000-0000-0000-000000000000', ${sqlVal(xid())})`);
  s(`INSERT INTO tblAssignmentCommandParameter (SortOrder, ParentId, ParameterType, ParameterValue)
    VALUES (0, ${buttonPaDtId}, 2, 0), (1, ${buttonPaDtId}, 1, 0), (2, ${buttonPaDtId}, 3, 100)`);

  // Off Level preset
  s(`INSERT INTO tblPresetAssignment (PresetAssignmentID, Name, DatabaseRevision, SortOrder,
    ParentID, ParentType, AssignableObjectID, AssignableObjectType, AssignmentCommandType,
    NeedsTransfer, AssignmentCommandGroup, WhereUsedId, TemplateID, TemplateUsedID,
    TemplateReferenceID, TemplateInstanceNumber, IsDimmerLocalLoad, SmartProgrammingDefaultGUID, Xid)
    VALUES (${buttonPaOffId}, N'''', 0, 0,
    ${presetOffId}, 43, ${zoneId}, 15, 2,
    1, 1, ${WUI}, NULL, NULL,
    NULL, NULL, 1, '00000000-0000-0000-0000-000000000000', ${sqlVal(xid())})`);
  s(`INSERT INTO tblAssignmentCommandParameter (SortOrder, ParentId, ParameterType, ParameterValue)
    VALUES (0, ${buttonPaOffId}, 2, 0), (1, ${buttonPaOffId}, 1, 1), (2, ${buttonPaOffId}, 3, 0)`);

  // Hold preset
  s(`INSERT INTO tblPresetAssignment (PresetAssignmentID, Name, DatabaseRevision, SortOrder,
    ParentID, ParentType, AssignableObjectID, AssignableObjectType, AssignmentCommandType,
    NeedsTransfer, AssignmentCommandGroup, WhereUsedId, TemplateID, TemplateUsedID,
    TemplateReferenceID, TemplateInstanceNumber, IsDimmerLocalLoad, SmartProgrammingDefaultGUID, Xid)
    VALUES (${buttonPaHoldId}, N'''', 0, 0,
    ${presetHoldId}, 43, ${zoneId}, 15, 2,
    1, 1, ${WUI}, NULL, NULL,
    NULL, NULL, 1, '00000000-0000-0000-0000-000000000000', ${sqlVal(xid())})`);
  s(`INSERT INTO tblAssignmentCommandParameter (SortOrder, ParentId, ParameterType, ParameterValue)
    VALUES (0, ${buttonPaHoldId}, 2, 30), (1, ${buttonPaHoldId}, 1, 40), (2, ${buttonPaHoldId}, 3, 0)`);

  // Execute all statements in a transaction
  const fullSql = `SET NOCOUNT ON;
BEGIN TRANSACTION;
BEGIN TRY
${statements.join(";\n")};
COMMIT;
SELECT 'OK' AS result;
END TRY
BEGIN CATCH
ROLLBACK;
SELECT ERROR_MESSAGE() AS result;
END CATCH`;

  console.log(`Executing ${statements.length} INSERT statements...`);
  const result = sqlcmd(fullSql, { timeout: 120_000 });
  const resultLine = result.trim().split("\n").pop()?.trim();
  if (resultLine !== "OK") {
    throw new Error(`Transaction failed: ${result.trim()}`);
  }

  console.log(`\nDevice added successfully:`);
  console.log(`  ControlStation:  ${csId} ("${deviceName}")`);
  console.log(`  Device (CSD):    ${csdId} (${model.name})`);
  console.log(
    `  Zone:            ${zoneId} ("${deviceName}", zone #${zoneNumber})`,
  );
  console.log(`  Link address:    ${linkAddress} on link ${linkId}`);
  console.log(`  Integration IDs: ${nextIID} (device), ${nextIID + 1} (zone)`);
  console.log(`  Scene presets:   ${scenes.length} scenes updated`);
  console.log(`  NextObjectID:    ${firstId + idCount}`);
}

// ── Main dispatch ───────────────────────────────────────────────────

try {
  switch (command) {
    case "open":
      if (!args[1]) throw new Error("Usage: open <project.hw|.ra3>");
      cmdOpen(args[1]);
      break;
    case "query":
    case "q":
      if (!args[1]) throw new Error("Usage: query <sql>");
      cmdQuery(args.slice(1).join(" "));
      break;
    case "tables":
    case "t":
      cmdTables(args[1]);
      break;
    case "describe":
    case "desc":
    case "d":
      if (!args[1]) throw new Error("Usage: describe <table>");
      cmdDescribe(args[1]);
      break;
    case "dump":
      if (!args[1]) throw new Error("Usage: dump <table> [limit]");
      cmdDump(args[1], args[2] ? parseInt(args[2], 10) : 50);
      break;
    case "save":
      if (!args[1]) throw new Error("Usage: save <output.hw|.ra3>");
      cmdSave(args[1]);
      break;
    case "close":
      cmdClose();
      break;
    case "status":
      cmdStatus();
      break;
    case "run-sql":
      if (!args[1]) throw new Error("Usage: run-sql <file.sql>");
      cmdRunSql(args[1]);
      break;
    case "add-device":
      if (!args[1] || !args[2])
        throw new Error("Usage: add-device <area> <name> [--model <id>]");
      cmdAddDevice(args[1], args[2]);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
} catch (err: any) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
