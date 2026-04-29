SET NOCOUNT ON;

/*
Run in active project database.
Use after applying ra3-enable-atpm-cycle-dim.sql and after transfer.
*/

DECLARE @TargetProgrammingModelID BIGINT = 1221;

SELECT
  pm.ProgrammingModelID,
  pm.Name AS PMName,
  pm.ObjectType,
  pm.LedLogic,
  pm.AllowDoubleTap,
  pm.HeldButtonAction,
  pm.HoldTime,
  pm.HoldPresetId,
  pm.DoubleTapPresetID,
  pm.OnPresetID,
  pm.OffPresetID,
  pm.NeedsTransfer,
  kb.ButtonID,
  kb.ButtonNumber,
  kb.Name AS ButtonName,
  csd.ControlStationDeviceID,
  csd.Name AS DeviceName,
  cs.Name AS ControlStationName,
  a.Name AS AreaName
FROM dbo.tblProgrammingModel pm
LEFT JOIN dbo.tblKeypadButton kb ON kb.ProgrammingModelID = pm.ProgrammingModelID
LEFT JOIN dbo.tblControlStationDevice csd ON csd.ControlStationDeviceID = kb.ParentDeviceID
LEFT JOIN dbo.tblControlStation cs ON cs.ControlStationID = csd.ParentControlStationID
LEFT JOIN dbo.tblArea a ON a.AreaID = cs.ParentId AND cs.ParentType = 2
WHERE pm.ProgrammingModelID = @TargetProgrammingModelID;

WITH refs AS (
  SELECT @TargetProgrammingModelID AS ProgrammingModelID, 'OnPresetID' AS RefType,
         (SELECT OnPresetID FROM dbo.tblProgrammingModel WHERE ProgrammingModelID=@TargetProgrammingModelID) AS PresetID
  UNION ALL
  SELECT @TargetProgrammingModelID, 'OffPresetID',
         (SELECT OffPresetID FROM dbo.tblProgrammingModel WHERE ProgrammingModelID=@TargetProgrammingModelID)
  UNION ALL
  SELECT @TargetProgrammingModelID, 'DoubleTapPresetID',
         (SELECT DoubleTapPresetID FROM dbo.tblProgrammingModel WHERE ProgrammingModelID=@TargetProgrammingModelID)
  UNION ALL
  SELECT @TargetProgrammingModelID, 'HoldPresetId',
         (SELECT HoldPresetId FROM dbo.tblProgrammingModel WHERE ProgrammingModelID=@TargetProgrammingModelID)
)
SELECT
  r.RefType,
  r.PresetID,
  p.Name AS PresetName,
  COUNT(pa.PresetAssignmentID) AS AssignmentCount
FROM refs r
LEFT JOIN dbo.tblPreset p ON p.PresetID = r.PresetID
LEFT JOIN dbo.tblPresetAssignment pa ON pa.ParentID = r.PresetID AND pa.ParentType = 43
GROUP BY r.RefType, r.PresetID, p.Name
ORDER BY r.RefType;

WITH refs AS (
  SELECT 'DoubleTapPresetID' AS RefType,
         (SELECT DoubleTapPresetID FROM dbo.tblProgrammingModel WHERE ProgrammingModelID=@TargetProgrammingModelID) AS PresetID
  UNION ALL
  SELECT 'HoldPresetId',
         (SELECT HoldPresetId FROM dbo.tblProgrammingModel WHERE ProgrammingModelID=@TargetProgrammingModelID)
)
SELECT
  r.RefType,
  pa.PresetAssignmentID,
  pa.AssignableObjectID,
  pa.AssignableObjectType,
  pa.AssignmentCommandType,
  acp.SortOrder,
  acp.ParameterType,
  acp.ParameterValue
FROM refs r
JOIN dbo.tblPresetAssignment pa ON pa.ParentID = r.PresetID AND pa.ParentType = 43
JOIN dbo.tblAssignmentCommandParameter acp ON acp.ParentId = pa.PresetAssignmentID
ORDER BY r.RefType, pa.PresetAssignmentID, acp.SortOrder;

SELECT
  ap.preset_assignment_id,
  ap.fade,
  ap.delay,
  ap.primary_level,
  ap.secondary_level,
  ap.goto_level_options
FROM dbo.AllPresetAssignmentsWithAssignmentCommandParameter ap
WHERE ap.preset_assignment_id IN (
  SELECT pa.PresetAssignmentID
  FROM dbo.tblPresetAssignment pa
  WHERE pa.ParentType = 43
    AND pa.ParentID IN (
      SELECT pm.DoubleTapPresetID FROM dbo.tblProgrammingModel pm WHERE pm.ProgrammingModelID=@TargetProgrammingModelID
      UNION ALL
      SELECT pm.HoldPresetId FROM dbo.tblProgrammingModel pm WHERE pm.ProgrammingModelID=@TargetProgrammingModelID
    )
)
ORDER BY ap.preset_assignment_id;

DECLARE @Issues TABLE (IsCorrupted BIT);
INSERT INTO @Issues EXEC dbo.sel_ProgrammingModelIssues;
SELECT * FROM @Issues;

DECLARE @ButtonID BIGINT;
SELECT @ButtonID = ParentID
FROM dbo.tblProgrammingModel
WHERE ProgrammingModelID = @TargetProgrammingModelID
  AND ParentType = 57;

EXEC dbo.sel_CheckCorruptBtnProgramming @ProgrammingParentID = @ButtonID;
