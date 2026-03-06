#!/usr/bin/env bun

/**
 * MCP Server: Lutron Designer LocalDB
 *
 * Queries Designer's LocalDB via HTTP API running on the VM (sql-http-api.ps1).
 * Endpoints: /query (project DB), /query-modelinfo (SQLMODELINFO), /databases
 *
 * Falls back to SSH → PowerShell → sqlcmd if HTTP API is unreachable.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolve, basename } from "path";
import { existsSync } from "fs";

// ── Config ──────────────────────────────────────────────────────────

import { DESIGNER_VM_HOST, DESIGNER_VM_USER, DESIGNER_VM_PASS } from "../lib/env";
const VM_HOST = process.env.DESIGNER_VM_HOST ?? DESIGNER_VM_HOST;
const VM_USER = process.env.DESIGNER_VM_USER ?? DESIGNER_VM_USER;
const VM_PASS = process.env.DESIGNER_VM_PASS ?? DESIGNER_VM_PASS;
const HTTP_BASE = `http://${VM_HOST}:9999`;
const DEFAULT_TIMEOUT = 30_000;
const SQL_DIR = resolve(import.meta.dir, "sql");

// ── HTTP API (primary) ──────────────────────────────────────────────

async function httpQuery(
  endpoint: string,
  sql: string,
  timeout = DEFAULT_TIMEOUT
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(`${HTTP_BASE}${endpoint}`, {
      method: "POST",
      body: sql,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text.trim()}`);
    }
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  } finally {
    clearTimeout(timer);
  }
}

async function httpGet(
  endpoint: string,
  timeout = DEFAULT_TIMEOUT
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(`${HTTP_BASE}${endpoint}`, {
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text.trim()}`);
    }
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  } finally {
    clearTimeout(timer);
  }
}

// ── SSH fallback ────────────────────────────────────────────────────

function encodePowerShell(script: string): string {
  const buf = Buffer.from(script, "utf16le");
  return buf.toString("base64");
}

async function execPowerShell(
  script: string,
  timeout = DEFAULT_TIMEOUT
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const encoded = encodePowerShell(script);
  const proc = Bun.spawn(
    [
      "/opt/homebrew/bin/sshpass",
      "-p",
      VM_PASS,
      "ssh",
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "PreferredAuthentications=password",
      "-o",
      "LogLevel=ERROR",
      `${VM_USER}@${VM_HOST}`,
      "powershell",
      "-EncodedCommand",
      encoded,
    ],
    { stdout: "pipe", stderr: "pipe" }
  );

  const timer = setTimeout(() => proc.kill(), timeout);

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(timer);

  return {
    stdout: stdout.replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
    stderr: stderr.replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
    exitCode,
  };
}

// ── Pipe discovery & caching (SSH fallback) ─────────────────────────

let cachedPipe: string | null = null;
let cachedDatabase: string | null = null;

async function discover(): Promise<{ pipe: string; database: string }> {
  if (cachedPipe && cachedDatabase) {
    return { pipe: cachedPipe, database: cachedDatabase };
  }

  const discoverScript = `
$ErrorActionPreference = "Continue"
if ($PSVersionTable.PSVersion.Major -ge 7) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$pipes = Get-ChildItem "\\\\.\\pipe\\" |
  Select-Object -ExpandProperty Name |
  Where-Object { $_ -like "*LOCALDB*" }

if (-not $pipes) {
  Write-Error "No LOCALDB pipe found."
  exit 1
}

$foundServer = $null
foreach ($pipe in $pipes) {
  if ($pipe -match "\\\\tsql\\\\query$") {
    $server = "np:\\\\.\\pipe\\$pipe"
  } else {
    $server = "np:\\\\.\\pipe\\$pipe\\tsql\\query"
  }
  & sqlcmd -S $server -E -No -d master -Q "SET NOCOUNT ON; SELECT DB_NAME();" -h -1 -W 1>$null 2>$null
  if ($LASTEXITCODE -eq 0) {
    $foundServer = $server
    break
  }
}

if (-not $foundServer) {
  Write-Error "Could not connect to any LOCALDB pipe."
  exit 1
}

$sql = "SET NOCOUNT ON; SELECT TOP 1 name FROM sys.databases WHERE name = 'Project' OR name LIKE 'Project[_]%' ORDER BY CASE WHEN name = 'Project' THEN 0 ELSE 1 END, create_date DESC;"
$db = (& sqlcmd -S $foundServer -E -No -d master -Q $sql -h -1 -W 2>$null | Select-Object -First 1)
if ($db) { $db = $db.Trim() }
if (-not $db) {
  Write-Error "No project database found."
  exit 1
}

Write-Output "$foundServer"
Write-Output "$db"
`;

  const result = await execPowerShell(discoverScript, 20_000);
  if (result.exitCode !== 0) {
    throw new Error(
      `Pipe discovery failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`
    );
  }

  const lines = result.stdout.trim().split("\n").filter(Boolean);
  if (lines.length < 2) {
    throw new Error(
      `Unexpected discovery output: ${result.stdout.trim()}`
    );
  }

  cachedPipe = lines[0].trim();
  cachedDatabase = lines[1].trim();
  return { pipe: cachedPipe, database: cachedDatabase };
}

function invalidateCache() {
  cachedPipe = null;
  cachedDatabase = null;
}

// ── SQL execution: HTTP first, SSH fallback ─────────────────────────

const PIPE_ERROR_PATTERNS = [
  "pipe",
  "connection",
  "closed",
  "broken",
  "transport",
  "network",
  "login timeout",
  "communication link",
  "login failed",
  "cannot open database",
  "not found or not accessible",
];

function isPipeError(output: string): boolean {
  const lower = output.toLowerCase();
  return PIPE_ERROR_PATTERNS.some((p) => lower.includes(p));
}

async function runSQL(
  sql: string,
  timeout = DEFAULT_TIMEOUT,
  retried = false
): Promise<string> {
  // Try HTTP API first
  try {
    return await httpQuery("/query", sql, timeout);
  } catch {
    // Fall through to SSH
  }

  const { pipe, database } = await discover();

  const script = `
$ErrorActionPreference = "Continue"
if ($PSVersionTable.PSVersion.Major -ge 7) {
  $PSNativeCommandUseErrorActionPreference = $false
}
& sqlcmd -S '${pipe.replace(/'/g, "''")}' -E -No -d '${database.replace(/'/g, "''")}' -b -W -s "|" -Q '${sql.replace(/'/g, "''")}'
exit $LASTEXITCODE
`;

  const result = await execPowerShell(script, timeout);

  if (result.exitCode !== 0) {
    const combined = result.stderr + result.stdout;
    if (!retried && isPipeError(combined)) {
      invalidateCache();
      return runSQL(sql, timeout, true);
    }
    throw new Error(
      `SQL error (exit ${result.exitCode}): ${combined.trim()}`
    );
  }

  return result.stdout;
}

async function runSQLFile(
  filePath: string,
  timeout = DEFAULT_TIMEOUT,
  retried = false
): Promise<string> {
  // Try HTTP API first
  try {
    const fileContent = await Bun.file(filePath).text();
    return await httpQuery("/query", fileContent, timeout);
  } catch {
    // Fall through to SSH
  }

  const { pipe, database } = await discover();
  const fileContent = await Bun.file(filePath).text();

  const script = `
$ErrorActionPreference = "Continue"
if ($PSVersionTable.PSVersion.Major -ge 7) {
  $PSNativeCommandUseErrorActionPreference = $false
}
$tempFile = [System.IO.Path]::GetTempFileName() + ".sql"
@'
${fileContent}
'@ | Set-Content -Path $tempFile -Encoding UTF8
try {
  & sqlcmd -S '${pipe.replace(/'/g, "''")}' -E -No -d '${database.replace(/'/g, "''")}' -b -W -s "|" -i $tempFile
  exit $LASTEXITCODE
} finally {
  Remove-Item -Path $tempFile -Force -ErrorAction SilentlyContinue
}
`;

  const result = await execPowerShell(script, timeout);

  if (result.exitCode !== 0) {
    const combined = result.stderr + result.stdout;
    if (!retried && isPipeError(combined)) {
      invalidateCache();
      return runSQLFile(filePath, timeout, true);
    }
    throw new Error(
      `SQL error (exit ${result.exitCode}): ${combined.trim()}`
    );
  }

  return result.stdout;
}

// ── MCP Server ──────────────────────────────────────────────────────

const server = new McpServer({
  name: "designer-db",
  version: "2.0.0",
});

// Tool: query
server.tool(
  "query",
  "Run arbitrary SQL against the Designer LocalDB project database. Returns pipe-delimited results. Uses HTTP API (fast) with SSH fallback.",
  {
    sql: z.string().describe("SQL query to execute"),
    timeout: z
      .number()
      .optional()
      .describe("Timeout in milliseconds (default 30000)"),
  },
  async ({ sql, timeout }) => {
    try {
      const output = await runSQL(sql, timeout ?? DEFAULT_TIMEOUT);
      return { content: [{ type: "text", text: output }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// Tool: list_tables
server.tool(
  "list_tables",
  "List tables in the Designer project database with row counts. Optional LIKE filter.",
  {
    filter: z
      .string()
      .optional()
      .describe("Optional SQL LIKE pattern to filter table names (e.g. '%Zone%')"),
  },
  async ({ filter }) => {
    const where = filter
      ? `WHERE t.name LIKE '${filter.replace(/'/g, "''")}'`
      : "";
    const sql = `SET NOCOUNT ON;
SELECT t.name AS [Table], p.rows AS [Rows]
FROM sys.tables t
JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0,1)
${where}
ORDER BY t.name;`;

    try {
      const output = await runSQL(sql);
      return { content: [{ type: "text", text: output }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// Tool: describe_table
server.tool(
  "describe_table",
  "Show column names, types, nullability, and primary key status for a table.",
  {
    table: z.string().describe("Table name to describe"),
  },
  async ({ table }) => {
    const sql = `SET NOCOUNT ON;
SELECT
  c.name AS [Column],
  tp.name + CASE
    WHEN tp.name IN ('varchar','nvarchar','char','nchar','binary','varbinary')
      THEN '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length AS VARCHAR) END + ')'
    WHEN tp.name IN ('decimal','numeric')
      THEN '(' + CAST(c.precision AS VARCHAR) + ',' + CAST(c.scale AS VARCHAR) + ')'
    ELSE ''
  END AS [Type],
  CASE WHEN c.is_nullable = 1 THEN 'YES' ELSE 'NO' END AS [Nullable],
  CASE WHEN pk.column_id IS NOT NULL THEN 'PK' ELSE '' END AS [Key]
FROM sys.columns c
JOIN sys.types tp ON tp.user_type_id = c.user_type_id
LEFT JOIN (
  SELECT ic.object_id, ic.column_id
  FROM sys.index_columns ic
  JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
  WHERE i.is_primary_key = 1
) pk ON pk.object_id = c.object_id AND pk.column_id = c.column_id
WHERE c.object_id = OBJECT_ID('${table.replace(/'/g, "''")}')
ORDER BY c.column_id;`;

    try {
      const output = await runSQL(sql);
      if (!output.trim()) {
        return {
          content: [{ type: "text", text: `Table '${table}' not found.` }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: output }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// Tool: list_databases
server.tool(
  "list_databases",
  "List all databases on the Designer LocalDB instance.",
  {},
  async () => {
    try {
      // Try HTTP first
      try {
        const output = await httpGet("/databases");
        return { content: [{ type: "text", text: output }] };
      } catch {
        // Fall through to SSH
      }

      const { pipe } = await discover();
      const script = `
$ErrorActionPreference = "Continue"
if ($PSVersionTable.PSVersion.Major -ge 7) {
  $PSNativeCommandUseErrorActionPreference = $false
}
& sqlcmd -S '${pipe.replace(/'/g, "''")}' -E -No -d master -b -W -s "|" -Q "SET NOCOUNT ON; SELECT name, state_desc, create_date FROM sys.databases ORDER BY name;"
exit $LASTEXITCODE
`;
      const result = await execPowerShell(script);
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || result.stdout.trim());
      }
      return { content: [{ type: "text", text: result.stdout }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// Tool: execute_sql_file
server.tool(
  "execute_sql_file",
  "Run a SQL file from tools/sql/ against the Designer project database. Use list_tables or query first to understand the schema.",
  {
    filename: z
      .string()
      .describe("SQL filename within tools/sql/ (e.g. 'designer-keypad-led-map.sql')"),
    timeout: z
      .number()
      .optional()
      .describe("Timeout in milliseconds (default 30000)"),
  },
  async ({ filename, timeout }) => {
    const clean = basename(filename);
    if (clean !== filename) {
      return {
        content: [
          {
            type: "text",
            text: `Error: Invalid filename. Use just the filename, not a path.`,
          },
        ],
        isError: true,
      };
    }

    const filePath = resolve(SQL_DIR, clean);
    if (!filePath.startsWith(SQL_DIR)) {
      return {
        content: [{ type: "text", text: "Error: Path traversal detected." }],
        isError: true,
      };
    }

    if (!existsSync(filePath)) {
      const { readdirSync } = await import("fs");
      const available = readdirSync(SQL_DIR)
        .filter((f) => f.endsWith(".sql"))
        .join(", ");
      return {
        content: [
          {
            type: "text",
            text: `Error: File '${clean}' not found in tools/sql/.\nAvailable: ${available}`,
          },
        ],
        isError: true,
      };
    }

    try {
      const output = await runSQLFile(filePath, timeout ?? DEFAULT_TIMEOUT);
      return { content: [{ type: "text", text: output }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// ── Start ───────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
