SET NOCOUNT ON;
SET XACT_ABORT ON;

/*
Fix stale PJ2-4B-XXX-L01 bindings after RA3->HW conversion.

Observed mismatch:
- Some L01 picos carried legacy bindings (AssociatedTemplateId=1173, ButtonGroupInfoID=1463)
- New native HW-created L01 picos use AssociatedTemplateId=424, ButtonGroupInfoID=1459
- Existing converted devices may also carry SSRLPM LedLogic=4 instead of native 0

This script:
1) Finds all PJ2-4B-XXX-L01 devices.
2) Determines canonical AssociatedTemplateId from the most common L01 value.
3) Determines canonical ButtonGroupInfoID from SQLMODELINFO mapping.
4) Updates mismatched rows in tblControlStationDevice + tblButtonGroup.
5) Normalizes SSRLPM (ObjectType=76) LedLogic to 0 for L01 button PMs.
6) Marks PM rows + Project as dirty for transfer/save.
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
ORDER BY name DESC;

IF @ModelDbName IS NULL
BEGIN
  RAISERROR('No SQLMODELINFO database found.', 16, 1);
  RETURN;
END;

CREATE TABLE #L01Devices
(
  DeviceID BIGINT PRIMARY KEY,
  AreaName NVARCHAR(255) NULL,
  ControlStationName NVARCHAR(255) NULL,
  DeviceName NVARCHAR(255) NULL,
  ModelInfoID BIGINT NOT NULL,
  AssociatedTemplateId BIGINT NULL
);

DECLARE @Sql NVARCHAR(MAX);
SET @Sql = N'
INSERT INTO #L01Devices (DeviceID, AreaName, ControlStationName, DeviceName, ModelInfoID, AssociatedTemplateId)
SELECT
  csd.ControlStationDeviceID,
  a.Name,
  cs.Name,
  csd.Name,
  csd.ModelInfoID,
  csd.AssociatedTemplateId
FROM dbo.tblControlStationDevice csd
LEFT JOIN dbo.tblControlStation cs ON cs.ControlStationID = csd.ParentControlStationID
LEFT JOIN dbo.tblArea a ON a.AreaID = cs.ParentId
JOIN ' + QUOTENAME(@ModelDbName) + N'.dbo.TBLMODELINFO mi ON mi.MODELINFOID = csd.ModelInfoID
WHERE mi.LUTRONMODELNUMBERBASE = ''PJ2-4B-XXX-L01'';';
EXEC sp_executesql @Sql;

IF NOT EXISTS (SELECT 1 FROM #L01Devices)
BEGIN
  SELECT N'NO_PJ2_4B_L01_FOUND' AS Status;
  RETURN;
END;

DECLARE @TargetAssociatedTemplateId BIGINT;
SELECT TOP (1) @TargetAssociatedTemplateId = AssociatedTemplateId
FROM #L01Devices
WHERE AssociatedTemplateId IS NOT NULL
GROUP BY AssociatedTemplateId
ORDER BY COUNT(*) DESC, AssociatedTemplateId ASC;

IF @TargetAssociatedTemplateId IS NULL
BEGIN
  RAISERROR('Could not determine canonical AssociatedTemplateId for L01 devices.', 16, 1);
  RETURN;
END;

CREATE TABLE #CanonicalButtonGroup
(
  ModelInfoID BIGINT PRIMARY KEY,
  TargetButtonGroupInfoID BIGINT NOT NULL
);

SET @Sql = N'
INSERT INTO #CanonicalButtonGroup (ModelInfoID, TargetButtonGroupInfoID)
SELECT
  m.MODELINFOID,
  MIN(m.BUTTONGROUPINFOID) AS TargetButtonGroupInfoID
FROM ' + QUOTENAME(@ModelDbName) + N'.dbo.TBLBUTTONGROUPINFOMODELINFOMAP m
WHERE m.MODELINFOID IN (SELECT DISTINCT ModelInfoID FROM #L01Devices)
GROUP BY m.MODELINFOID;';
EXEC sp_executesql @Sql;

IF NOT EXISTS (SELECT 1 FROM #CanonicalButtonGroup)
BEGIN
  RAISERROR('Could not determine canonical ButtonGroupInfoID for L01 model(s).', 16, 1);
  RETURN;
END;

SELECT
  d.DeviceID,
  d.AreaName,
  d.ControlStationName,
  d.DeviceName,
  d.ModelInfoID,
  d.AssociatedTemplateId AS CurrentAssociatedTemplateId,
  @TargetAssociatedTemplateId AS TargetAssociatedTemplateId,
  bg.ButtonGroupID,
  bg.ButtonGroupInfoID AS CurrentButtonGroupInfoID,
  cbg.TargetButtonGroupInfoID,
  CASE WHEN ISNULL(d.AssociatedTemplateId, -1) <> @TargetAssociatedTemplateId THEN 1 ELSE 0 END AS WillUpdateAssociatedTemplate,
  CASE WHEN ISNULL(bg.ButtonGroupInfoID, -1) <> cbg.TargetButtonGroupInfoID THEN 1 ELSE 0 END AS WillUpdateButtonGroupInfo
FROM #L01Devices d
LEFT JOIN dbo.tblButtonGroup bg
  ON bg.ParentDeviceID = d.DeviceID
 AND bg.ParentDeviceType = 5
LEFT JOIN #CanonicalButtonGroup cbg
  ON cbg.ModelInfoID = d.ModelInfoID
ORDER BY d.DeviceID;

SELECT
  kb.ParentDeviceID AS DeviceID,
  kb.ButtonNumber,
  kb.ButtonID,
  pm.ProgrammingModelID,
  pm.Name AS ProgrammingModelName,
  pm.ObjectType,
  pm.LedLogic AS CurrentLedLogic,
  CAST(0 AS INT) AS TargetLedLogic,
  pm.NeedsTransfer,
  CASE WHEN ISNULL(pm.LedLogic, -999) <> 0 THEN 1 ELSE 0 END AS WillUpdateLedLogic
FROM dbo.tblKeypadButton kb
JOIN #L01Devices d ON d.DeviceID = kb.ParentDeviceID
JOIN dbo.tblProgrammingModel pm ON pm.ProgrammingModelID = kb.ProgrammingModelID
WHERE kb.ParentDeviceType = 5
  AND pm.ObjectType = 76
ORDER BY kb.ParentDeviceID, kb.ButtonNumber;

IF @Apply = 0
BEGIN
  SELECT N'DRY_RUN_ONLY' AS Status;
  RETURN;
END;

BEGIN TRY
  BEGIN TRANSACTION;

  UPDATE csd
  SET csd.AssociatedTemplateId = @TargetAssociatedTemplateId
  FROM dbo.tblControlStationDevice csd
  JOIN #L01Devices d ON d.DeviceID = csd.ControlStationDeviceID
  WHERE ISNULL(csd.AssociatedTemplateId, -1) <> @TargetAssociatedTemplateId;
  DECLARE @UpdatedAssociatedTemplate INT = @@ROWCOUNT;

  UPDATE bg
  SET bg.ButtonGroupInfoID = cbg.TargetButtonGroupInfoID
  FROM dbo.tblButtonGroup bg
  JOIN #L01Devices d ON d.DeviceID = bg.ParentDeviceID
  JOIN #CanonicalButtonGroup cbg ON cbg.ModelInfoID = d.ModelInfoID
  WHERE bg.ParentDeviceType = 5
    AND ISNULL(bg.ButtonGroupInfoID, -1) <> cbg.TargetButtonGroupInfoID;
  DECLARE @UpdatedButtonGroupInfo INT = @@ROWCOUNT;

  UPDATE pm
  SET
    pm.LedLogic = 0,
    pm.NeedsTransfer = 1
  FROM dbo.tblProgrammingModel pm
  JOIN dbo.tblKeypadButton kb ON kb.ProgrammingModelID = pm.ProgrammingModelID
  JOIN #L01Devices d ON d.DeviceID = kb.ParentDeviceID
  WHERE kb.ParentDeviceType = 5
    AND pm.ObjectType = 76
    AND (ISNULL(pm.LedLogic, -999) <> 0 OR ISNULL(pm.NeedsTransfer, 0) <> 1);
  DECLARE @UpdatedSSRLPM INT = @@ROWCOUNT;

  UPDATE dbo.tblProject
  SET NeedsSave = 1
  WHERE ISNULL(NeedsSave, 0) <> 1;
  DECLARE @UpdatedProject INT = @@ROWCOUNT;

  COMMIT TRANSACTION;

  SELECT
    @UpdatedAssociatedTemplate AS UpdatedAssociatedTemplateId,
    @UpdatedButtonGroupInfo AS UpdatedButtonGroupInfoID,
    @UpdatedSSRLPM AS UpdatedSSRLPMRows,
    @UpdatedProject AS UpdatedProjectNeedsSave;
END TRY
BEGIN CATCH
  IF XACT_STATE() <> 0
    ROLLBACK TRANSACTION;
  THROW;
END CATCH;
