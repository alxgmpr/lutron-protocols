SET NOCOUNT ON;

/*
Run in the active Designer "Project" database.
This maps control-station device -> buttons -> LEDs -> programming models.
*/

-- 1) Find candidate keypad/control-station devices by name.
SELECT
  d.ControlStationDeviceID,
  d.Name AS DeviceName,
  d.RFDeviceSlot,
  d.BacklightLevel,
  d.ParentControlStationID
FROM tblControlStationDevice d
WHERE d.Name LIKE '%office%' OR d.Name LIKE '%keypad%'
ORDER BY d.ControlStationDeviceID;

-- 2) Core join: device -> button -> corresponding LED -> programming model.
-- Replace @DeviceId with your target ControlStationDeviceID (e.g. 926).
DECLARE @DeviceId BIGINT = 926;

SELECT
  d.ControlStationDeviceID,
  d.Name AS DeviceName,
  kb.ButtonID,
  kb.ButtonNumber,
  kb.Name AS ButtonName,
  kb.ComponentNumber,
  kb.CorrespondingLedId,
  kb.ProgrammingModelID,
  l.LedID,
  l.LedNumber,
  l.LedNumberOnLink,
  l.LedType,
  l.NightlightIntensity,
  l.StatusOnIntensity,
  l.ActiveLedState,
  l.InactiveLedState,
  pm.Name AS ProgrammingModelName,
  pm.ObjectType AS ProgrammingModelObjectType,
  pm.LedLogic,
  pm.UseReverseLedLogic,
  pm.ReferencePresetIDForLed,
  pm.PresetID,
  pm.OnPresetID,
  pm.OffPresetID,
  pm.PressPresetID,
  pm.ReleasePresetID
FROM tblControlStationDevice d
LEFT JOIN tblKeypadButton kb
  ON kb.ParentDeviceID = d.ControlStationDeviceID
LEFT JOIN tblLed l
  ON l.LedID = kb.CorrespondingLedId
LEFT JOIN tblProgrammingModel pm
  ON pm.ProgrammingModelID = kb.ProgrammingModelID
WHERE d.ControlStationDeviceID = @DeviceId
ORDER BY kb.ButtonNumber, kb.ButtonID;

-- 3) Resolve programming model references through the preset/scene view.
SELECT
  apsd.programming_model_id,
  apsd.button_id,
  apsd.led_logic_type,
  apsd.preset_id,
  apsd.scene_id,
  apsd.preset_assignment_id,
  apsd.assignment_command_type,
  apsd.control_type,
  apsd.zone_id,
  apsd.affected_device_id
FROM AllPresetsAndSceneDefinition apsd
WHERE apsd.programming_model_id IN (
  SELECT DISTINCT kb.ProgrammingModelID
  FROM tblKeypadButton kb
  WHERE kb.ParentDeviceID = @DeviceId
)
ORDER BY apsd.programming_model_id, apsd.button_id, apsd.preset_assignment_id;

-- 4) Optional: enumerate LED logic values currently used in project.
SELECT
  pm.LedLogic,
  pm.UseReverseLedLogic,
  COUNT(*) AS CountRows
FROM tblProgrammingModel pm
GROUP BY pm.LedLogic, pm.UseReverseLedLogic
ORDER BY pm.LedLogic, pm.UseReverseLedLogic;
