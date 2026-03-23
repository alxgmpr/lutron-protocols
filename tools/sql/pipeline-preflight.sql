SET NOCOUNT ON;
SET XACT_ABORT ON;

/*
Pipeline preflight: snapshot state + diagnostics before conversion.
Read-only — no transactions, no data changes.

Output uses _Section column markers for PowerShell parsing.
Execute via convert-pipeline.ps1 or directly with run-localdb.ps1.
*/

DECLARE @Direction NVARCHAR(16) = N'RA3_TO_HW'; -- Injected by PowerShell

-- === Guards ===

IF @Direction NOT IN (N'RA3_TO_HW', N'HW_TO_RA3')
BEGIN
  RAISERROR('Invalid @Direction. Use RA3_TO_HW or HW_TO_RA3.', 16, 1);
  RETURN;
END;

IF DB_NAME() <> N'Project'
   AND DB_NAME() NOT LIKE N'Project[_]%'
BEGIN
  RAISERROR('Run this script only in a Project database (Project or Project_*).', 16, 1);
  RETURN;
END;

DECLARE @SourceProductType INT = CASE WHEN @Direction = N'RA3_TO_HW' THEN 3 ELSE 4 END;
DECLARE @TargetProductType INT = CASE WHEN @Direction = N'RA3_TO_HW' THEN 4 ELSE 3 END;

DECLARE @CurrentProductType INT;
SELECT TOP (1) @CurrentProductType = ProductType
FROM dbo.tblProject;

IF @CurrentProductType IS NULL
BEGIN
  RAISERROR('tblProject.ProductType not found.', 16, 1);
  RETURN;
END;

IF @CurrentProductType <> @SourceProductType
BEGIN
  RAISERROR('Project ProductType (%d) does not match source for direction %s (expected %d).', 16, 1,
    @CurrentProductType, @Direction, @SourceProductType);
  RETURN;
END;

-- === Find SQLMODELINFO ===

DECLARE @ModelDbName SYSNAME;
SELECT TOP (1) @ModelDbName = name
FROM sys.databases
WHERE name LIKE '%SQLMODELINFO.MDF'
  AND name LIKE '%26.0.1.100%'
ORDER BY name DESC;

IF @ModelDbName IS NULL
BEGIN
  SELECT TOP (1) @ModelDbName = name
  FROM sys.databases
  WHERE name LIKE '%SQLMODELINFO.MDF'
  ORDER BY name DESC;
END;

IF @ModelDbName IS NULL
BEGIN
  RAISERROR('No SQLMODELINFO database found on this instance.', 16, 1);
  RETURN;
END;

DECLARE @ModelDbQuoted NVARCHAR(512) = QUOTENAME(@ModelDbName);

-- === METADATA section ===

SELECT
  N'METADATA' AS _Section,
  @Direction AS Direction,
  @SourceProductType AS SourceProductType,
  @TargetProductType AS TargetProductType,
  DB_NAME() AS DatabaseName,
  @ModelDbName AS ModelInfoDatabase,
  CONVERT(NVARCHAR(30), GETDATE(), 126) AS Timestamp;

-- === PRODUCT_TYPE section ===

SELECT
  N'PRODUCT_TYPE' AS _Section,
  N'tblProject' AS TableName,
  ProductType
FROM dbo.tblProject;

IF OBJECT_ID('dbo.tblVersion') IS NOT NULL
BEGIN
  SELECT
    N'PRODUCT_TYPE' AS _Section,
    N'tblVersion' AS TableName,
    ProductType
  FROM dbo.tblVersion;
END;

IF OBJECT_ID('dbo.tblVersionHistory') IS NOT NULL
BEGIN
  SELECT TOP (1)
    N'PRODUCT_TYPE' AS _Section,
    N'tblVersionHistory' AS TableName,
    ProductType
  FROM dbo.tblVersionHistory
  ORDER BY ConversionTimestamp DESC;
END;

-- === Build model usage ===

