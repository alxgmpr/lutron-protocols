# Daylighting System

## Daylighting System -- Designer DB Reverse Engineering (2026-03-22)

Successfully added an LRF2-DCRB daylight sensor to the Homeworks project (Office area, serial 13100184). The sensor is paired and sends CCA SENSOR_LEVEL packets (format 0x0B, 0-1600 lux). However, light-level daylighting control is NOT active -- the scaffolding exists but the control loop isn't enabled.

### Two Distinct Daylighting Systems

**1. Hyperion (Shade Daylighting)** -- SUPPORTED in Homeworks:
- Sun position + facade angles -> motorized shade control
- `tblHyperionInfo` (ID 83): cloud level thresholds (partially=10K, mostly=5K, completely=3K cloudy; 70K/60K/50K bright lux)
- `tblHyperionSettings` (ID 84): work surface 30", max sun penetration 60", max 5 shade moves/day, 30min min between moves, civil twilight -6 degrees
- `tblFacade` (IDs 5-12): 8 compass orientations at 45 degree intervals (0 degrees, 45 degrees, 90 degrees... 315 degrees)
- `tblNaturalLightOptimizerShow` (ID 126): shade positions -- fadefighter lift=25%/tilt=75%, view=100%/50%, privacy=0%/0%
- This is the "mullion sensor" system for automated shades

**2. Light-Level Daylighting** -- SCAFFOLDING EXISTS, NOT ACTIVATED:
- Sensor reads ambient lux -> processor adjusts dimmer levels to maintain target
- Concept: closed-loop control where photosensor reading at work plane drives output level

### Designer DB Data Model

#### Auto-Created Scaffolding (present in our project)

**tblDaylightable** (53 rows) -- marks every zone as eligible for daylighting:
- DaylightableID = ZoneID + 1 (auto-created companion object)
- DaylightableObjectType: 10 = CCA zone (ObjectType 15), 363 = CCX zone (ObjectType 370)
- DaylightingDesignType: 1 for all
- GainGroupID: NULL (no calibration)

**tblDaylightingGroup** (16 rows) -- one per leaf area, auto-created:
- DaylightingGroupID = AreaID + 1
- ParentType=49, ParentID=19 (unknown container, possibly system-level daylighting root)
- IsDefaultGroup=1 for all
- Links to area via `tblArea.DaylightingGroupAssignedToID`

**tblDLSetPointDefinition** (ID 17) -- single global setpoint definition:
- ParentDomainID=2 (domain root)

**tblDLSetPointLevelAssignment** (20 rows) -- one per area:
- Level=100 (percent), TargetLightLevel=400 (lux)
- DaylightingSetPointDefinitionID=17
- ParentId = AreaID (all 16 leaf areas + 4 container areas)
- Meaning: "at 100% output, target 400 lux at work plane"

**tblArea daylighting columns** (all areas):
- `DaylightingGroupAssignedToID` -> DaylightingGroupID (leaf areas only)
- `DaylightingType` = 0 on ALL areas (disabled/not configured)
- `DaylightingDesignType` = 1
- `DaylightingAlwaysEnabled` = 1
- `DaylightingToOff` = 0
- `ActiveTargetSetPoint` = 17 (the DLSetPointDefinition)
- `MinimumLightLevel` = 400

#### Missing Tables (0 rows -- needed for control loop)

**tblDaylightingRegion** -- binds sensor(s) to an area:
- `Sensor1ID`, `Sensor2ID` -- up to 2 sensors per region
- `ParentAreaID` -- which area this region covers
- `MasterGain` -- overall gain for the region
- `PhotoSensorReadingOff`, `PhotoSensorReadingOn` -- calibration reference points
- `DLSetPointGainCalibrationType` -- calibration method
- `IsCalibrated`, `IsDaylightCurveEstablished` -- calibration state
- Without this table populated, the processor has no sensor->area mapping

**tblGainGroup** -- per-zone calibration within a region:
- `ParentDaylightingRegionID` -- which region
- `Gain`, `NormalizedValue` -- zone-specific gain factors
- `Hysteresis` -- deadband to prevent oscillation
- `PhotoSensorReadingOff`, `PhotoSensorReadingOn` -- per-zone calibration
- `WorkPlaneLightLevelOff` -- target light level when "off"

