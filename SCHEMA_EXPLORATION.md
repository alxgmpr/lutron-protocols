# Lutron Database Schema Exploration

## System Type Identification

The primary difference between RA3 and HW projects is in **tblProject**:

| Field | RA3 Value | HW Value |
|-------|-----------|----------|
| ProductType | **3** | **4** |

This single field determines which product family the project belongs to.

## Device Model IDs

Each device references a `ModelInfoID` that identifies its hardware type:

### RA3 Project Devices
| Device Type | ModelInfoID |
|-------------|-------------|
| Enclosure (housing) | 5093 |
| Processor (RR-PROC3) | 5092 |
| Keypad (RRST-W3RL) | 5122 |
| Dimmer (RRST-PRO-N) | 5115 |

### HW Project Devices
| Device Type | ModelInfoID |
|-------------|-------------|
| Enclosure (housing) | 5046 |
| Processor (HQP7-RF-2) | 5045 |
| Keypad (HRST-W3RL) | 5056 |
| Dimmer (HRST-PRO-N) | 5063 |

## Device Identity Fields

Key fields in device tables (tblProcessor, tblControlStationDevice):

| Field | Purpose | Notes |
|-------|---------|-------|
| `SerialNumber` | Device serial number | Set when device is paired |
| `MacAddress` | Network MAC address | For processor/bridge |
| `ProgrammingID` | RF programming ID | Links device to RF network |
| `RFDeviceSlot` | Slot in RF pairing table | Position in pairing memory |
| `ProcessorCertificate` | Security certificate | For secure communication |
| `LoobKey` | Encryption key | For device authentication |
| `Guid` | Unique identifier | Internal tracking |
| `Xid` | External identifier | Cloud sync reference |

## Cross-Device Compatibility Analysis

### Hardware Similarities
Both RA3 and HW devices use:
- **Clear Connect X** (2.4 GHz) radio
- **Clear Connect A** (433 MHz) radio (for older compatibility)
- Same processor architecture
- Same keypad/dimmer hardware platform

### Key Obstacles to Cross-Use

1. **ModelInfoID Mismatch**: The designer software validates that devices match the ProductType
2. **Firmware Validation**: Processors likely validate device model IDs during pairing
3. **Serial Number Format**: May include product family encoding
4. **Certificate Chain**: Security certificates may be product-family specific

### Theoretical Cross-Use Approach

To use an HW device in an RA3 project (untested):

```sql
-- Option 1: Change project to HW type
UPDATE tblProject SET ProductType = 4;

-- Option 2: Swap ModelInfoIDs (risky - may break validation)
UPDATE tblProcessor SET ModelInfoID = 5045 WHERE ModelInfoID = 5092;
UPDATE tblEnclosure SET ModelInfoID = 5046 WHERE ModelInfoID = 5093;
-- etc.
```

**Warning**: This would likely fail at:
- Lutron Designer validation
- Processor firmware pairing
- Cloud activation

## Integration Architecture

### Integration Tables

| Table | Purpose |
|-------|---------|
| tblIntegrationID | Assigns integration IDs to objects |
| tblIntegrationCommand | RS232/IP command definitions |
| tblIntegrationCommandSet | Groups of commands |
| tblIntegrationPort | Serial/network port config |
| tblIntegrationCommandArgument | Command parameters |
| tblThirdPartyDevice | External device definitions |
| tblTelnetPort | Telnet access configuration |

### Integration ID Template Types

| ID | Type | Usage |
|----|------|-------|
| 0 | Unknown | Default |
| 1 | FreeForm | Custom ID format |
| 2 | Type Area Unit | Structured format |

### Third-Party Device Fields

The `tblThirdPartyDevice` table supports:
- IP Address / Port (network integration)
- Baud Rate / Parity (RS232 integration)
- Username / Password (authentication)
- RefCommandSetId (links to command definitions)
- Communication Mode

## Trigger and Action System

### Trigger Types (lstTriggerType)