CREATE TABLE #ModelUsage
(
  TableName SYSNAME NOT NULL,
  ModelInfoID BIGINT NOT NULL,
  RefCount BIGINT NOT NULL
);

DECLARE @TableName SYSNAME;
DECLARE @Sql NVARCHAR(MAX);

DECLARE ModelTableCursor CURSOR LOCAL FAST_FORWARD FOR
SELECT t.name
FROM sys.tables t
JOIN sys.columns c ON c.object_id = t.object_id
WHERE SCHEMA_NAME(t.schema_id) = 'dbo'
  AND c.name = 'ModelInfoID'
ORDER BY t.name;

OPEN ModelTableCursor;
FETCH NEXT FROM ModelTableCursor INTO @TableName;

WHILE @@FETCH_STATUS = 0
BEGIN
  SET @Sql = N'
    INSERT INTO #ModelUsage (TableName, ModelInfoID, RefCount)
    SELECT N''' + REPLACE(@TableName, '''', '''''') + N''', ModelInfoID, COUNT(*)
    FROM dbo.' + QUOTENAME(@TableName) + N'
    WHERE ModelInfoID IS NOT NULL
    GROUP BY ModelInfoID;';
  EXEC sp_executesql @Sql;

  FETCH NEXT FROM ModelTableCursor INTO @TableName;
END;

CLOSE ModelTableCursor;
DEALLOCATE ModelTableCursor;

-- === MODEL_USAGE section ===

SET @Sql = N'
  SELECT
    N''MODEL_USAGE'' AS _Section,
    mu.TableName,
    mu.ModelInfoID,
    ISNULL(mi.LUTRONMODELNUMBERBASE, N''(unknown)'') AS ModelName,
    mu.RefCount
  FROM #ModelUsage mu
  LEFT JOIN ' + @ModelDbQuoted + N'.dbo.TBLMODELINFO mi
    ON mi.MODELINFOID = mu.ModelInfoID
  ORDER BY mu.TableName, mu.RefCount DESC;';
EXEC sp_executesql @Sql;

-- === Build model map ===

CREATE TABLE #ModelMap
(
  SourceModelInfoID BIGINT NOT NULL PRIMARY KEY,
  SourceModel NVARCHAR(255) NULL,
  TargetModel NVARCHAR(255) NULL,
  TargetModelInfoID BIGINT NULL,
  RuleApplied NVARCHAR(64) NULL
);

CREATE TABLE #ManualOverrides
(
  Direction NVARCHAR(16) NOT NULL,
  SourceModel NVARCHAR(255) NOT NULL,
  TargetModel NVARCHAR(255) NOT NULL
);

INSERT INTO #ManualOverrides (Direction, SourceModel, TargetModel)
VALUES
  (N'RA3_TO_HW', N'RR-PROC3-KIT', N'HQP7-RF-2'),
  (N'HW_TO_RA3', N'HQP7-RF-2', N'RR-PROC3-KIT');

INSERT INTO #ModelMap (SourceModelInfoID)
SELECT DISTINCT ModelInfoID
FROM #ModelUsage;

SET @Sql = N'
  UPDATE mm
  SET mm.SourceModel = mi.LUTRONMODELNUMBERBASE
  FROM #ModelMap mm
  LEFT JOIN ' + @ModelDbQuoted + N'.dbo.TBLMODELINFO mi
    ON mi.MODELINFOID = mm.SourceModelInfoID;';
EXEC sp_executesql @Sql;

-- Manual overrides
UPDATE mm
SET
  mm.TargetModel = mo.TargetModel,
  mm.RuleApplied = N'manual'
FROM #ModelMap mm
JOIN #ManualOverrides mo
  ON mo.Direction = @Direction
 AND mo.SourceModel = mm.SourceModel;

