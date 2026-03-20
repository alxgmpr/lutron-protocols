# RA3 System Internals (from Lutron Designer Transfer Log)

## Source
Transfer log from `Example Residence-template-v26.0.0.110.ra3` (software v26.0.0.110)

## Processor
- **Codename: "Janus"** (JanusProcRA3)
- Schema version: **168**
- Database: **268 tables** written on each transfer
- Transfer process: write all 268 tables → integrity check → upload → apply → reboot (~1 min) → RF device transfer (~2 min)
- Session GUID verification ensures transfer integrity

## CcaTransferlessActivationSupported (Table 268)
Last table in the schema. Confirms RA3 supports **"transferless activation"** — activating/pairing
CCA devices without a full database transfer. Relevant to our CCA pairing reverse engineering.

## Internal Codenames
| Codename | Context | Likely Meaning |
|----------|---------|----------------|
| Janus | JanusProcRA3 | RA3 processor |
| Pegasus | PegasusLink, PegasusLinkNode | A link/network type (unknown specifics) |
| Hyperion | Hyperion, HyperionAreaParameters, HyperionWindowType, HyperionShadowSettings | Daylight harvesting / facade management system |
| Kaleido | AssignmentCommandActivateKaleidoDisplay | Ketra Kaleido color display product |
| McCasey | McCaseyDimCurve | A dimming curve algorithm (internal name) |

## Communication Links
- **GreenPhyLinkNode** (table 235) — HomePlug Green PHY (powerline communication over copper wire)
  - RA3 uses **PoE/Ethernet** for processor ↔ repeater networking, NOT powerline
  - GreenPhy is likely used for **companion dimmer ↔ master dimmer** communication
    over the shared traveler/copper wire between ganged devices
  - Also possibly used for wired connections within an enclosure (e.g., dimmer modules in a panel)
- **PegasusLink / PegasusLinkNode** (tables 228-229) — unknown link type
- **Link / LinkNode** (tables 33, 36) — generic link abstraction
- **BaudRateLinkConfiguration** (table 37) — serial link config (for integration ports)

## Dimming Curves (4 Types)
| Table | Curve Type | Notes |
|-------|-----------|-------|
| WarmDimCurve (245) | Warm dim | CCT shift as brightness decreases (incandescent emulation) |
| XYSpline11KnotDimCurve (246) | CIE xy spline | 11-knot spline in CIE xy color space |
| CCTSpline11KnotDimCurve (247) | CCT spline | 11-knot spline in correlated color temperature |
| McCaseyDimCurve (248) | "McCasey" | Unknown algorithm — internal Lutron name |

## Key Database Tables (Grouped by Function)

### Device & Hardware
- LeapDeviceType (1), ModelInfo (2), EnclosureDevice (32), Enclosure (120)
- ControlStationDevice (28), ControlStation (121)
- RfPropertyAddress (43), RfController (46)
- SwitchLegController (49), SwitchLeg (114)
- ShadeSwitchLegController (50), ShadeSwitchLeg (115)
- VenetianSwitchLegController (51), VenetianSwitchLeg (116)
- ChannelSwitchLegController (52), MotorSwitchLegController (53)
- SliderCsd (29), DmxCsd (30), ReceptacleCsd (31)

### Buttons & Programming
- Button (55), ButtonGroup (44), ButtonController (47)
- Led (38), LedController (45)
- PresetAssignment (65), Preset (150), Scene (149), SceneController (113)
- SingleActionProgrammingModel (144)
- DualActionProgrammingModel (145)
- MasterRaiseLowerProgrammingModel (146)
- SingleSceneRaiseLowerProgrammingModel (147)
- AdvancedToggleProgrammingModel (148)
- SimpleConditionalProgrammingModel (142), ConditionalStates (143)
- AdvancedConditionalProgrammingModel (197) — ACPM conditional logic engine
- AcpmTrigger (198), AcpmExecutionAction (199), AcpmDelayAction (200)
- AcpmConditionalAction (201), AcpmCondition (202), AcpmRelationship (203)
- AcpmRangeBasedCondition (204)

### Zones & Areas
- Zone (122), Area (128), SpaceType (129)
- HvacZone (123), PhantomHvacZone (124)
- ShadeZone (125), VenetianZone (126), SoftSheerZone (127)
- ChromaZone (224) — color tuning zone (Ketra)

### Sensors
- Sensor (118), OccupancySensor (119)
- PicoSensorConnection (108) — Pico remote associations
- RfOccVacSensorConnection (105), RfDaylightingSensorConnection (106)
- RfShadowSensorConnection (107), RfTemperatureSensorConnection (109)
- SensorAssociation (112), SensorGroup (209), SensorSettings (250)

### Scheduling & Time
- TimeClock (151), TimeClockEvent (140), TimeClockMode (4)
- Schedule (18), WeeklyEventSchedule (15), ByDateEventSchedule (14)
- Sequence (61), SequenceStep (63)