| ID | Type | Description |
|----|------|-------------|
| 1 | Press | Button press |
| 2 | Release | Button release |
| 3 | DoubleTap | Double-tap gesture |
| 4 | Hold | Long press/hold |
| 5 | True | Boolean condition true |
| 6 | False | Boolean condition false |
| 7 | TimeClock | Scheduled event |
| 8 | Constant | Always active |

### Execution Types (lstExecutionType)

| ID | Type | Description |
|----|------|-------------|
| 1 | Activate | Turn on/activate scene |
| 2 | Raise | Increase level |
| 3 | Lower | Decrease level |
| 4 | Stop | Stop raise/lower |

### Time Clock Commands (LstTimeClockEventCommandType)

| ID | Command | Description |
|----|---------|-------------|
| 1 | EnableOccupancy | Turn on occupancy sensing |
| 2 | DisableOccupancy | Turn off occupancy sensing |
| 3 | GoToBeginAfterHoursState | Start after-hours mode |
| 4 | GoToEndAfterHoursState | End after-hours mode |
| 5 | SetLightsOnLevel | Set lights on level |
| 6 | SetLightsOffLevel | Set lights off level |
| 7 | BeginDaylighting | Start daylight harvesting |
| 8 | EndDaylighting | End daylight harvesting |
| 9 | StartHyperionSchedule | Start Hyperion schedule |
| 10 | EndHyperionSchedule | End Hyperion schedule |

## Variable System

For conditional logic and scenes:

| Table | Purpose |
|-------|---------|
| tblVariable | Variable definitions |
| tblVariableState | Possible states for each variable |

Example: Vacation Mode uses variables to toggle behavior.

## Occupancy Groups

The `tblOccupancyGroup` table controls:
- `OccupiedLevel` - Light level when occupied
- `UnoccupiedLevel` - Light level when unoccupied
- `SensorTimeout` - Timeout before unoccupied
- `AfterHoursTimeout` - Extended timeout for after-hours
- `GracePeriod` - Delay before dimming
- `WarningLevel` - Pre-off warning level

## Network/Cloud Configuration

### Processor System (tblProcessorSystem)
- `TcpAddress` / `TcpPort` - Network settings
- `MulticastAddress` - For system discovery
- `SubsystemCertificate` - Cloud authentication
- `UniqueLocalIPv6NetworkAddress` - IPv6 support

### Lutron Connect Bridge (tblLutronConnectBridge)
- `PublicKey` - Cloud authentication
- `EncKey` / `EncData` - Encrypted credentials
- Links to HomeKit / cloud services

## Hidden Features Summary

Features that exist in schema but may not be exposed in GUI:

1. **Double-Tap on RA3** - Can be enabled via `AllowDoubleTap` in tblProgrammingModel
2. **Cycle Dim on RA3** - Can be enabled via `HoldPresetId` in tblProgrammingModel
3. **Third-Party RS232** - tblThirdPartyDevice supports serial integration
4. **Third-Party IP** - Same table supports IP-based integration
5. **BACnet** - `IsBACnetEnabled` field in tblProcessor
6. **Advanced Time Clock** - Hyperion scheduling commands
7. **Custom Variables** - Can create custom state machines
8. **Extended Occupancy** - Configurable timeouts and levels

## Recommendations

1. **For Hidden Features**: Edit the database directly while Lutron Designer has the project open (live editing method)

2. **For Cross-Device Use**: Not recommended - too many validation points

3. **For Custom Integrations**: Use the tblThirdPartyDevice and tblIntegrationCommand tables to define RS232/IP integrations

4. **For Advanced Programming**: Manipulate tblProgrammingModel, tblPreset, and tblPresetAssignment directly

## Table Count Summary

Total tables in schema: **323**

Key table categories:
- Device tables: ~50
- Programming tables: ~30
- Integration tables: ~15
- Lookup (lst) tables: ~27
- View tables (All*): ~10