-- Prefix rules
IF @Direction = N'RA3_TO_HW'
BEGIN
  UPDATE #ModelMap
  SET TargetModel = N'HRST-' + SUBSTRING(SourceModel, 6, 8000),
      RuleApplied = N'RRST->HRST'
  WHERE SourceModel LIKE N'RRST-%';

  UPDATE #ModelMap
  SET TargetModel = N'HQRD-' + SUBSTRING(SourceModel, 5, 8000),
      RuleApplied = N'RRD->HQRD'
  WHERE TargetModel IS NULL AND SourceModel LIKE N'RRD-%';

  UPDATE #ModelMap
  SET TargetModel = N'HQR-' + SUBSTRING(SourceModel, 4, 8000),
      RuleApplied = N'RR->HQR'
  WHERE TargetModel IS NULL AND SourceModel LIKE N'RR-%';
END
ELSE
BEGIN
  UPDATE #ModelMap
  SET TargetModel = N'RRST-' + SUBSTRING(SourceModel, 6, 8000),
      RuleApplied = N'HRST->RRST'
  WHERE SourceModel LIKE N'HRST-%';

  UPDATE #ModelMap
  SET TargetModel = N'RRD-' + SUBSTRING(SourceModel, 6, 8000),
      RuleApplied = N'HQRD->RRD'
  WHERE TargetModel IS NULL AND SourceModel LIKE N'HQRD-%';

  UPDATE #ModelMap
  SET TargetModel = N'RR-' + SUBSTRING(SourceModel, 5, 8000),
      RuleApplied = N'HQR->RR'
  WHERE TargetModel IS NULL AND SourceModel LIKE N'HQR-%';
END;

-- Identity passthrough
UPDATE #ModelMap
SET TargetModel = SourceModel,
    RuleApplied = ISNULL(RuleApplied, N'identity')
WHERE TargetModel IS NULL;

-- First SQLMODELINFO lookup
SET @Sql = N'
  UPDATE mm
  SET mm.TargetModelInfoID = mi.MODELINFOID
  FROM #ModelMap mm
  LEFT JOIN ' + @ModelDbQuoted + N'.dbo.TBLMODELINFO mi
    ON mi.LUTRONMODELNUMBERBASE = mm.TargetModel;';
EXEC sp_executesql @Sql;

-- Fallbacks
IF @Direction = N'RA3_TO_HW'
BEGIN
  UPDATE #ModelMap
  SET TargetModel = N'HQR-' + SUBSTRING(SourceModel, 5, 8000),
      RuleApplied = N'RRD->HQR (fallback)'
  WHERE TargetModelInfoID IS NULL AND SourceModel LIKE N'RRD-%';
END
ELSE
BEGIN
  UPDATE #ModelMap
  SET TargetModel = N'RRD-' + SUBSTRING(SourceModel, 5, 8000),
      RuleApplied = N'HQR->RRD (fallback)'
  WHERE TargetModelInfoID IS NULL AND SourceModel LIKE N'HQR-%';
END;

-- Second lookup for fallbacks
SET @Sql = N'
  UPDATE mm
  SET mm.TargetModelInfoID = mi.MODELINFOID
  FROM #ModelMap mm
  LEFT JOIN ' + @ModelDbQuoted + N'.dbo.TBLMODELINFO mi
    ON mi.LUTRONMODELNUMBERBASE = mm.TargetModel
  WHERE mm.TargetModelInfoID IS NULL;';
EXEC sp_executesql @Sql;

-- === MODEL_MAP section ===

SELECT
  N'MODEL_MAP' AS _Section,
  mm.SourceModelInfoID,
  mm.SourceModel,
  mm.TargetModel,
  mm.TargetModelInfoID,
  mm.RuleApplied,
  SUM(mu.RefCount) AS TotalRefs
FROM #ModelMap mm
JOIN #ModelUsage mu ON mu.ModelInfoID = mm.SourceModelInfoID
GROUP BY
  mm.SourceModelInfoID, mm.SourceModel, mm.TargetModel,
  mm.TargetModelInfoID, mm.RuleApplied
ORDER BY TotalRefs DESC, mm.SourceModelInfoID;

-- === UNMAPPED section ===

SELECT
  N'UNMAPPED' AS _Section,
  mm.SourceModelInfoID,
  mm.SourceModel,
  mm.TargetModel,
  mm.RuleApplied,
  SUM(mu.RefCount) AS TotalRefs
