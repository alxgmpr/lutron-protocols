#!/usr/bin/env npx tsx

/**
 * MCP Server: Lutron Designer LocalDB
 *
 * Queries Designer's LocalDB via HTTP API running on the VM (sql-http-api.ps1).
 * Endpoints: /query (project DB), /query-master (master DB), /query-modelinfo (SQLMODELINFO), /databases, /pipes
 *
 * HTTP-only — no SSH fallback. If the HTTP API is down, tools fail immediately.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync, readFileSync } from "fs";
import { basename, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { z } from "zod";

// ── Config ──────────────────────────────────────────────────────────

import { config } from "../lib/config";

const VM_HOST = config.designer.host;
const HTTP_BASE = `http://${VM_HOST}:9999`;
const DEFAULT_TIMEOUT = 30_000;
const __dir = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dir, "sql");

// ── HTTP API ───────────────────────────────────────────────────────

async function httpQuery(
  endpoint: string,
  sql: string,
  timeout = DEFAULT_TIMEOUT,
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
  timeout = DEFAULT_TIMEOUT,
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

// ── SQL execution ─────────────────────────────────────────────────

async function runSQL(
  sql: string,
  timeout = DEFAULT_TIMEOUT,
  pipeOverride?: string,
): Promise<string> {
  const pipeSuffix = pipeOverride
    ? `?pipe=${encodeURIComponent(pipeOverride)}`
    : "";
  try {
    return await httpQuery(`/query${pipeSuffix}`, sql, timeout);
  } catch {
    return await httpQuery(`/query-master${pipeSuffix}`, sql, timeout);
  }
}

async function runSQLFile(
  filePath: string,
  timeout = DEFAULT_TIMEOUT,
  pipeOverride?: string,
): Promise<string> {
  const fileContent = readFileSync(filePath, "utf8");
  const pipeSuffix = pipeOverride
    ? `?pipe=${encodeURIComponent(pipeOverride)}`
    : "";
  try {
    return await httpQuery(`/query${pipeSuffix}`, fileContent, timeout);
  } catch {
    return await httpQuery(`/query-master${pipeSuffix}`, fileContent, timeout);
  }
}

// ── MCP Server ──────────────────────────────────────────────────────

const server = new McpServer({
  name: "designer-db",
  version: "3.0.0",
});

// Tool: query
server.tool(
  "query",
  "Run arbitrary SQL against the Designer LocalDB. Returns pipe-delimited results. Uses project DB when available, falls back to master for cross-DB queries.",
  {
    sql: z.string().describe("SQL query to execute"),
    pipe: z
      .string()
      .optional()
      .describe(
        "LocalDB pipe name from list_pipes. If omitted, uses MSSQLLocalDB.",
      ),
    timeout: z
      .number()
      .optional()
      .describe("Timeout in milliseconds (default 30000)"),
  },
  async ({ sql, pipe, timeout }) => {
    try {
      const output = await runSQL(sql, timeout ?? DEFAULT_TIMEOUT, pipe);
      return { content: [{ type: "text", text: output }] };
    } catch (e: any) {
      return {
        content: [{ type: "text", text: `Error: ${e.message}` }],
        isError: true,
      };
    }
  },
);

// Tool: list_tables
server.tool(
  "list_tables",
  "List tables in the Designer project database with row counts. Optional LIKE filter.",
  {
    filter: z
      .string()
      .optional()
      .describe(
        "Optional SQL LIKE pattern to filter table names (e.g. '%Zone%')",
      ),
    pipe: z
      .string()
      .optional()
      .describe("LocalDB pipe name from list_pipes."),
  },
  async ({ filter, pipe }) => {
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
      const output = await runSQL(sql, DEFAULT_TIMEOUT, pipe);
      return { content: [{ type: "text", text: output }] };
    } catch (e: any) {
      return {
        content: [{ type: "text", text: `Error: ${e.message}` }],
        isError: true,
      };
    }
  },
);

// Tool: describe_table
server.tool(
  "describe_table",
  "Show column names, types, nullability, and primary key status for a table.",
  {
    table: z.string().describe("Table name to describe"),
    pipe: z
      .string()
      .optional()
      .describe("LocalDB pipe name from list_pipes."),
  },
  async ({ table, pipe }) => {
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
      const output = await runSQL(sql, DEFAULT_TIMEOUT, pipe);
      if (!output.trim()) {
        return {
          content: [{ type: "text", text: `Table '${table}' not found.` }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: output }] };
    } catch (e: any) {
      return {
        content: [{ type: "text", text: `Error: ${e.message}` }],
        isError: true,
      };
    }
  },
);

// Tool: list_pipes
server.tool(
  "list_pipes",
  "List all LocalDB instances and their pipes on the Designer VM. NEVER use a pipe marked [Troubleshooting].",
  {},
  async () => {
    try {
      const output = await httpGet("/pipes");
      return { content: [{ type: "text", text: output }] };
    } catch (e: any) {
      return {
        content: [{ type: "text", text: `Error: ${e.message}` }],
        isError: true,
      };
    }
  },
);

// Tool: list_databases
server.tool(
  "list_databases",
  "List all databases on the Designer LocalDB instance.",
  {
    pipe: z
      .string()
      .optional()
      .describe("LocalDB pipe name from list_pipes. If omitted, uses MSSQLLocalDB."),
  },
  async ({ pipe: pipeOverride }) => {
    try {
      const pipeSuffix = pipeOverride
        ? `?pipe=${encodeURIComponent(pipeOverride)}`
        : "";
      const output = await httpGet(`/databases${pipeSuffix}`);
      return { content: [{ type: "text", text: output }] };
    } catch (e: any) {
      return {
        content: [{ type: "text", text: `Error: ${e.message}` }],
        isError: true,
      };
    }
  },
);

// Tool: execute_sql_file
server.tool(
  "execute_sql_file",
  "Run a SQL file from tools/sql/ against the Designer project database.",
  {
    filename: z
      .string()
      .describe(
        "SQL filename within tools/sql/ (e.g. 'designer-keypad-led-map.sql')",
      ),
    pipe: z
      .string()
      .optional()
      .describe("LocalDB pipe name from list_pipes."),
    timeout: z
      .number()
      .optional()
      .describe("Timeout in milliseconds (default 30000)"),
  },
  async ({ filename, pipe, timeout }) => {
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
      const output = await runSQLFile(
        filePath,
        timeout ?? DEFAULT_TIMEOUT,
        pipe,
      );
      return { content: [{ type: "text", text: output }] };
    } catch (e: any) {
      return {
        content: [{ type: "text", text: `Error: ${e.message}` }],
        isError: true,
      };
    }
  },
);

// ── Start ───────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
server.connect(transport);