**tblDaylightingTestpoint** -- test points within an area for calibration:
- `ParentAreaID` -- links to area
- Connected to `tblDLTestpointPhotoSensor` (junction to sensors)

#### Template Settings (for reference)

**tblDaylightingTemplateSettings** (0 rows) -- template-level config:
- `DesiredLightLevel`, `WorkSurfaceHeight`
- `TargetSetPoint`, `IsAlwaysEnabled`, `HasDaylightToOff`
- `IsDaylightHarvestingEnabled` -- the key enable flag
- `HasAdvancedSettings`

### Sensor Object Chain

```
ControlStation (5134) "RF Daylight Sensor 001"
  ParentId=32 (Office area), ParentType=2
  └── ControlStationDevice (5136) "Device 1"
        ModelInfoID=1154, Serial=13100184
        └── Sensor (5140, ObjectType=17)
              └── SensorSensorCnnAssn (5141)
                    └── SensorConnection (5139, ObjectType=65)
                          ModelInfoID=1154
                          ScalingFactorValue=32
                          LightingControlType=1 (Dimmed)
                          ShadeGroupOneControlType=1 (Dimmed)
                          ShadeGroupTwoControlType=2 (Switched)
                          IsCalibrated=0
                          ReportingRateInSeconds=0
```

### LEAP Behavior

**RA3 processor (10.0.0.1)**:
- Sensor appears as `RPSDaylightSensor` type, device ID 5136, area "Office"
- `/photosensor` -> "400 BadRequest: This request is not supported"
- `/sensor` -> "400 BadRequest: This request is not supported"
- `/daylightinggainsettings` -> NOT exposed on area endpoints at all
- `/occupancysensorsettings` -> NOT exposed either

**Caseta (10.0.0.2)**:
- DOES expose `DaylightingGainSettings` -> `/area/{id}/daylightinggainsettings` for every area
- DOES expose `OccupancySensorSettings` -> `/area/{id}/occupancysensorsettings`
- Suggests Caseta firmware has a simpler version of the control loop

### ESN-QS Telnet Commands

- `AREAENTEREXITDAYLIGHTING` (handler 0x2E0CC) -- enter/exit daylight harvesting mode
- `FASTDAYLIGHTING` (handler 0x2E22C) -- fast daylighting adjustment
- These exist in the ESN-QS firmware command table but untested on RA3

### Open Questions

1. **Is the RA3 processor firmware capable of light-level daylighting?** The LEAP API doesn't expose the endpoints, but ESN commands exist. Possible explanations:
   - Feature gated behind commercial product type (Quantum/Athena only)
   - Endpoints only appear after DaylightingRegion is populated and transferred
   - RA3 firmware simply doesn't implement it (CCA sensor data received but ignored)

2. **Can we activate it by populating the missing tables?**
   - Create a DaylightingRegion binding sensor 5140 to area 32
   - Create GainGroup entries for each zone
   - Set DaylightingType to non-zero on the area
   - Transfer and see if LEAP endpoints appear

3. **What are the DaylightingType enum values?** All areas show 0. The template has `IsDaylightHarvestingEnabled` (bool). Maybe DaylightingType values are: 0=None, 1=OpenLoop, 2=ClosedLoop?

4. **Calibration workflow**: In commercial systems, technicians use Designer's calibration wizard to set gain curves. The wizard presumably reads live sensor values and adjusts zone levels to establish the gain relationship. Without this, we'd need to manually populate calibration values.

5. **Caseta DaylightingGainSettings**: Worth probing to see what the actual response body looks like -- it might reveal the expected data structure.

**Why:** Understanding this could enable automated daylight harvesting on the Homeworks system -- dimmer levels would auto-adjust based on ambient light to maintain target illuminance.

**How to apply:** If pursuing this, start with read-only LEAP probing (Caseta gain settings endpoint, RA3 ESN daylighting commands), then consider DB population experiments.
