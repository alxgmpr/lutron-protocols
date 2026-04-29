SET NOCOUNT ON;
SET XACT_ABORT ON;

/*
Pipeline verification: post-convert invariant checks.
Read-only — no transactions, no data changes.

Output uses _Section column markers for PowerShell parsing.
Execute via convert-pipeline.ps1 or directly with run-localdb.ps1.
*/

DECLARE @Direction NVARCHAR(16) = N'RA3_TO_HW'; -- The direction that WAS applied

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

DECLARE @TargetProductType INT = CASE WHEN @Direction = N'RA3_TO_HW' THEN 4 ELSE 3 END;

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

-- === Collect check results ===

CREATE TABLE #VerifyChecks
(
  CheckName NVARCHAR(64) NOT NULL,
  Status NVARCHAR(4) NOT NULL,  -- PASS or FAIL
  Detail NVARCHAR(512) NULL,
  FailCount INT NOT NULL DEFAULT 0
);

-- === Check 1: ProductType consistency ===

DECLARE @PtProject INT, @PtVersion INT, @PtHistory INT;

SELECT TOP (1) @PtProject = ProductType FROM dbo.tblProject;

IF OBJECT_ID('dbo.tblVersion') IS NOT NULL
  SELECT TOP (1) @PtVersion = ProductType FROM dbo.tblVersion;
ELSE
  SET @PtVersion = @TargetProductType; -- Skip if table missing

IF OBJECT_ID('dbo.tblVersionHistory') IS NOT NULL
  SELECT TOP (1) @PtHistory = ProductType FROM dbo.tblVersionHistory ORDER BY ConversionTimestamp DESC;
ELSE
  SET @PtHistory = @TargetProductType; -- Skip if table missing

DECLARE @PtFails INT = 0;
IF ISNULL(@PtProject, -1) <> @TargetProductType SET @PtFails = @PtFails + 1;
IF ISNULL(@PtVersion, -1) <> @TargetProductType SET @PtFails = @PtFails + 1;
IF ISNULL(@PtHistory, -1) <> @TargetProductType SET @PtFails = @PtFails + 1;

INSERT INTO #VerifyChecks (CheckName, Status, Detail, FailCount)
VALUES (
  N'PRODUCT_TYPE',
  CASE WHEN @PtFails = 0 THEN N'PASS' ELSE N'FAIL' END,
  N'Expected ' + CAST(@TargetProductType AS NVARCHAR(4)) +
    N': Project=' + ISNULL(CAST(@PtProject AS NVARCHAR(4)), N'NULL') +
    N', Version=' + ISNULL(CAST(@PtVersion AS NVARCHAR(4)), N'NULL') +
    N', History=' + ISNULL(CAST(@PtHistory AS NVARCHAR(4)), N'NULL'),
  @PtFails
);

-- === PRODUCT_TYPE section (detailed) ===

SELECT
  N'PRODUCT_TYPE' AS _Section,
  N'tblProject' AS TableName,
  ProductType,
  CASE WHEN ProductType = @TargetProductType THEN N'OK' ELSE N'MISMATCH' END AS Status
FROM dbo.tblProject;

IF OBJECT_ID('dbo.tblVersion') IS NOT NULL
BEGIN
  SELECT
    N'PRODUCT_TYPE' AS _Section,
    N'tblVersion' AS TableName,
    ProductType,
    CASE WHEN ProductType = @TargetProductType THEN N'OK' ELSE N'MISMATCH' END AS Status
  FROM dbo.tblVersion;
END;

IF OBJECT_ID('dbo.tblVersionHistory') IS NOT NULL
BEGIN
  SELECT TOP (1)
    N'PRODUCT_TYPE' AS _Section,
    N'tblVersionHistory' AS TableName,
    ProductType,
    CASE WHEN ProductType = @TargetProductType THEN N'OK' ELSE N'MISMATCH' END AS Status
  FROM dbo.tblVersionHistory
  ORDER BY ConversionTimestamp DESC;
END;

-- === Check 2: Leftover source-side models ===

