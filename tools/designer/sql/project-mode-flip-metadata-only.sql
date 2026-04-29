SET NOCOUNT ON;
SET XACT_ABORT ON;

/*
Metadata-only project mode flip.
Does NOT change ModelInfoID values.

Use when testing whether Designer UI mode gates are controlled by project/version ProductType only.
*/

DECLARE @Direction NVARCHAR(16) = N'RA3_TO_HW'; -- RA3_TO_HW | HW_TO_RA3
DECLARE @DryRun BIT = 1;                        -- 1 = preview only

IF @Direction NOT IN (N'RA3_TO_HW', N'HW_TO_RA3')
BEGIN
  RAISERROR('Invalid @Direction. Use RA3_TO_HW or HW_TO_RA3.', 16, 1);
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
  RAISERROR('Project ProductType does not match requested source mode for this direction.', 16, 1);
  RETURN;
END;

SELECT
  @Direction AS Direction,
  @CurrentProductType AS CurrentProductType,
  @TargetProductType AS TargetProductType,
  @DryRun AS DryRun;

SELECT
  Name AS ProjectName,
  ProductType,
  NeedsSave
FROM dbo.tblProject;

IF OBJECT_ID('dbo.tblVersion') IS NOT NULL
BEGIN
  SELECT
    ProductType,
    DBMajorVersion,
    DBMinorVersion,
    DBReleaseVersion,
    GUIMajorVersion,
    GUIMinorVersion,
    GUIReleaseVersion
  FROM dbo.tblVersion;
END;

IF OBJECT_ID('dbo.tblVersionHistory') IS NOT NULL
BEGIN
  SELECT TOP (10)
    ProductType,
    ConversionTimestamp,
    VersionOperationType
  FROM dbo.tblVersionHistory
  ORDER BY ConversionTimestamp DESC;
END;

IF @DryRun = 1
BEGIN
  RETURN;
END;

BEGIN TRY
  BEGIN TRANSACTION;

  UPDATE dbo.tblProject
  SET
    ProductType = @TargetProductType,
    NeedsSave = 1;

  IF OBJECT_ID('dbo.tblVersion') IS NOT NULL
  BEGIN
    UPDATE dbo.tblVersion
    SET ProductType = @TargetProductType;
  END;

  IF OBJECT_ID('dbo.tblVersionHistory') IS NOT NULL
  BEGIN
    UPDATE dbo.tblVersionHistory
    SET ProductType = @TargetProductType;
  END;

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF XACT_STATE() <> 0
    ROLLBACK TRANSACTION;
  THROW;
END CATCH;

SELECT
  Name AS ProjectName,
  ProductType,
  NeedsSave
FROM dbo.tblProject;

IF OBJECT_ID('dbo.tblVersion') IS NOT NULL
BEGIN
  SELECT
    ProductType,
    DBMajorVersion,
    DBMinorVersion,
    DBReleaseVersion,
    GUIMajorVersion,
    GUIMinorVersion,
    GUIReleaseVersion
  FROM dbo.tblVersion;
END;
