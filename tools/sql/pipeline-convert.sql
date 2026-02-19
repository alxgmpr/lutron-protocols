SET NOCOUNT ON;
SET XACT_ABORT ON;

/*
Pipeline conversion: single-transaction model ID + metadata conversion.
Aborts if any model cannot be mapped. No dry-run mode — use preflight first.

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

-- === Abort if unmapped ===

IF EXISTS (SELECT 1 FROM #ModelMap WHERE TargetModelInfoID IS NULL)
BEGIN
  SELECT
    N'CONVERT_ERROR' AS _Section,
    N'Unmapped models exist — conversion aborted.' AS ErrorMessage,
    (SELECT COUNT(*) FROM #ModelMap WHERE TargetModelInfoID IS NULL) AS UnmappedCount;

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
  GROUP BY mm.SourceModelInfoID, mm.SourceModel, mm.TargetModel, mm.RuleApplied
  ORDER BY TotalRefs DESC;

  RAISERROR('Unmapped model IDs found. Run preflight to inspect.', 16, 1);
  RETURN;
END;

-- === Execute conversion ===

BEGIN TRY
  BEGIN TRANSACTION;

  CREATE TABLE #UpdateStats
  (
    TableName SYSNAME NOT NULL,
    UpdatedRows INT NOT NULL
  );

  -- Update ModelInfoID in all tables
  DECLARE UpdateTableCursor CURSOR LOCAL FAST_FORWARD FOR
  SELECT DISTINCT TableName
  FROM #ModelUsage
  ORDER BY TableName;

  OPEN UpdateTableCursor;
  FETCH NEXT FROM UpdateTableCursor INTO @TableName;

  WHILE @@FETCH_STATUS = 0
  BEGIN
    SET @Sql = N'
      UPDATE t
      SET t.ModelInfoID = mm.TargetModelInfoID
      FROM dbo.' + QUOTENAME(@TableName) + N' t
      JOIN #ModelMap mm ON mm.SourceModelInfoID = t.ModelInfoID
      WHERE mm.TargetModelInfoID IS NOT NULL
        AND mm.TargetModelInfoID <> mm.SourceModelInfoID;
      INSERT INTO #UpdateStats (TableName, UpdatedRows)
      VALUES (N''' + REPLACE(@TableName, '''', '''''') + N''', @@ROWCOUNT);';
    EXEC sp_executesql @Sql;

    FETCH NEXT FROM UpdateTableCursor INTO @TableName;
  END;

  CLOSE UpdateTableCursor;
  DEALLOCATE UpdateTableCursor;

  -- Update ProductType metadata
  UPDATE dbo.tblProject
  SET ProductType = @TargetProductType,
      NeedsSave = 1;
  INSERT INTO #UpdateStats (TableName, UpdatedRows)
  VALUES (N'tblProject', @@ROWCOUNT);

  IF OBJECT_ID('dbo.tblVersion') IS NOT NULL
  BEGIN
    UPDATE dbo.tblVersion
    SET ProductType = @TargetProductType;
    INSERT INTO #UpdateStats (TableName, UpdatedRows)
    VALUES (N'tblVersion', @@ROWCOUNT);
  END;

  IF OBJECT_ID('dbo.tblVersionHistory') IS NOT NULL
  BEGIN
    UPDATE dbo.tblVersionHistory
    SET ProductType = @TargetProductType;
    INSERT INTO #UpdateStats (TableName, UpdatedRows)
    VALUES (N'tblVersionHistory', @@ROWCOUNT);
  END;

  COMMIT TRANSACTION;

  -- === TABLE_UPDATES section ===

  SELECT
    N'TABLE_UPDATES' AS _Section,
    TableName,
    UpdatedRows
  FROM #UpdateStats
  ORDER BY UpdatedRows DESC, TableName;

  -- === PRODUCT_TYPE_AFTER section ===

  SELECT
    N'PRODUCT_TYPE_AFTER' AS _Section,
    N'tblProject' AS TableName,
    ProductType
  FROM dbo.tblProject;

  IF OBJECT_ID('dbo.tblVersion') IS NOT NULL
  BEGIN
    SELECT
      N'PRODUCT_TYPE_AFTER' AS _Section,
      N'tblVersion' AS TableName,
      ProductType
    FROM dbo.tblVersion;
  END;

  IF OBJECT_ID('dbo.tblVersionHistory') IS NOT NULL
  BEGIN
    SELECT TOP (1)
      N'PRODUCT_TYPE_AFTER' AS _Section,
      N'tblVersionHistory' AS TableName,
      ProductType
    FROM dbo.tblVersionHistory
    ORDER BY ConversionTimestamp DESC;
  END;

  -- === CONVERT_RESULT section ===

  SELECT
    N'CONVERT_RESULT' AS _Section,
    @Direction AS Direction,
    CONVERT(NVARCHAR(30), GETDATE(), 126) AS CompletedTimestamp,
    (SELECT SUM(UpdatedRows) FROM #UpdateStats) AS TotalRowsUpdated;

END TRY
BEGIN CATCH
  IF XACT_STATE() <> 0
    ROLLBACK TRANSACTION;

  SELECT
    N'CONVERT_ERROR' AS _Section,
    ERROR_MESSAGE() AS ErrorMessage,
    ERROR_NUMBER() AS ErrorNumber,
    ERROR_SEVERITY() AS ErrorSeverity,
    ERROR_LINE() AS ErrorLine;

  THROW;
END CATCH;