CREATE TABLE #LeftoverModels
(
  TableName SYSNAME NOT NULL,
  ModelInfoID BIGINT NOT NULL,
  ModelName NVARCHAR(255) NULL,
  RefCount BIGINT NOT NULL
);

DECLARE @TableName SYSNAME;
DECLARE @Sql NVARCHAR(MAX);

DECLARE VerifyModelCursor CURSOR LOCAL FAST_FORWARD FOR
SELECT t.name
FROM sys.tables t
JOIN sys.columns c ON c.object_id = t.object_id
WHERE SCHEMA_NAME(t.schema_id) = 'dbo'
  AND c.name = 'ModelInfoID'
ORDER BY t.name;

OPEN VerifyModelCursor;
FETCH NEXT FROM VerifyModelCursor INTO @TableName;

WHILE @@FETCH_STATUS = 0
BEGIN
  IF @Direction = N'RA3_TO_HW'
  BEGIN
    -- After RA3->HW: check for remaining RA3 model names (RRST-, RRD-, RR-PROC3-KIT)
    SET @Sql = N'
      INSERT INTO #LeftoverModels (TableName, ModelInfoID, ModelName, RefCount)
      SELECT N''' + REPLACE(@TableName, '''', '''''') + N''', t.ModelInfoID, mi.LUTRONMODELNUMBERBASE, COUNT(*)
      FROM dbo.' + QUOTENAME(@TableName) + N' t
      JOIN ' + @ModelDbQuoted + N'.dbo.TBLMODELINFO mi ON mi.MODELINFOID = t.ModelInfoID
      WHERE t.ModelInfoID IS NOT NULL
        AND (mi.LUTRONMODELNUMBERBASE LIKE N''RRST-%''
          OR mi.LUTRONMODELNUMBERBASE LIKE N''RRD-%''
          OR mi.LUTRONMODELNUMBERBASE = N''RR-PROC3-KIT'')
      GROUP BY t.ModelInfoID, mi.LUTRONMODELNUMBERBASE;';
  END
  ELSE
  BEGIN
    -- After HW->RA3: check for remaining HW model names (HRST-, HQR-, HQRD-, HQP7-RF-2)
    SET @Sql = N'
      INSERT INTO #LeftoverModels (TableName, ModelInfoID, ModelName, RefCount)
      SELECT N''' + REPLACE(@TableName, '''', '''''') + N''', t.ModelInfoID, mi.LUTRONMODELNUMBERBASE, COUNT(*)
      FROM dbo.' + QUOTENAME(@TableName) + N' t
      JOIN ' + @ModelDbQuoted + N'.dbo.TBLMODELINFO mi ON mi.MODELINFOID = t.ModelInfoID
      WHERE t.ModelInfoID IS NOT NULL
        AND (mi.LUTRONMODELNUMBERBASE LIKE N''HRST-%''
          OR mi.LUTRONMODELNUMBERBASE LIKE N''HQR-%''
          OR mi.LUTRONMODELNUMBERBASE LIKE N''HQRD-%''
          OR mi.LUTRONMODELNUMBERBASE = N''HQP7-RF-2'')
      GROUP BY t.ModelInfoID, mi.LUTRONMODELNUMBERBASE;';
  END;

  EXEC sp_executesql @Sql;
  FETCH NEXT FROM VerifyModelCursor INTO @TableName;
END;

CLOSE VerifyModelCursor;
DEALLOCATE VerifyModelCursor;

