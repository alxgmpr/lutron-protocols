#!/usr/bin/env npx tsx

/**
 * Designer Unlock — Universal Toolbox Unlock
 *
 * Makes all devices available across all product platforms in Designer.
 * Adds HW platform bits, cross-platform models, and HW LinkTypes.
 *
 * Run AFTER Designer starts, with or without a project open.
 * Both SQLMODELINFO and SQLREFERENCEINFO reset on every Designer restart.
 */

import { config } from "../lib/config";

const VM_HOST = config.designer.host;
const HTTP_BASE = `http://${VM_HOST}:9999`;

async function query(endpoint: string, sql: string): Promise<string> {
  const res = await fetch(`${HTTP_BASE}${endpoint}`, {
    method: "POST",
    body: sql,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.trim()}`);
  return text.trim();
}

async function main() {
  // Step 1: Discover database names
  const dbRes = await fetch(`${HTTP_BASE}/databases`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!dbRes.ok) {
    console.error("ERROR: Cannot reach HTTP API at", HTTP_BASE);
    console.error("Is sql-http-api.ps1 running on the VM?");
    process.exit(1);
  }
  const dbText = await dbRes.text();

  const modelDb = dbText
    .split("\n")
    .map((l) => l.split("|")[0].trim())
    .find((n) => n.endsWith("SQLMODELINFO.MDF"));
  const refDb = dbText
    .split("\n")
    .map((l) => l.split("|")[0].trim())
    .find((n) => n.endsWith("SQLREFERENCEINFO.MDF"));

  if (!modelDb || !refDb) {
    console.error(
      "ERROR: Could not find SQLMODELINFO or SQLREFERENCEINFO databases",
    );
    console.error("Is Designer running?");
    process.exit(1);
  }

  console.log("MODEL_DB:", modelDb);
  console.log("REF_DB:  ", refDb);
  console.log();

  // Step 2: Run all 4 gates in parallel
  const gates = [
    {
      name: "Gate 1: LinkTypes 32/34/36",
      sql: `INSERT INTO [${modelDb}].dbo.TBLLINKNODEINFOLINKTYPEMAP (LINKNODEINFOID, LINKTYPEID, SORTORDER)
SELECT DISTINCT lnm.LINKNODEINFOID, lt.LINKTYPEID, 1
FROM [${modelDb}].dbo.TBLLINKNODEINFOMODELINFOMAP lnm
CROSS JOIN (SELECT 32 as LINKTYPEID UNION SELECT 34 UNION SELECT 36) lt
WHERE NOT EXISTS (
  SELECT 1 FROM [${modelDb}].dbo.TBLLINKNODEINFOLINKTYPEMAP x
  WHERE x.LINKNODEINFOID = lnm.LINKNODEINFOID AND x.LINKTYPEID = lt.LINKTYPEID
);`,
    },
    {
      name: "Gate 2: ProductMasterList (RR% models)",
      sql: `INSERT INTO [${refDb}].dbo.TBLPRODINFOMDLINFOLISTMDLINFOID
  (PRODUCTINFOMODELINFOLISTCATID, MODELINFOID, SORTORDER, ISOBSOLETE, OVERRIDEFILTERINFOID)
SELECT 18, m.MODELINFOID,
  ROW_NUMBER() OVER (ORDER BY m.MODELINFOID) +
  (SELECT ISNULL(MAX(SORTORDER), 0) FROM [${refDb}].dbo.TBLPRODINFOMDLINFOLISTMDLINFOID WHERE PRODUCTINFOMODELINFOLISTCATID = 18),
  0, NULL
FROM [${modelDb}].dbo.TBLMODELINFO m
WHERE m.LUTRONMODELNUMBERBASE LIKE 'RR%'
AND m.LUTRONMODELNUMBERBASE NOT LIKE 'RR-MAIN%'
AND m.LUTRONMODELNUMBERBASE NOT LIKE 'RR-AUX%'
AND m.LUTRONMODELNUMBERBASE NOT LIKE 'RRK-%'
AND m.LUTRONMODELNUMBERBASE NOT LIKE 'RRQ-%'
AND m.MODELINFOID NOT IN (
  SELECT p.MODELINFOID FROM [${refDb}].dbo.TBLPRODINFOMDLINFOLISTMDLINFOID p
  WHERE p.PRODUCTINFOMODELINFOLISTCATID = 18
);`,
    },
    {
      name: "Gate 3a: Family platform bits",
      sql: `UPDATE [${modelDb}].dbo.TBLFAMILYCATEGORYINFO
SET TOOLBOXPLATFORMTYPES = TOOLBOXPLATFORMTYPES | 4128
WHERE TOOLBOXPLATFORMTYPES & 4128 <> 4128;`,
    },
    {
      name: "Gate 3b: Model platform bits",
      sql: `UPDATE [${modelDb}].dbo.TBLMODELINFOTOOLBOXPLATFORMTYPEMAP
SET TOOLBOXPLATFORMTYPEID = TOOLBOXPLATFORMTYPEID | 4128
WHERE TOOLBOXPLATFORMTYPEID & 4128 <> 4128;`,
    },
  ];

  // Try /query first (project DB), fall back to /query-master
  const endpoint = dbText.includes("Project") ? "/query" : "/query-master";

  const results = await Promise.all(
    gates.map(async (gate) => {
      try {
        const out = await query(endpoint, gate.sql);
        const match = out.match(/\((\d+) rows? affected\)/);
        return {
          name: gate.name,
          rows: match ? parseInt(match[1], 10) : 0,
          error: null,
        };
      } catch (e: any) {
        // Retry with /query-master if /query failed
        if (endpoint === "/query") {
          try {
            const out = await query("/query-master", gate.sql);
            const match = out.match(/\((\d+) rows? affected\)/);
            return {
              name: gate.name,
              rows: match ? parseInt(match[1], 10) : 0,
              error: null,
            };
          } catch (e2: any) {
            return { name: gate.name, rows: 0, error: e2.message };
          }
        }
        return { name: gate.name, rows: 0, error: e.message };
      }
    }),
  );

  // Report
  let hasError = false;
  for (const r of results) {
    if (r.error) {
      console.error(`FAIL  ${r.name}: ${r.error}`);
      hasError = true;
    } else {
      console.log(`  OK  ${r.name}: ${r.rows} rows`);
    }
  }

  if (hasError) {
    process.exit(1);
  }

  console.log("\nDone. All devices unlocked.");
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