### Integration
- IntegrationController (34), IntegrationPort (35), IntegrationDevice (175)
- IntegrationCommandSet (166), IntegrationCommand (170)
- IntegrationCommandProperty (171), IntegrationCommandEvent (264)
- StringConversion (167) — protocol string conversion for 3rd party

### Ketra / Advanced Lighting
- Fixture (9), LedFixture (10), LedClassicFixture (11)
- CompositeEmitterController (225), EmitterController (226)
- CompositeEmitter (230), Emitter (234), EmitterChannelConfig (233)
- DeviceEmitterProperties (227), DualCctConfig (231)
- UniversalLedChannelConfig (232)
- NaturalShow (236), NaturalShowStep (237), NaturalShowCurveGuide (238)
- ColorSwatchTemplate (64), ColorTableKey (155), ColorTableRow (156)
- SmartLamp (222), LinearSmartLamp (223)

### Daylighting / Facade
- DaylightingGroup (131), DaylightingRegion (132)
- DaylightingSetpointDefinition (24), DaylightingSensorConnection (93)
- Facade (205), NaturalLightOptimizer (206), NaturalLightOptimizerStage (207)
- NaturalLightOptimizerFadeFighterProgramming (251)

### Touchscreen UI
- AreaTouchscreenUi (159), DeviceTouchscreenUi (160)
- KeypadTouchscreenUi (162), ZoneTouchscreenUi (163)
- ButtonTouchscreenUi (164), LabelTouchscreenUi (165)

### Presence Detection (newer feature)
- PresenceDetectionButtonList (254), PresenceDetectionDeviceList (255)
- PresenceDetectionDoorList (256), PresenceDetectionOccupancyGroupList (257)
- PresenceDetectionSensorConnectionList (258), PresenceDetectionGroup (259)

### Assignment Commands (Action Parameters)
Extensive list of ~30 AssignmentCommand* tables (66-101, 239, 252, 262-263) covering:
- GoToLevel, GoToSpeed, GoToShadeLevelWithSpeed
- GoToPrimaryAndSecondaryLevels (dual-channel)
- GoToLiftAndTilt (venetian blinds)
- GoToFlash, Pulse, GoToSwitchedLevel
- SetHyperionMode, HyperionEnableState
- OpenCloseVenetianBlind, Open, Close
- ActivateNaturalShow, ActivateKaleidoDisplay
- AdjustRuntimeHighEndTrimWithGoToLevel — trim adjustment command!
- GoToLoadState, GoToLockState, GoToScene
- SetTimeclockState, UpdateHvacData, PartitionState
- OccupancyActiveState, OccupiedLevel, UnoccupiedLevel
- GoToDaylighting, DaylightingTsp
- UpdateRentableSpaceState, SetNaturalLightOptimizerEnabledState

### Other
- LoadShed (176), LoadType (177), LoadState (221)
- PowerSupplyOutput (178), PowerInterfaceAssignment (180)
- FanConfiguration (59), Speaker (56)
- Door (215), PartitionWall (135)
- RentableSpace (253), RentableSpaceProgrammingCriteria (260)
- GlobalPreference (210), DatabaseMetadata (243)
- DeviceFirmwareUpdateSchedule (244)
- CcaTransferlessActivationSupported (268)

## Lutron Designer LocalDB Access
- VM: `alex@10.0.0.5` (SSH, password: alex)
- Named pipe: `np:\\.\pipe\LOCALDB#CEA130DB\tsql\query` (pipe hash changes per instance start)
- Instance: `LutronLocalDb2022Gamma`
- Connect: `sqlcmd -S "np:\\.\pipe\LOCALDB#CEA130DB\tsql\query" -No` (must disable encryption)
- **Project** DB = active project data (268 tables from transfer log)
- **SqlModelInfo.mdf** = device model definitions (curves, hardware specs, button types)
- **SqlReferenceInfo.mdf** = reference/lookup data
- **SqlApplicationData.mdf** = per-version app settings
- Use `USE [full_mdf_path]` to switch to non-Project databases

## Device Transfer Status Patterns
- **"Device not addressed"** = device exists in project but not physically paired to RF network
  - All "Digital" position devices consistently showed this (Sunnata/Diva smart dimmers)
  - Powder Room devices also not addressed
- **"Transfer Complete"** = device on CCA network, config received via RF
  - Pico remotes (positions without load names: Bedside, Desk, Coffee Table, etc.)
  - In-wall switches/dimmers with load names (Cabinet, Backsplash, Doorway, etc.)
  - RF CCO (Fireplace Blower)

## Device Naming Convention
`Area\Location\Position N [LoadName-ComponentNumber]`
- Component number after load name (e.g., "Lamp-4") = LEAP component/zone number
- Positions without bracketed names = Pico remotes
- "Digital" positions = smart dimmers (Sunnata/Diva with digital features)
