SET NOCOUNT ON;
SET XACT_ABORT ON;

/*
Normalize all PJ2-4B-XXX-L01 Picos to TESTTEST-style baseline:
- Keep device/button/programming model/preset rows.
- Remove all preset assignments + assignment parameters.
- Mark programming models for transfer.
- Set project NeedsSave = 1.

This leaves each L01 Pico unassigned and fully ready for fresh programming in UI.
*/

DECLARE @Apply BIT = 0; -- 0 = preview, 1 = write

IF DB_NAME() <> N'Project'
   AND DB_NAME() NOT LIKE N'Project[_]%'
BEGIN
  RAISERROR('Run this only in a Project database (Project or Project_*).', 16, 1);
  RETURN;
END;

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
  RAISERROR('No SQLMODELINFO database found.', 16, 1);
  RETURN;
END;

DECLARE @Sql NVARCHAR(MAX);
DECLARE @ModelDbQuoted NVARCHAR(512) = QUOTENAME(@ModelDbName);

CREATE TABLE #L01Devices
(
  DeviceID BIGINT PRIMARY KEY,
  AreaName NVARCHAR(255) NULL,
  ControlStationName NVARCHAR(255) NULL,
  DeviceName NVARCHAR(255) NULL,
  AssociatedTemplateId BIGINT NULL
);

SET @Sql = N'
INSERT INTO #L01Devices (DeviceID, AreaName, ControlStationName, DeviceName, AssociatedTemplateId)
SELECT
  csd.ControlStationDeviceID,
  a.Name,
  cs.Name,
  csd.Name,
  csd.AssociatedTemplateId
FROM dbo.tblControlStationDevice csd
LEFT JOIN dbo.tblControlStation cs ON cs.ControlStationID = csd.ParentControlStationID
LEFT JOIN dbo.tblArea a ON a.AreaID = cs.ParentId
JOIN ' + @ModelDbQuoted + N'.dbo.TBLMODELINFO mi ON mi.MODELINFOID = csd.ModelInfoID
WHERE mi.LUTRONMODELNUMBERBASE = ''PJ2-4B-XXX-L01'';';
EXEC sp_executesql @Sql;

IF NOT EXISTS (SELECT 1 FROM #L01Devices)
BEGIN
  SELECT N'NO_L01_PICOS_FOUND' AS Status;
  RETURN;
END;

CREATE TABLE #ButtonPM
(
  DeviceID BIGINT NOT NULL,
  ButtonID BIGINT NOT NULL,
  ButtonNumber INT NOT NULL,
  ProgrammingModelID BIGINT NULL
);

INSERT INTO #ButtonPM (DeviceID, ButtonID, ButtonNumber, ProgrammingModelID)
SELECT
  d.DeviceID,
  kb.ButtonID,
  kb.ButtonNumber,
  kb.ProgrammingModelID
FROM #L01Devices d
JOIN dbo.tblKeypadButton kb
  ON kb.ParentDeviceID = d.DeviceID
 AND kb.ParentDeviceType = 5;

CREATE TABLE #Presets
(
  PresetID BIGINT PRIMARY KEY,
  ProgrammingModelID BIGINT NOT NULL
);

INSERT INTO #Presets (PresetID, ProgrammingModelID)
SELECT p.PresetID, p.ParentID
FROM dbo.tblPreset p
JOIN #ButtonPM b ON b.ProgrammingModelID = p.ParentID;

CREATE TABLE #PresetAssignments
(
  PresetAssignmentID BIGINT PRIMARY KEY,
  ParentPresetID BIGINT NOT NULL
);

INSERT INTO #PresetAssignments (PresetAssignmentID, ParentPresetID)
SELECT pa.PresetAssignmentID, pa.ParentID
FROM dbo.tblPresetAssignment pa
JOIN #Presets p ON p.PresetID = pa.ParentID;

SELECT
  d.DeviceID,
  d.AreaName,
  d.ControlStationName,
  d.DeviceName,
  d.AssociatedTemplateId,
  COUNT(DISTINCT b.ButtonID) AS Buttons,
  COUNT(DISTINCT p.PresetID) AS Presets,
  COUNT(DISTINCT pa.PresetAssignmentID) AS PresetAssignments,
  COUNT(ap.ParentId) AS AssignmentParams
FROM #L01Devices d
LEFT JOIN #ButtonPM b ON b.DeviceID = d.DeviceID
LEFT JOIN #Presets p ON p.ProgrammingModelID = b.ProgrammingModelID
LEFT JOIN #PresetAssignments pa ON pa.ParentPresetID = p.PresetID
LEFT JOIN dbo.tblAssignmentCommandParameter ap ON ap.ParentId = pa.PresetAssignmentID
GROUP BY d.DeviceID, d.AreaName, d.ControlStationName, d.DeviceName, d.AssociatedTemplateId
ORDER BY d.DeviceID;

IF @Apply = 0
BEGIN
  SELECT N'DRY_RUN_ONLY' AS Status;
  RETURN;
END;

BEGIN TRY
  BEGIN TRANSACTION;

  DELETE ap
  FROM dbo.tblAssignmentCommandParameter ap
  JOIN #PresetAssignments pa ON pa.PresetAssignmentID = ap.ParentId;
  DECLARE @DeletedParams INT = @@ROWCOUNT;

  DELETE paTbl
  FROM dbo.tblPresetAssignment paTbl
  JOIN #PresetAssignments pa ON pa.PresetAssignmentID = paTbl.PresetAssignmentID;
  DECLARE @DeletedAssignments INT = @@ROWCOUNT;

  UPDATE pm
  SET pm.NeedsTransfer = 1
  FROM dbo.tblProgrammingModel pm
  JOIN #ButtonPM b ON b.ProgrammingModelID = pm.ProgrammingModelID;
  DECLARE @UpdatedPM INT = @@ROWCOUNT;

  UPDATE dbo.tblProject
  SET NeedsSave = 1
  WHERE ISNULL(NeedsSave, 0) <> 1;
  DECLARE @UpdatedProject INT = @@ROWCOUNT;

  COMMIT TRANSACTION;

  SELECT
    @DeletedParams AS DeletedAssignmentParams,
    @DeletedAssignments AS DeletedPresetAssignments,
    @UpdatedPM AS UpdatedProgrammingModelsNeedsTransfer,
    @UpdatedProject AS UpdatedProjectNeedsSave;
END TRY
BEGIN CATCH
  IF XACT_STATE() <> 0
    ROLLBACK TRANSACTION;
  THROW;
END CATCH;
