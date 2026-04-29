SET NOCOUNT ON;

DECLARE @BaselineDeviceID BIGINT = 3850; -- TESTTEST

DECLARE @Target TABLE (DeviceID BIGINT PRIMARY KEY);
INSERT INTO @Target(DeviceID)
VALUES (365), (1152), (1176), (2919), (3850);

DECLARE @ModelDbName SYSNAME;
SELECT TOP (1) @ModelDbName = name
FROM sys.databases
WHERE name LIKE '%SQLMODELINFO.MDF'
ORDER BY name DESC;

IF @ModelDbName IS NULL
BEGIN
  RAISERROR('No SQLMODELINFO database found.', 16, 1);
  RETURN;
END;

DECLARE @Sql NVARCHAR(MAX) = N'
SELECT
  csd.ControlStationDeviceID,
  a.Name AS AreaName,
  cs.Name AS ControlStationName,
  csd.Name AS DeviceName,
  csd.AssociatedTemplateId,
  csd.ModelInfoID,
  mi.LutronModelNumberBase,
  csd.RFDeviceSlot,
  csd.ParentControlStationID,
  csd.SerialNumber,
  csd.HardwareRevision,
  csd.IsManuallyProgrammed,
  csd.OrderOnCommunicationLink,
  csd.ProgrammingID,
  csd.TemplateID,
  csd.TemplateUsedID,
  csd.TemplateReferenceID,
  csd.TemplateInstanceNumber,
  csd.Xid
FROM dbo.tblControlStationDevice csd
LEFT JOIN dbo.tblControlStation cs ON cs.ControlStationID = csd.ParentControlStationID
LEFT JOIN dbo.tblArea a ON a.AreaID = cs.ParentId
JOIN ' + QUOTENAME(@ModelDbName) + N'.dbo.TBLMODELINFO mi ON mi.ModelInfoID = csd.ModelInfoID
WHERE csd.ControlStationDeviceID IN (365,1152,1176,2919,3850)
ORDER BY csd.ControlStationDeviceID;';
EXEC sp_executesql @Sql;

-- Button and PM shape
SELECT
  kb.ParentDeviceID,
  kb.ButtonID,
  kb.ButtonNumber,
  kb.Name AS ButtonName,
  kb.ButtonType,
  kb.CorrespondingLedId,
  kb.ComponentNumber,
  kb.ProgrammingModelID,
  pm.Name AS PMName,
  pm.ObjectType,
  pm.LedLogic,
  pm.AllowDoubleTap,
  pm.HeldButtonAction,
  pm.HoldTime,
  pm.PresetID,
  pm.DoubleTapPresetID,
  pm.HoldPresetId,
  pm.PressPresetID,
  pm.ReleasePresetID,
  pm.OnPresetID,
  pm.OffPresetID,
  pm.ControlType,
  pm.NeedsTransfer
FROM dbo.tblKeypadButton kb
LEFT JOIN dbo.tblProgrammingModel pm ON pm.ProgrammingModelID = kb.ProgrammingModelID
WHERE kb.ParentDeviceID IN (365,1152,1176,2919,3850)
  AND kb.ParentDeviceType = 5
ORDER BY kb.ParentDeviceID, kb.ButtonNumber;

-- Presets under those PMs
WITH pms AS (
  SELECT DISTINCT kb.ParentDeviceID, kb.ProgrammingModelID
  FROM dbo.tblKeypadButton kb
  WHERE kb.ParentDeviceID IN (365,1152,1176,2919,3850)
    AND kb.ParentDeviceType = 5
)
SELECT
  pms.ParentDeviceID,
  p.PresetID,
  p.Name,
  p.PresetType,
  p.ParentID,
  p.ParentType,
  p.NeedsTransfer,
  p.TemplateID,
  p.TemplateUsedID,
  p.TemplateReferenceID,
  p.TemplateInstanceNumber
FROM pms
JOIN dbo.tblPreset p ON p.ParentID = pms.ProgrammingModelID
ORDER BY pms.ParentDeviceID, p.PresetID;

-- Preset assignments and command params
WITH pms AS (
  SELECT DISTINCT kb.ParentDeviceID, kb.ProgrammingModelID
  FROM dbo.tblKeypadButton kb
  WHERE kb.ParentDeviceID IN (365,1152,1176,2919,3850)
    AND kb.ParentDeviceType = 5
),
presets AS (
  SELECT pms.ParentDeviceID, p.PresetID
  FROM pms
  JOIN dbo.tblPreset p ON p.ParentID = pms.ProgrammingModelID
)
SELECT
  presets.ParentDeviceID,
  pa.PresetAssignmentID,
  pa.ParentID AS ParentPresetID,
  pa.ParentType,
  pa.AssignableObjectID,
  pa.AssignableObjectType,
  pa.AssignmentCommandType,
  pa.AssignmentCommandGroup,
  pa.NeedsTransfer,
  acp.SortOrder AS ACP_SortOrder,
  acp.ParentID AS ACPParentID,
  acp.ParameterType,
  acp.ParameterValue
FROM presets
LEFT JOIN dbo.tblPresetAssignment pa ON pa.ParentID = presets.PresetID
LEFT JOIN dbo.tblAssignmentCommandParameter acp ON acp.ParentID = pa.PresetAssignmentID
ORDER BY presets.ParentDeviceID, pa.PresetAssignmentID, acp.SortOrder;

-- Count refs to each device in any table with ParentDeviceID
DECLARE @ParentDeviceRefSql NVARCHAR(MAX) = N'';
SELECT @ParentDeviceRefSql = @ParentDeviceRefSql +
  N'SELECT ''' + s.name + N'.' + t.name + N''' AS TableName, COUNT(*) AS RefRows FROM ' +
  QUOTENAME(s.name) + N'.' + QUOTENAME(t.name) +
  N' WHERE ParentDeviceID IN (365,1152,1176,2919,3850) UNION ALL '
FROM sys.tables t
JOIN sys.schemas s ON s.schema_id = t.schema_id
JOIN sys.columns c ON c.object_id = t.object_id
WHERE c.name = 'ParentDeviceID';

IF LEN(@ParentDeviceRefSql) > 0
BEGIN
  SET @ParentDeviceRefSql = LEFT(@ParentDeviceRefSql, LEN(@ParentDeviceRefSql) - 10) + N' ORDER BY TableName;';
  EXEC sp_executesql @ParentDeviceRefSql;
END;

-- Count refs to each device in tables with ParentID/ParentType
DECLARE @ParentRefSql NVARCHAR(MAX) = N'';
SELECT @ParentRefSql = @ParentRefSql +
  N'SELECT ''' + s.name + N'.' + t.name + N''' AS TableName, COUNT(*) AS RefRows FROM ' +
  QUOTENAME(s.name) + N'.' + QUOTENAME(t.name) +
  N' WHERE ParentID IN (365,1152,1176,2919,3850) AND ParentType IN (5,57) UNION ALL '
FROM sys.tables t
JOIN sys.schemas s ON s.schema_id = t.schema_id
WHERE EXISTS (SELECT 1 FROM sys.columns c WHERE c.object_id = t.object_id AND c.name = 'ParentID')
  AND EXISTS (SELECT 1 FROM sys.columns c WHERE c.object_id = t.object_id AND c.name = 'ParentType');

IF LEN(@ParentRefSql) > 0
BEGIN
  SET @ParentRefSql = LEFT(@ParentRefSql, LEN(@ParentRefSql) - 10) + N' ORDER BY TableName;';
  EXEC sp_executesql @ParentRefSql;
END;