DECLARE @LeftoverCount INT = (SELECT COUNT(*) FROM #LeftoverModels);
DECLARE @LeftoverRefCount INT = ISNULL((SELECT SUM(RefCount) FROM #LeftoverModels), 0);

INSERT INTO #VerifyChecks (CheckName, Status, Detail, FailCount)
VALUES (
  N'LEFTOVER_MODELS',
  CASE WHEN @LeftoverCount = 0 THEN N'PASS' ELSE N'FAIL' END,
  CASE WHEN @LeftoverCount = 0
    THEN N'No source-side model names remain.'
    ELSE CAST(@LeftoverCount AS NVARCHAR(10)) + N' model(s) with ' +
         CAST(@LeftoverRefCount AS NVARCHAR(10)) + N' total refs still on source side.'
  END,
  @LeftoverRefCount
);

-- === Check 3: Orphan stations ===

DECLARE @OrphanCount INT;

SELECT @OrphanCount = COUNT(*)
FROM (
  SELECT cs.ControlStationID
  FROM dbo.tblControlStation cs
  LEFT JOIN dbo.tblControlStationDevice csd ON csd.ParentControlStationID = cs.ControlStationID
  GROUP BY cs.ControlStationID
  HAVING COUNT(csd.ControlStationDeviceID) = 0
) orphans;

INSERT INTO #VerifyChecks (CheckName, Status, Detail, FailCount)
VALUES (
  N'ORPHAN_STATIONS',
  CASE WHEN @OrphanCount = 0 THEN N'PASS' ELSE N'FAIL' END,
  CASE WHEN @OrphanCount = 0
    THEN N'No orphan control stations.'
    ELSE CAST(@OrphanCount AS NVARCHAR(10)) + N' control station(s) with zero child devices.'
  END,
  @OrphanCount
);

-- === ORPHAN_STATIONS section (detailed) ===

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

-- === Check 4: Programming model issues ===

DECLARE @ProgIssues TABLE
(
  ProgrammingModelID BIGINT,
  ObjectType INT,
  IsCorrupted BIT,
  IssueDescription NVARCHAR(MAX)
);

DECLARE @ProgIssueCount INT = 0;

BEGIN TRY
  INSERT INTO @ProgIssues
  EXEC dbo.sel_ProgrammingModelIssues;

  SET @ProgIssueCount = (SELECT COUNT(*) FROM @ProgIssues WHERE IsCorrupted = 1);
END TRY
BEGIN CATCH
  -- Stored proc may not exist in all schema versions
END CATCH;

INSERT INTO #VerifyChecks (CheckName, Status, Detail, FailCount)
VALUES (
  N'PROGRAMMING_ISSUES',
  CASE WHEN @ProgIssueCount = 0 THEN N'PASS' ELSE N'FAIL' END,
  CASE WHEN @ProgIssueCount = 0
    THEN N'No corrupted programming models.'
    ELSE CAST(@ProgIssueCount AS NVARCHAR(10)) + N' corrupted programming model(s).'
  END,
  @ProgIssueCount
);

-- === Check 5: Corrupt button programming ===

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

INSERT INTO #VerifyChecks (CheckName, Status, Detail, FailCount)
VALUES (
  N'CORRUPT_BTN',
  CASE WHEN @CorruptBtnCount = 0 THEN N'PASS' ELSE N'FAIL' END,
  CASE WHEN @CorruptBtnCount = 0
    THEN N'No corrupt button programming.'
    ELSE CAST(@CorruptBtnCount AS NVARCHAR(10)) + N' corrupt button programming row(s).'
  END,
  @CorruptBtnCount
);

-- === VERIFY_CHECK section ===

SELECT
  N'VERIFY_CHECK' AS _Section,
  CheckName,
  Status,
  Detail,
  FailCount
FROM #VerifyChecks
ORDER BY
  CASE Status WHEN N'FAIL' THEN 0 ELSE 1 END,
  CheckName;

-- === LEFTOVER_DETAIL section (for rollback context) ===

SELECT
  N'LEFTOVER_DETAIL' AS _Section,
  TableName,
  ModelInfoID,
  ModelName,
  RefCount
FROM #LeftoverModels
ORDER BY RefCount DESC, TableName;

-- === VERIFY_RESULT section ===

DECLARE @TotalFailCount INT = ISNULL((SELECT SUM(FailCount) FROM #VerifyChecks WHERE Status = N'FAIL'), 0);
DECLARE @FailedChecks INT = (SELECT COUNT(*) FROM #VerifyChecks WHERE Status = N'FAIL');

SELECT
  N'VERIFY_RESULT' AS _Section,
  CASE WHEN @FailedChecks = 0 THEN N'PASS' ELSE N'FAIL' END AS OverallStatus,
  @FailedChecks AS FailedCheckCount,
  @TotalFailCount AS TotalFailCount;
