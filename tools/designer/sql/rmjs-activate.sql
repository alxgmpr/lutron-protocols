-- Fix RMJS serial: 0x021F93A0 = 35623840 decimal
UPDATE tblControlStationDevice
SET SerialNumber = 35623840
WHERE ControlStationDeviceID = 10771;
