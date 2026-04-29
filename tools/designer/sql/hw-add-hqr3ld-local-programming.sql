SET NOCOUNT ON;
SET XACT_ABORT ON;

/*
Add missing local dimmer programming chain for existing 3LD/3PD devices.

Problem this fixes:
- Device exists as zone + zone UI, but has no local button/programming rows:
  tblButtonGroup -> tblKeypadButton -> tblProgrammingModel -> tblPreset -> tblPresetAssignment -> tblAssignmentCommandParameter

Safety:
- Writes only to current Project DB.
- Dry-run by default.
*/

DECLARE @Apply BIT = 0; -- 0 = preview, 1 = write

IF DB_NAME() <> N'Project'
   AND DB_NAME() NOT LIKE N'Project[_]%'
BEGIN
  RAISERROR('Run this only in a Project database (Project or Project_*).', 16, 1);
  RETURN;
END;

CREATE TABLE #RequestedDevice
(
  DeviceID BIGINT PRIMARY KEY
);

-- Auto-target all local dimmers represented by known 3LD/3PD model IDs in this project:
-- 3LD: 730 = HQR-3LD, 461 = RRD-3LD (legacy RA3 -> normalize to 730)
-- 3PD: 1300 = HQR-3PD-1, 1166 = RR-3PD-1 (legacy RA3 -> normalize to 1300)
INSERT INTO #RequestedDevice (DeviceID)
SELECT csd.ControlStationDeviceID
FROM dbo.tblControlStationDevice csd
WHERE csd.ModelInfoID IN (730, 461, 1300, 1166)
  AND EXISTS (
    SELECT 1
    FROM dbo.tblZoneControlUI zc
    WHERE zc.ParentDeviceID = csd.ControlStationDeviceID
      AND zc.ParentDeviceType = 5
  );

CREATE TABLE #Targets
(
  DeviceID BIGINT PRIMARY KEY,
  DeviceName NVARCHAR(255) NULL,
  ModelInfoID BIGINT NULL,
  AssignedZoneID BIGINT NULL,
  ExistingButtonGroupID BIGINT NULL,
  HasButtonGroup BIT NOT NULL,
  HasLocalButton BIT NOT NULL,
  NeedsModelNormalization BIT NOT NULL
);

INSERT INTO #Targets (DeviceID, DeviceName, ModelInfoID, AssignedZoneID, ExistingButtonGroupID, HasButtonGroup, HasLocalButton, NeedsModelNormalization)
SELECT
  d.ControlStationDeviceID,
  d.Name,
  d.ModelInfoID,
  z.AssignedZoneID,
  bg.ButtonGroupID,
  CASE
    WHEN EXISTS (
      SELECT 1
      FROM dbo.tblButtonGroup bg
      WHERE bg.ParentDeviceID = d.ControlStationDeviceID
        AND bg.ParentDeviceType = 5
    ) THEN 1 ELSE 0
  END AS HasButtonGroup,
  CASE
    WHEN EXISTS (
      SELECT 1
      FROM dbo.tblKeypadButton kb
      WHERE kb.ParentDeviceID = d.ControlStationDeviceID
        AND kb.ParentDeviceType = 5
      AND kb.ButtonNumber = 0
    ) THEN 1 ELSE 0
  END AS HasLocalButton,
  CASE WHEN d.ModelInfoID IN (461, 1166) THEN 1 ELSE 0 END AS NeedsModelNormalization
FROM dbo.tblControlStationDevice d
JOIN #RequestedDevice r ON r.DeviceID = d.ControlStationDeviceID
OUTER APPLY (
  SELECT TOP (1) zc.AssignedZoneID
  FROM dbo.tblZoneControlUI zc
  WHERE zc.ParentDeviceID = d.ControlStationDeviceID
    AND zc.ParentDeviceType = 5
  ORDER BY zc.ZoneControlUIID
) z
OUTER APPLY (
  SELECT TOP (1) g.ButtonGroupID
  FROM dbo.tblButtonGroup g
  WHERE g.ParentDeviceID = d.ControlStationDeviceID
    AND g.ParentDeviceType = 5
  ORDER BY g.ButtonGroupID
) bg;

