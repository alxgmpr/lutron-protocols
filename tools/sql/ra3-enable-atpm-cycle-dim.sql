SET NOCOUNT ON;
SET XACT_ABORT ON;

/*
Run in the active RA3 project database while the RA3 file is open in Designer.

Purpose:
- Convert one ATPM button programming model to a HomeWorks-style hold+double-tap preset scaffold.
- This mirrors the known HW ATPM pattern:
  - LedLogic = 13
  - AllowDoubleTap = 1
  - HeldButtonAction = 0
  - HoldPresetId and DoubleTapPresetID are both present

Default target is Office > Doorway > Position 1 > Button 2 (PM 1221).
*/

DECLARE @TargetProgrammingModelID BIGINT = 1221;

-- Behavior constants derived from HW rows (PM 540/569)
DECLARE @TargetLedLogic TINYINT = 13;
DECLARE @DoubleTapFade INT = 0;
DECLARE @DoubleTapDelay INT = 0;
DECLARE @DoubleTapLevel INT = 100;
DECLARE @HoldFade INT = 40;
DECLARE @HoldDelay INT = 30;
DECLARE @HoldLevel INT = 0;

BEGIN TRY
  BEGIN TRANSACTION;

  DECLARE @ObjectType SMALLINT;
  DECLARE @ParentType SMALLINT;
  DECLARE @OnPresetID BIGINT;
  DECLARE @OffPresetID BIGINT;
  DECLARE @ExistingHoldPresetID BIGINT;
  DECLARE @ExistingDoubleTapPresetID BIGINT;

  SELECT
    @ObjectType = pm.ObjectType,
    @ParentType = pm.ParentType,
    @OnPresetID = pm.OnPresetID,
    @OffPresetID = pm.OffPresetID,
    @ExistingHoldPresetID = pm.HoldPresetId,
    @ExistingDoubleTapPresetID = pm.DoubleTapPresetID
  FROM dbo.tblProgrammingModel pm
  WHERE pm.ProgrammingModelID = @TargetProgrammingModelID;

  IF @ObjectType IS NULL
    RAISERROR('Target ProgrammingModelID was not found.', 16, 1);

  IF @ObjectType <> 74
    RAISERROR('Target programming model is not ATPM (ObjectType 74).', 16, 1);

  IF @ParentType <> 57
    RAISERROR('Target programming model parent is not a keypad button (ParentType 57).', 16, 1);

  IF @OnPresetID IS NULL OR @OffPresetID IS NULL
    RAISERROR('Target ATPM must have OnPresetID and OffPresetID.', 16, 1);

  IF NOT EXISTS (
    SELECT 1
    FROM dbo.tblPresetAssignment pa
    WHERE pa.ParentID = @OnPresetID
      AND pa.ParentType = 43
  )
    RAISERROR('OnPreset has no preset assignments to clone.', 16, 1);

  IF EXISTS (
    SELECT 1
    FROM dbo.tblPresetAssignment pa
    WHERE pa.ParentID = @OnPresetID
      AND pa.ParentType = 43
      AND pa.AssignmentCommandType <> 2
  )
    RAISERROR('OnPreset contains non-level assignment command types; aborting for safety.', 16, 1);

  -- Remove prior hold/double-tap presets linked to this PM (if any).
  IF @ExistingHoldPresetID IS NOT NULL
  BEGIN
    DELETE acp
    FROM dbo.tblAssignmentCommandParameter acp
    JOIN dbo.tblPresetAssignment pa ON pa.PresetAssignmentID = acp.ParentId
    WHERE pa.ParentID = @ExistingHoldPresetID
      AND pa.ParentType = 43;

    DELETE FROM dbo.tblPresetAssignment
    WHERE ParentID = @ExistingHoldPresetID
      AND ParentType = 43;

    DELETE FROM dbo.tblPreset
    WHERE PresetID = @ExistingHoldPresetID
      AND ParentID = @TargetProgrammingModelID
      AND ParentType = 74;
  END

  IF @ExistingDoubleTapPresetID IS NOT NULL
  BEGIN
    DELETE acp
    FROM dbo.tblAssignmentCommandParameter acp
    JOIN dbo.tblPresetAssignment pa ON pa.PresetAssignmentID = acp.ParentId
    WHERE pa.ParentID = @ExistingDoubleTapPresetID
      AND pa.ParentType = 43;

    DELETE FROM dbo.tblPresetAssignment
    WHERE ParentID = @ExistingDoubleTapPresetID
      AND ParentType = 43;

    DELETE FROM dbo.tblPreset
    WHERE PresetID = @ExistingDoubleTapPresetID
      AND ParentID = @TargetProgrammingModelID
      AND ParentType = 74;
  END

  -- Seed metadata from existing On preset row.
  DECLARE @PresetDatabaseRevision INT;
  DECLARE @PresetSortOrder INT;
  DECLARE @PresetWhereUsedId BIGINT;
  DECLARE @PresetTemplateID BIGINT;
  DECLARE @PresetTemplateUsedID BIGINT;
  DECLARE @PresetTemplateReferenceID BIGINT;
  DECLARE @PresetTemplateInstanceNumber BIGINT;
  DECLARE @PresetIsGPD BIT;
  DECLARE @PresetSmartProgrammingDefaultGUID UNIQUEIDENTIFIER;

  SELECT
    @PresetDatabaseRevision = p.DatabaseRevision,
    @PresetSortOrder = p.SortOrder,
    @PresetWhereUsedId = p.WhereUsedId,
    @PresetTemplateID = p.TemplateID,
    @PresetTemplateUsedID = p.TemplateUsedID,
    @PresetTemplateReferenceID = p.TemplateReferenceID,
    @PresetTemplateInstanceNumber = p.TemplateInstanceNumber,
    @PresetIsGPD = p.IsGPDPreset,
    @PresetSmartProgrammingDefaultGUID = p.SmartProgrammingDefaultGUID
  FROM dbo.tblPreset p
  WHERE p.PresetID = @OnPresetID;

  IF @PresetDatabaseRevision IS NULL
    RAISERROR('Could not load metadata from OnPreset row.', 16, 1);

  DECLARE @NewDoubleTapPresetID BIGINT;
  DECLARE @NewHoldPresetID BIGINT;

  SELECT @NewDoubleTapPresetID = ISNULL(MAX(PresetID), 0) + 1
  FROM dbo.tblPreset WITH (UPDLOCK, HOLDLOCK);
  SET @NewHoldPresetID = @NewDoubleTapPresetID + 1;

  EXEC dbo.ins_Preset
    @PresetID = @NewDoubleTapPresetID,
    @Name = N'Double Tap',
    @DatabaseRevision = @PresetDatabaseRevision,
    @SortOrder = @PresetSortOrder,
    @ParentID = @TargetProgrammingModelID,
    @ParentType = 74,
    @NeedsTransfer = 1,
    @PresetType = 1,
    @WhereUsedId = @PresetWhereUsedId,
    @TemplateID = @PresetTemplateID,
    @TemplateUsedID = @PresetTemplateUsedID,
    @TemplateReferenceID = @PresetTemplateReferenceID,
    @TemplateInstanceNumber = @PresetTemplateInstanceNumber,
    @IsGPDPreset = @PresetIsGPD,
    @SmartProgrammingDefaultGUID = @PresetSmartProgrammingDefaultGUID,
    @Xid = NULL;

  EXEC dbo.ins_Preset
    @PresetID = @NewHoldPresetID,
    @Name = N'Hold',
    @DatabaseRevision = @PresetDatabaseRevision,
    @SortOrder = @PresetSortOrder,
    @ParentID = @TargetProgrammingModelID,
    @ParentType = 74,
    @NeedsTransfer = 1,
    @PresetType = 1,
    @WhereUsedId = @PresetWhereUsedId,
    @TemplateID = @PresetTemplateID,
    @TemplateUsedID = @PresetTemplateUsedID,
    @TemplateReferenceID = @PresetTemplateReferenceID,
    @TemplateInstanceNumber = @PresetTemplateInstanceNumber,
    @IsGPDPreset = @PresetIsGPD,
    @SmartProgrammingDefaultGUID = @PresetSmartProgrammingDefaultGUID,
    @Xid = NULL;

  DECLARE @SourceAssignments TABLE (
    rn INT IDENTITY(1,1) PRIMARY KEY,
    Name NVARCHAR(2000),
    DatabaseRevision INT,
    SortOrder INT,
    AssignableObjectID BIGINT,
    AssignableObjectType SMALLINT,
    AssignmentCommandType TINYINT,
    AssignmentCommandGroup TINYINT,
    WhereUsedId BIGINT,
    TemplateID BIGINT,
    TemplateUsedID BIGINT,
    TemplateReferenceID BIGINT,
    TemplateInstanceNumber BIGINT,
    IsDimmerLocalLoad BIT,
    SmartProgrammingDefaultGUID UNIQUEIDENTIFIER
  );

  INSERT INTO @SourceAssignments (
    Name,
    DatabaseRevision,
    SortOrder,
    AssignableObjectID,
    AssignableObjectType,
    AssignmentCommandType,
    AssignmentCommandGroup,
    WhereUsedId,
    TemplateID,
    TemplateUsedID,
    TemplateReferenceID,
    TemplateInstanceNumber,
    IsDimmerLocalLoad,
    SmartProgrammingDefaultGUID
  )
  SELECT
    pa.Name,
    pa.DatabaseRevision,
    pa.SortOrder,
    pa.AssignableObjectID,
    pa.AssignableObjectType,
    pa.AssignmentCommandType,
    pa.AssignmentCommandGroup,
    pa.WhereUsedId,
    pa.TemplateID,
    pa.TemplateUsedID,
    pa.TemplateReferenceID,
    pa.TemplateInstanceNumber,
    pa.IsDimmerLocalLoad,
    pa.SmartProgrammingDefaultGUID
  FROM dbo.tblPresetAssignment pa
  WHERE pa.ParentID = @OnPresetID
    AND pa.ParentType = 43
  ORDER BY pa.PresetAssignmentID;

  DECLARE @AssignmentCursor INT = 1;
  DECLARE @AssignmentCount INT;
  SELECT @AssignmentCount = COUNT(*) FROM @SourceAssignments;

  DECLARE @NextPresetAssignmentID BIGINT;
  SELECT @NextPresetAssignmentID = ISNULL(MAX(PresetAssignmentID), 0) + 1
  FROM dbo.tblPresetAssignment WITH (UPDLOCK, HOLDLOCK);

  WHILE @AssignmentCursor <= @AssignmentCount
  BEGIN
    DECLARE @Name NVARCHAR(2000);
    DECLARE @DatabaseRevision INT;
    DECLARE @SortOrder INT;
    DECLARE @AssignableObjectID BIGINT;
    DECLARE @AssignableObjectType SMALLINT;
    DECLARE @AssignmentCommandType TINYINT;
    DECLARE @AssignmentCommandGroup TINYINT;
    DECLARE @WhereUsedId BIGINT;
    DECLARE @TemplateID BIGINT;
    DECLARE @TemplateUsedID BIGINT;
    DECLARE @TemplateReferenceID BIGINT;
    DECLARE @TemplateInstanceNumber BIGINT;
    DECLARE @IsDimmerLocalLoad BIT;
    DECLARE @SmartProgrammingDefaultGUID UNIQUEIDENTIFIER;

    SELECT
      @Name = s.Name,
      @DatabaseRevision = s.DatabaseRevision,
      @SortOrder = s.SortOrder,
      @AssignableObjectID = s.AssignableObjectID,
      @AssignableObjectType = s.AssignableObjectType,
      @AssignmentCommandType = s.AssignmentCommandType,
      @AssignmentCommandGroup = s.AssignmentCommandGroup,
      @WhereUsedId = s.WhereUsedId,
      @TemplateID = s.TemplateID,
      @TemplateUsedID = s.TemplateUsedID,
      @TemplateReferenceID = s.TemplateReferenceID,
      @TemplateInstanceNumber = s.TemplateInstanceNumber,
      @IsDimmerLocalLoad = s.IsDimmerLocalLoad,
      @SmartProgrammingDefaultGUID = s.SmartProgrammingDefaultGUID
    FROM @SourceAssignments s
    WHERE s.rn = @AssignmentCursor;

    DECLARE @DoubleTapAssignmentID BIGINT = @NextPresetAssignmentID;
    SET @NextPresetAssignmentID = @NextPresetAssignmentID + 1;

    DECLARE @HoldAssignmentID BIGINT = @NextPresetAssignmentID;
    SET @NextPresetAssignmentID = @NextPresetAssignmentID + 1;

    DECLARE @DoubleTapParams NVARCHAR(MAX) =
      CONCAT('1,', @DoubleTapFade, ':2,', @DoubleTapDelay, ':3,', @DoubleTapLevel);

    DECLARE @HoldParams NVARCHAR(MAX) =
      CONCAT('1,', @HoldFade, ':2,', @HoldDelay, ':3,', @HoldLevel);

    EXEC dbo.ins_PresetAssignment
      @PresetAssignmentID = @DoubleTapAssignmentID,
      @Name = @Name,
      @DatabaseRevision = @DatabaseRevision,
      @SortOrder = @SortOrder,
      @ParentID = @NewDoubleTapPresetID,
      @ParentType = 43,
      @AssignableObjectID = @AssignableObjectID,
      @AssignableObjectType = @AssignableObjectType,
      @AssignmentCommandType = @AssignmentCommandType,
      @NeedsTransfer = 1,
      @AssignmentCommandGroup = @AssignmentCommandGroup,
      @AssignmentCommandParameter = @DoubleTapParams,
      @WhereUsedId = @WhereUsedId,
      @TemplateID = @TemplateID,
      @TemplateUsedID = @TemplateUsedID,
      @TemplateReferenceID = @TemplateReferenceID,
      @TemplateInstanceNumber = @TemplateInstanceNumber,
      @IsDimmerLocalLoad = @IsDimmerLocalLoad,
      @SmartProgrammingDefaultGUID = @SmartProgrammingDefaultGUID,
      @Xid = NULL;

    EXEC dbo.ins_PresetAssignment
      @PresetAssignmentID = @HoldAssignmentID,
      @Name = @Name,
      @DatabaseRevision = @DatabaseRevision,
      @SortOrder = @SortOrder,
      @ParentID = @NewHoldPresetID,
      @ParentType = 43,
      @AssignableObjectID = @AssignableObjectID,
      @AssignableObjectType = @AssignableObjectType,
      @AssignmentCommandType = @AssignmentCommandType,
      @NeedsTransfer = 1,
      @AssignmentCommandGroup = @AssignmentCommandGroup,
      @AssignmentCommandParameter = @HoldParams,
      @WhereUsedId = @WhereUsedId,
      @TemplateID = @TemplateID,
      @TemplateUsedID = @TemplateUsedID,
      @TemplateReferenceID = @TemplateReferenceID,
      @TemplateInstanceNumber = @TemplateInstanceNumber,
      @IsDimmerLocalLoad = @IsDimmerLocalLoad,
      @SmartProgrammingDefaultGUID = @SmartProgrammingDefaultGUID,
      @Xid = NULL;

    SET @AssignmentCursor = @AssignmentCursor + 1;
  END

  UPDATE dbo.tblProgrammingModel
  SET
    LedLogic = @TargetLedLogic,
    AllowDoubleTap = 1,
    HeldButtonAction = 0,
    HoldTime = 0,
    HoldPresetId = @NewHoldPresetID,
    DoubleTapPresetID = @NewDoubleTapPresetID,
    NeedsTransfer = 1
  WHERE ProgrammingModelID = @TargetProgrammingModelID;

  DECLARE @Issues TABLE (IsCorrupted BIT);
  INSERT INTO @Issues EXEC dbo.sel_ProgrammingModelIssues;

  IF EXISTS (SELECT 1 FROM @Issues WHERE IsCorrupted = 1)
    RAISERROR('Post-update integrity check failed (sel_ProgrammingModelIssues = 1).', 16, 1);

  COMMIT TRANSACTION;

  SELECT
    pm.ProgrammingModelID,
    pm.Name,
    pm.ObjectType,
    pm.LedLogic,
    pm.AllowDoubleTap,
    pm.HeldButtonAction,
    pm.HoldPresetId,
    pm.DoubleTapPresetID,
    pm.OnPresetID,
    pm.OffPresetID,
    pm.NeedsTransfer
  FROM dbo.tblProgrammingModel pm
  WHERE pm.ProgrammingModelID = @TargetProgrammingModelID;

  SELECT
    pa.ParentID AS PresetID,
    p.Name AS PresetName,
    pa.PresetAssignmentID,
    pa.AssignableObjectID,
    pa.AssignableObjectType,
    pa.AssignmentCommandType,
    acp.ParameterType,
    acp.ParameterValue
  FROM dbo.tblPresetAssignment pa
  JOIN dbo.tblPreset p ON p.PresetID = pa.ParentID
  JOIN dbo.tblAssignmentCommandParameter acp ON acp.ParentId = pa.PresetAssignmentID
  WHERE pa.ParentType = 43
    AND pa.ParentID IN (
      SELECT pm.HoldPresetId FROM dbo.tblProgrammingModel pm WHERE pm.ProgrammingModelID = @TargetProgrammingModelID
      UNION ALL
      SELECT pm.DoubleTapPresetID FROM dbo.tblProgrammingModel pm WHERE pm.ProgrammingModelID = @TargetProgrammingModelID
    )
  ORDER BY pa.ParentID, pa.PresetAssignmentID, acp.SortOrder;

END TRY
BEGIN CATCH
  IF XACT_STATE() <> 0
    ROLLBACK TRANSACTION;

  THROW;
END CATCH;