FROM #ModelMap mm
JOIN #ModelUsage mu ON mu.ModelInfoID = mm.SourceModelInfoID
WHERE mm.TargetModelInfoID IS NULL
GROUP BY
  mm.SourceModelInfoID, mm.SourceModel, mm.TargetModel, mm.RuleApplied
ORDER BY TotalRefs DESC, mm.SourceModelInfoID;

-- === ORPHAN_STATIONS section ===

SELECT
  N'ORPHAN_STATIONS' AS _Section,
  cs.ControlStationID,
  a.Name AS AreaName,
  cs.Name AS ControlStationName
FROM dbo.tblControlStation cs
LEFT JOIN dbo.tblArea a ON a.AreaID = cs.ParentId
LEFT JOIN dbo.tblControlStationDevice csd ON csd.ParentControlStationID = cs.ControlStationID
GROUP BY cs.ControlStationID, a.Name, cs.Name
HAVING COUNT(csd.ControlStationDeviceID) = 0;

-- === PROGRAMMING_ISSUES section ===

DECLARE @ProgIssues TABLE
(
  ProgrammingModelID BIGINT,
  ObjectType INT,
  IsCorrupted BIT,
  IssueDescription NVARCHAR(MAX)
);

BEGIN TRY
  INSERT INTO @ProgIssues
  EXEC dbo.sel_ProgrammingModelIssues;
END TRY
BEGIN CATCH
  -- Stored proc may not exist in all schema versions
END CATCH;

SELECT
  N'PROGRAMMING_ISSUES' AS _Section,
  ProgrammingModelID,
  ObjectType,
  IssueDescription
FROM @ProgIssues
WHERE IsCorrupted = 1;

-- === CORRUPT_BTN section ===

DECLARE @CorruptBtn TABLE
(
  ID INT IDENTITY(1,1),
  Col1 NVARCHAR(MAX),
  Col2 NVARCHAR(MAX),
  Col3 NVARCHAR(MAX),
  Col4 NVARCHAR(MAX)
);

DECLARE @CorruptBtnCount INT = 0;

BEGIN TRY
  INSERT INTO @CorruptBtn (Col1, Col2, Col3, Col4)
  EXEC dbo.sel_CheckCorruptBtnProgramming @ProgrammingParentID = NULL;

  SET @CorruptBtnCount = @@ROWCOUNT;
END TRY
BEGIN CATCH
  -- Stored proc may not exist in all schema versions
END CATCH;

SELECT
  N'CORRUPT_BTN' AS _Section,
  @CorruptBtnCount AS CorruptButtonCount;

-- === PREFLIGHT_RESULT section ===

DECLARE @UnmappedCount INT = (SELECT COUNT(*) FROM #ModelMap WHERE TargetModelInfoID IS NULL);
DECLARE @OrphanCount INT;

SELECT @OrphanCount = COUNT(*)
FROM (
  SELECT cs.ControlStationID
  FROM dbo.tblControlStation cs
  LEFT JOIN dbo.tblControlStationDevice csd ON csd.ParentControlStationID = cs.ControlStationID
  GROUP BY cs.ControlStationID
  HAVING COUNT(csd.ControlStationDeviceID) = 0
) orphans;

DECLARE @IssueCount INT = (SELECT COUNT(*) FROM @ProgIssues WHERE IsCorrupted = 1);

SELECT
  N'PREFLIGHT_RESULT' AS _Section,
  @UnmappedCount AS UnmappedCount,
  @OrphanCount AS OrphanCount,
  @IssueCount AS ProgrammingIssueCount,
  @CorruptBtnCount AS CorruptButtonCount,
  CASE
    WHEN @UnmappedCount > 0 THEN N'FAIL'
    WHEN @OrphanCount > 0 OR @IssueCount > 0 OR @CorruptBtnCount > 0 THEN N'WARN'
    ELSE N'PASS'
  END AS Status;