IF EXISTS (SELECT 1 FROM #Targets WHERE AssignedZoneID IS NULL)
BEGIN
  SELECT * FROM #Targets WHERE AssignedZoneID IS NULL;
  RAISERROR('One or more target devices has no AssignedZoneID in tblZoneControlUI.', 16, 1);
  RETURN;
END;

-- Allowed models here are HQR/RR local dimmers (3LD/3PD).
IF EXISTS (SELECT 1 FROM #Targets WHERE ModelInfoID NOT IN (730, 461, 1300, 1166))
BEGIN
  SELECT * FROM #Targets WHERE ModelInfoID NOT IN (730, 461, 1300, 1166);
  RAISERROR('One or more target devices is not an allowed 3LD/3PD model (730/461/1300/1166).', 16, 1);
  RETURN;
END;

SELECT
  t.DeviceID,
  t.DeviceName,
  t.ModelInfoID,
  t.AssignedZoneID,
  t.ExistingButtonGroupID,
  t.HasButtonGroup,
  t.HasLocalButton,
  t.NeedsModelNormalization,
  CASE
    WHEN t.HasLocalButton = 0 AND t.NeedsModelNormalization = 1 THEN N'WILL_NORMALIZE_MODEL_AND_ADD_CHAIN'
    WHEN t.HasLocalButton = 0 THEN N'WILL_ADD_CHAIN'
    WHEN t.NeedsModelNormalization = 1 THEN N'WILL_NORMALIZE_MODEL_ONLY'
    ELSE N'ALREADY_HAS_CHAIN'
  END AS Action
FROM #Targets t
ORDER BY t.DeviceID;

IF @Apply = 0
BEGIN
  SELECT N'DRY_RUN_ONLY' AS Status;
  RETURN;
END;

CREATE TABLE #Missing
(
  DeviceID BIGINT PRIMARY KEY,
  DeviceName NVARCHAR(255) NULL,
  AssignedZoneID BIGINT NOT NULL,
  ExistingButtonGroupID BIGINT NULL,
  NeedsModelNormalization BIT NOT NULL
);

INSERT INTO #Missing (DeviceID, DeviceName, AssignedZoneID, ExistingButtonGroupID, NeedsModelNormalization)
SELECT DeviceID, DeviceName, AssignedZoneID, ExistingButtonGroupID, NeedsModelNormalization
FROM #Targets
WHERE HasLocalButton = 0
   OR NeedsModelNormalization = 1;

IF NOT EXISTS (SELECT 1 FROM #Missing)
BEGIN
  SELECT N'NO_OP_ALL_TARGETS_ALREADY_HAVE_CHAIN' AS Status;
  RETURN;
END;

BEGIN TRY
  BEGIN TRANSACTION;

  DECLARE @BaseButtonGroupID BIGINT = ISNULL((SELECT MAX(ButtonGroupID) FROM dbo.tblButtonGroup), 0);
  DECLARE @BaseButtonID BIGINT = ISNULL((SELECT MAX(ButtonID) FROM dbo.tblKeypadButton), 0);
  DECLARE @BaseProgrammingModelID BIGINT = ISNULL((SELECT MAX(ProgrammingModelID) FROM dbo.tblProgrammingModel), 0);
  DECLARE @BasePresetID BIGINT = ISNULL((SELECT MAX(PresetID) FROM dbo.tblPreset), 0);
  DECLARE @BasePresetAssignmentID BIGINT = ISNULL((SELECT MAX(PresetAssignmentID) FROM dbo.tblPresetAssignment), 0);

  -- Normalize legacy RA3 local-dimmer model IDs to HW-style model IDs for UI compatibility.
  -- 3LD: RRD-3LD(461) -> HQR-3LD(730)
  -- 3PD: RR-3PD-1(1166) -> HQR-3PD-1(1300)
  UPDATE d
  SET d.ModelInfoID = CASE WHEN d.ModelInfoID = 461 THEN 730
                           WHEN d.ModelInfoID = 1166 THEN 1300
                           ELSE d.ModelInfoID END
  FROM dbo.tblControlStationDevice d
  JOIN #Missing m ON m.DeviceID = d.ControlStationDeviceID
  WHERE m.NeedsModelNormalization = 1
    AND d.ModelInfoID IN (461, 1166);

  UPDATE ln
  SET ln.ModelInfoID = CASE WHEN ln.ModelInfoID = 461 THEN 730
                            WHEN ln.ModelInfoID = 1166 THEN 1300
                            ELSE ln.ModelInfoID END
  FROM dbo.tblLinkNode ln
  JOIN #Missing m ON m.DeviceID = ln.ParentDeviceID
  WHERE m.NeedsModelNormalization = 1
    AND ln.ParentDeviceType = 5
    AND ln.ModelInfoID IN (461, 1166);

  CREATE TABLE #Map
  (
    RN INT NOT NULL,
    DeviceID BIGINT NOT NULL,
    AssignedZoneID BIGINT NOT NULL,
    NeedInsertButtonGroup BIT NOT NULL,
    NewButtonGroupID BIGINT NOT NULL,
    NewButtonID BIGINT NOT NULL,
    NewProgrammingModelID BIGINT NOT NULL,
    OnPresetID BIGINT NOT NULL,
    OffPresetID BIGINT NOT NULL,
    HoldPresetID BIGINT NOT NULL,
    DoublePresetID BIGINT NOT NULL,
    OnPresetAssignmentID BIGINT NOT NULL,
    OffPresetAssignmentID BIGINT NOT NULL,
    HoldPresetAssignmentID BIGINT NOT NULL,
    DoublePresetAssignmentID BIGINT NOT NULL
  );

  ;WITH Ordered AS
  (
    SELECT
      ROW_NUMBER() OVER (ORDER BY m.DeviceID) AS RN,
      m.DeviceID,
      m.AssignedZoneID,
      m.ExistingButtonGroupID,
      SUM(CASE WHEN m.ExistingButtonGroupID IS NULL THEN 1 ELSE 0 END)
        OVER (ORDER BY m.DeviceID ROWS UNBOUNDED PRECEDING) AS RNNewButtonGroup
    FROM #Missing m
    WHERE EXISTS (
      SELECT 1
      FROM #Targets t
      WHERE t.DeviceID = m.DeviceID
        AND t.HasLocalButton = 0
    )
  )
  INSERT INTO #Map
  (
    RN, DeviceID, AssignedZoneID, NeedInsertButtonGroup,
    NewButtonGroupID, NewButtonID, NewProgrammingModelID,
    OnPresetID, OffPresetID, HoldPresetID, DoublePresetID,
    OnPresetAssignmentID, OffPresetAssignmentID, HoldPresetAssignmentID, DoublePresetAssignmentID
  )
  SELECT
    o.RN,
    o.DeviceID,
    o.AssignedZoneID,
    CASE WHEN o.ExistingButtonGroupID IS NULL THEN 1 ELSE 0 END AS NeedInsertButtonGroup,
    CASE
      WHEN o.ExistingButtonGroupID IS NULL THEN @BaseButtonGroupID + o.RNNewButtonGroup
      ELSE o.ExistingButtonGroupID
    END AS NewButtonGroupID,
    @BaseButtonID + o.RN,
    @BaseProgrammingModelID + o.RN,
    @BasePresetID + ((o.RN - 1) * 4) + 1,
    @BasePresetID + ((o.RN - 1) * 4) + 2,
    @BasePresetID + ((o.RN - 1) * 4) + 3,
    @BasePresetID + ((o.RN - 1) * 4) + 4,
    @BasePresetAssignmentID + ((o.RN - 1) * 4) + 1,
    @BasePresetAssignmentID + ((o.RN - 1) * 4) + 2,
    @BasePresetAssignmentID + ((o.RN - 1) * 4) + 3,
    @BasePresetAssignmentID + ((o.RN - 1) * 4) + 4
  FROM Ordered o;

  INSERT INTO dbo.tblButtonGroup
  (
    ButtonGroupID, Name, DatabaseRevision, SortOrder, ButtonGroupInfoID, ButtonGroupProgrammingType, Notes,
    ParentDeviceID, ParentDeviceType, ButtonGroupObjectType, StndAlnQSTmplBtnGrpInfoID, IsValid, ButtonGroupType,
    LastButtonPressRaiseLowerEvent, WhereUsedId, TemplateID, TemplateUsedID, TemplateReferenceID, TemplateInstanceNumber, Xid
  )
  SELECT
    m.NewButtonGroupID, N'Button Group 001', 0, 0, 439, 1, NULL,
    m.DeviceID, 5, 1, NULL, 1, 8,
    0, 2147483647, NULL, NULL, NULL, NULL, NULL
  FROM #Map m
  WHERE m.NeedInsertButtonGroup = 1;

  INSERT INTO dbo.tblKeypadButton
  (
    ButtonID, Name, DatabaseRevision, SortOrder, BacklightLevel, ButtonNumber, ButtonInfoId, CorrespondingLedId,
    ButtonType, ContactClosureInputNormalState, ProgrammingModelID, ComponentNumber, ParentDeviceID, ParentDeviceType,
    WhereUsedId, TemplateID, TemplateUsedID, TemplateReferenceID, TemplateInstanceNumber, Xid
  )
  SELECT
    m.NewButtonID, N'Button 0', 0, 0, 255, 0, NULL, NULL,
    1, 0, m.NewProgrammingModelID, NULL, m.DeviceID, 5,
    2147483647, NULL, NULL, NULL, NULL, NULL
  FROM #Map m;

  INSERT INTO dbo.tblProgrammingModel
  (
    ProgrammingModelID, ObjectType, Name, DatabaseRevision, SortOrder, LedLogic, UseReverseLedLogic, Notes,
    ReferencePresetIDForLed, AllowDoubleTap, HeldButtonAction, HoldTime, StopQedShadesIfMoving, PresetID,
    DoubleTapPresetID, HoldPresetId, PressPresetID, ReleasePresetID, OnPresetID, OffPresetID, Direction,
    ControlType, VariableId, ThreeWayToggle, ParentID, ParentType, NeedsTransfer, WhereUsedId, TemplateID,
    TemplateUsedID, TemplateReferenceID, TemplateInstanceNumber, Xid
  )
  SELECT
    m.NewProgrammingModelID, 74, N'ATPM', 0, 0, 13, 0, N'',
    NULL, 1, 0, 0, 0, NULL,
    m.DoublePresetID, m.HoldPresetID, NULL, NULL, m.OnPresetID, m.OffPresetID, NULL,
    0, NULL, NULL, m.NewButtonID, 57, 1, 2147483647, NULL,
    NULL, NULL, NULL, NULL
  FROM #Map m;

  INSERT INTO dbo.tblPreset
  (
    PresetID, Name, DatabaseRevision, SortOrder, ParentID, ParentType, NeedsTransfer, PresetType, WhereUsedId,
    TemplateID, TemplateUsedID, TemplateReferenceID, TemplateInstanceNumber, IsGPDPreset, SmartProgrammingDefaultGUID, Xid
  )
  SELECT m.OnPresetID, N'Press On', 0, 0, m.NewProgrammingModelID, 74, 1, 1, 2147483647,
         NULL, NULL, NULL, NULL, 0, '00000000-0000-0000-0000-000000000000', NULL
  FROM #Map m
  UNION ALL
  SELECT m.OffPresetID, N'Off Level', 0, 0, m.NewProgrammingModelID, 74, 1, 1, 2147483647,
         NULL, NULL, NULL, NULL, 0, '00000000-0000-0000-0000-000000000000', NULL
  FROM #Map m
  UNION ALL
  SELECT m.HoldPresetID, N'Hold', 0, 0, m.NewProgrammingModelID, 74, 1, 1, 2147483647,
         NULL, NULL, NULL, NULL, 0, '00000000-0000-0000-0000-000000000000', NULL
  FROM #Map m
  UNION ALL
  SELECT m.DoublePresetID, N'Double Tap', 0, 0, m.NewProgrammingModelID, 74, 1, 1, 2147483647,
         NULL, NULL, NULL, NULL, 0, '00000000-0000-0000-0000-000000000000', NULL
  FROM #Map m;

  INSERT INTO dbo.tblPresetAssignment
  (
    PresetAssignmentID, Name, DatabaseRevision, SortOrder, ParentID, ParentType, AssignableObjectID, AssignableObjectType,
    AssignmentCommandType, NeedsTransfer, AssignmentCommandGroup, WhereUsedId, TemplateID, TemplateUsedID,
    TemplateReferenceID, TemplateInstanceNumber, IsDimmerLocalLoad, SmartProgrammingDefaultGUID, Xid
  )
  SELECT m.OnPresetAssignmentID, N'''', 0, 0, m.OnPresetID, 43, m.AssignedZoneID, 15,
         2, 1, 1, 2147483647, NULL, NULL, NULL, NULL, 1, '00000000-0000-0000-0000-000000000000', NULL
  FROM #Map m
  UNION ALL
  SELECT m.OffPresetAssignmentID, N'''', 0, 0, m.OffPresetID, 43, m.AssignedZoneID, 15,
         2, 1, 1, 2147483647, NULL, NULL, NULL, NULL, 1, '00000000-0000-0000-0000-000000000000', NULL
  FROM #Map m
  UNION ALL
  SELECT m.HoldPresetAssignmentID, N'''', 0, 0, m.HoldPresetID, 43, m.AssignedZoneID, 15,
         2, 1, 1, 2147483647, NULL, NULL, NULL, NULL, 1, '00000000-0000-0000-0000-000000000000', NULL
  FROM #Map m
  UNION ALL
  SELECT m.DoublePresetAssignmentID, N'''', 0, 0, m.DoublePresetID, 43, m.AssignedZoneID, 15,
         2, 1, 1, 2147483647, NULL, NULL, NULL, NULL, 1, '00000000-0000-0000-0000-000000000000', NULL
  FROM #Map m;

  -- Parameters copied from working TESTING HQR-3LD template:
  -- type 2 = delay, type 1 = fade time/rate, type 3 = level.
  INSERT INTO dbo.tblAssignmentCommandParameter (SortOrder, ParentId, ParameterType, ParameterValue)
  SELECT 0, m.OnPresetAssignmentID, 2, 0 FROM #Map m
  UNION ALL SELECT 1, m.OnPresetAssignmentID, 1, 3 FROM #Map m
  UNION ALL SELECT 2, m.OnPresetAssignmentID, 3, 75 FROM #Map m
  UNION ALL SELECT 0, m.OffPresetAssignmentID, 2, 0 FROM #Map m
  UNION ALL SELECT 1, m.OffPresetAssignmentID, 1, 10 FROM #Map m
  UNION ALL SELECT 2, m.OffPresetAssignmentID, 3, 0 FROM #Map m
  UNION ALL SELECT 0, m.HoldPresetAssignmentID, 2, 30 FROM #Map m
  UNION ALL SELECT 1, m.HoldPresetAssignmentID, 1, 40 FROM #Map m
  UNION ALL SELECT 2, m.HoldPresetAssignmentID, 3, 0 FROM #Map m
  UNION ALL SELECT 0, m.DoublePresetAssignmentID, 2, 0 FROM #Map m
  UNION ALL SELECT 1, m.DoublePresetAssignmentID, 1, 0 FROM #Map m
  UNION ALL SELECT 2, m.DoublePresetAssignmentID, 3, 100 FROM #Map m;

  UPDATE dbo.tblProject
  SET NeedsSave = 1
  WHERE ISNULL(NeedsSave, 0) <> 1;

  COMMIT TRANSACTION;

  SELECT
    N'APPLIED' AS Status,
    m.DeviceID,
    m.AssignedZoneID,
    m.NewButtonGroupID,
    m.NewButtonID,
    m.NewProgrammingModelID,
    m.OnPresetID,
    m.OffPresetID,
    m.HoldPresetID,
    m.DoublePresetID
  FROM #Map m
  ORDER BY m.DeviceID;
END TRY
BEGIN CATCH
  IF XACT_STATE() <> 0
    ROLLBACK TRANSACTION;
  THROW;
END CATCH;
