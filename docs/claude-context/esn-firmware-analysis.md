# ESN-QS Firmware Analysis (Energi Savr Node)

## Source
- **App**: "Energi Savr.app" (macOS, in `/Energi Savr.app/Wrapper/Energi Savr.app/`)
- **File**: `FirmWare file for Demo.s19` (Motorola S-record format)
- **Architecture**: Motorola 68K / ColdFire (NOT x86 - Binary Ninja misidentified)
  - `4E 56` = LINK A6 (stack frame), `4E B9` = JSR, `4E 75` = RTS
  - "Autovector interrupt", "Format Error", "Address Error" = 68K exception names
- **Size**: ~200KB (0x8000 - 0x3977D), ~200 functions
- **Copyright**: "Copyright 2009 Lutron Electronics Co., Inc."
- **Device ID**: QSNE-2DAL-D (product string at 0x125C1, UTF-16)
- **Product Name**: "ESN-QS" (at 0x3970C)

## RTOS Task Table (0x38960+)
Each entry: 4-char name + config fields + stack/priority info

| Task | Name | Purpose |
|------|------|---------|
| LED  | LED  | LED indicator control |
| BTN  | BTN  | Button/input handling |
| WDOG | WDOG | Watchdog timer |
| DISP | DISP | Display |
| QS   | QS   | **QS Link = CCA radio task** |
| ATMR | ATMR | Application timer |
| BTE  | BTE  | Board-to-Ethernet bridge? |
| DBT  | DBT  | Database task |
| ENET | ENET | Ethernet driver |
| DHCP | DHCP | DHCP client |
| TLNT | TLNT | Telnet server |
| AUTO | AUTO | Autodetect (UDP broadcast) |
| TxET | TxETMR | TX Ethernet timer |

## Telnet Command Table (0x38CF0+)
Each entry: 48 bytes = command name (44 bytes null-padded) + 4-byte function pointer

### Device Control Commands
| Command | Handler | Description |
|---------|---------|-------------|
| DEVICECOMPONENTGOTOLEVEL | 0x2D124 | Set component to level (object_id, component, level) |
| DEVICEGROUPGOTOLEVEL | 0x2D010 | Set all components in group to level |
| DEVICEAREAGOTOSCENE | 0x2CE84 | Activate scene for area |
| DEVICECOMPONENTIDENTIFY | 0x2CB78 | Flash/identify a component |
| DEVICEGROUPIDENTIFY | 0x2CD28 | Flash/identify a group |
| DEVICECOMPONENTGOTOPMMODE | 0x2DFA8 | Enter programming master mode |
| DEVICEENTEREXITMODE | 0x2E668 | Enter/exit special modes |

### Addressing/Initialization Commands
| Command | Handler | Description |
|---------|---------|-------------|
| DEVICECOMPONENTINITIALIZE | 0x2D240 | Initialize component (0xFF=all, 0x00=new) |
| DEVICECOMPONENTUNADDRESS | 0x2D3C0 | Remove component addressing |
| DEVICEREQUESTCOMPONENTPRESENT | 0x2D49C | Query present components |
| DEVICEREQUESTCOMPONENTPRESENTANDADDRESSED | 0x2D578 | Query present+addressed |

### Configuration Commands
| Command | Handler | Description |
|---------|---------|-------------|
| SETDEVICENAME | 0x2C884 | Set device name (28 bytes hex) |
| SETDEVICECOMPONENTNAME | 0x2CA00 | Set component name (28 bytes hex) |
| SETPMTYPE | 0x2D820 | Set programming master type |
| SETPMSTARTINGSCENE | 0x2DA8C | Set PM starting scene number |
| SETPW | 0x2D9C8 | Set password |
| ASSIGNGROUPTOPM | 0x2DB40 | Assign group to programming master |
| REQUESTGROUPPMASSIGNMENT | 0x2DCE8 | Query group-to-PM assignments |

### Query/Report Commands
| Command | Handler | Description |
|---------|---------|-------------|
| QSPRINTCONNECTEDDEVICES | 0x2C76C | List connected QS devices |
| QSREQUESTINFODUMP | 0x2EED8 | Full device info dump |
| QSREQUESTCOMPONENTINFODUMP | 0x2C7B0 | Component info dump |
| QSREQUESTCOMPONENTCONFIGPROPERTY | 0x30FFC | Get config property |
| QSSETCOMPONENTCONFIGPROPERTY | 0x310F0 | Set config property |
| GETDEVICEMODE | 0x2DE14 | Query device operating mode |
| GETSCHEMA | 0x30454 | Query database schema version |
| REQUESTPRESENTSENSORS | 0x2DEE0 | Query attached sensors |

### Data Transfer Commands
| Command | Handler | Description |
|---------|---------|-------------|
| XFERCOMPFF | 0x2F45C | Transfer component flat file |
| XFERDBFF | 0x2FB98 | Transfer database flat file |
| DFCOUTOFBOX | 0x2DD84 | Default factory configuration |

### Firmware Update Commands
| Command | Handler | Description |
|---------|---------|-------------|
| BEGINFIRMWAREUPDATE | 0x2E36C | Start firmware update session |
| SENDFIRMWARESRECORD | 0x2E570 | Send S-record data |
| GETDEVICESINBOOT | 0x2E62C | List devices in bootloader |

### Image Transfer Commands
| Command | Handler | Description |
|---------|---------|-------------|
| IMAGEEXTRACTREQUEST | 0x2E7C4 | Request image extraction |
| IMAGEEXTRACTACKRECEIVEDRECORD | 0x30A04 | ACK received record |
| IMAGESENDTRANSFERRECORD | 0x30C90 | Send transfer record |
| IMAGESENDCOMPLETE | 0x2E8D8 | Complete image send |

### Monitoring Commands
| Command | Handler | Description |
|---------|---------|-------------|
| #MONITORING | 0x2D658 | Enable monitoring (0x01=enable, 0x02=disable) |
| ?MONITORING | 0x2D798 | Query monitoring status |

### Daylighting Commands
| Command | Handler | Description |
|---------|---------|-------------|
| AREAENTEREXITDAYLIGHTING | 0x2E0CC | Enter/exit daylight harvesting |
| FASTDAYLIGHTING | 0x2E22C | Fast daylighting adjustment |

## Config Parameter Table (0x39540+)
Second command table for `LUTRON` namespace config. Format: name + handler + param_type

| Parameter | Handler | Description |
|-----------|---------|-------------|
| LUTRON | 0x33BE0 | Namespace root |
| MACADDR | 0x32F48 | MAC address |
| CMDREV | 0x32E40 | Command revision |
| PRODFAM | 0x32EA8 | Product family |
| PRODTYPE | 0x32EF8 | Product type |
| DEVTYPE | 0x33004 | Device type |
| NAME | 0x3305C | Device name |
| UNINAME | 0x330C4 | Unicode name |
| IPADDR | 0x33198 | IP address |
| SUBNETMK | 0x33230 | Subnet mask |
| GATEADDR | 0x332C8 | Gateway address |
| DHCP | 0x33360 | DHCP enable |
| TELPORT | 0x33414 | Telnet port |
| RSTPASS | 0x33DEC | Reset password |
| CODEVER | 0x33498 | Code version |
| RESULT | 0x334F0 | Result code |
| SERNUM | 0x33540 | Serial number |
| /LUTRON | 0x33B90 | Namespace close |

## Response Format Strings (telnet output protocol)
These define the wire format for telnet responses:

```
QSCONNECTEDDEVICES,0x%02X,0x%08X,0x%08X
QSREPORTINFODUMP,0x%08X,0x...
DEVICEADDRESSINGSTATUS,0x%08X,0x%04X,0x%02X
DEVICEREPORTCOMPONENTPRESENT,0x%08X,0x%04X,0x...
DEVICEREPORTCOMPONENTPRESENTANDADDRESSED,0x%08X,0x%04X,0x...
~DEVICE,0x%08X,0x%04X,0x%04X
REPORTPMINFO,0x%08X,0x%02X,0x%02X,0x%02X,0x%02X,0x%02X
ASSIGNGROUPTOPMMSTATUS,0x%08X,0x%02X
REPORTGROUPPMASSIGNMENT,0x%08X,0x%02X
REPORTPMEXITPMMODE,0x%08X
REPORTPRESENTSENSORS,0x%08X,0x%02X,0x%04X
REPORTSCHEMA,0x%08X,0x%02X
REPORTDEVICEMODE,0x%02X
QSREPORTCOMPONENTINFODUMP,0x%08X,0x%04X,0x...
DEVICECOMPONENTSELFIDENTIFY,0x%08X,0x%04X
QSREPORTCOMPONENTCONFIGPROPERTY,0x%08X,0x%04X,0x%04X,0x%02X
XFERCOMPFF,0x%08X,0x%04X,0x%04X,0x%02X
XFERDBFF,0x%08X,0x%08X,0x%04X,0x%02X
FIRMWAREUPDATEERROR,0x%02X
BEGINFIRMWAREUPDATEACK,0x%02X,0x%08X
SRECORDACK,0x%08X
SRECORDNACK,0x%08X
FIRMWAREUPGRADECOMPLETE,0x%08X,0x%02X%02X
DEVICEREPROGRAMTIMEOUT,0x%08X
REPORTDEVICESINBOOT,0x%02X
ESNPROCESSINGOSUPGRADE
IMAGEEXTRACTRETURNRECORD,0x%08X,0x%02X,0x%02X,0x%08X,0x%08X,0x%08X,0x...
IMAGEEXTRACTCOMPLETE,0x%08X,0x%02X,0x%02X,0x%08X,0x%08X,0x%02X
IMAGESENDCOMPLETE,0x%08X,0x%02X,0x%02X,0x%08X,0x%08X,0x%02X
IMAGESENDACKRECEIVEDRECORD,0x%08X,0x%02X,0x%02X,0x%08X
```

## Address Structure (from format strings)
- **Object ID**: 4 bytes (0x%08X) = 32-bit device serial/address
- **Component Number**: 2 bytes (0x%04X) = 16-bit output/zone identifier
- **Level**: 2 bytes (0x7F7F example = ~50%, confirms `percent * 0xFEFF / 100`)
- **Scene Number**: 1 byte (0x%02X), max validated
- **Schema Revision**: 1 byte (0x%02X)
- **Property Number**: 2 bytes (0xB09F example)
- **Property Size**: 1 byte
- **Sensor Type**: 2 bytes (0x%04X)
- **Initialization Type**: 1 byte (0xFF=ALL, 0x00=NEW/UNADDRESSED)
- **Monitoring Value**: 1 byte (0x01=enable, 0x02=disable)

## Device Type Enumeration (0x13E80+)
Sequential string table:
0. GRAFIKEYE
1. SHADE
2. POWERPANEL
3. QSENWK (QS Energi savr Node Wireless Keypad)
4. QSIOS (QS Input/Output Shading)
5. QSEDMX (QS Energi savr DMX)
6. ESN_DALI
7. ESN_ECO
8. ESN_0TO10_INT (0-10V International)
9. ESN_SWITCH_INT (Switch International)
10. ESN_0TO10_DOM (0-10V Domestic)
11. ESN_SOFT_SWITCH_DOM (Soft Switch Domestic)
12. QSM (Quantum System Manager)
13. IREYE (IR Eye - occupancy sensor)
14. ESNETH (ESN Ethernet)

Followed by lookup table at 0x13F70: `00 01 01 01 02 03 04 08`
(maps device type index to component count or capability bits)

## Telnet Prompt Modes
- `LNET:OSM>` — Operating System Mode
- `LNET:ADDR>` — Addressing Mode
- `LNET:DBM>` — Database Mode
- `LNET:UPM>` — User Programming Mode

## Network Services
- Telnet (configurable port)
- FTP (`ftp://anonymous@ip/proc%d/xml.dat` — config as XML)
- HTTP (configurable port)
- NetBIOS
- ICMP ping (enable/disable)
- UDP autodetect server
- Default IP: 192.168.250.1 (from hex at 0x38C74: `C0 A8 FA 01`)

## Key Insights for CCA Protocol
1. **"QS Link Task" = CCA radio layer** — the radio protocol is called "QS Link" internally
2. **Component = Zone/Output** — maps directly to CCA zone addressing
3. **PM = Programming Master = Pico** — button remotes, with type/scene/group assignment
4. **Object ID = Device Serial** — 4-byte address is the device's serial number
5. **Flat File transfer** — component and database configs sent as "flat files" (FF)
6. **Schema versioning** — database has schema revision for compatibility
7. **Copyright 2009** — CCA protocol dates to at least 2009 (pre-Caseta era)
8. **Config Properties** — 2-byte property IDs with configurable sizes (our trim/LED/fade config)
9. **DFC = Default Factory Config** — the DFCOUTOFBOX command resets to factory

## TODO
- Re-open in Binary Ninja as M68K/ColdFire for proper decompilation
- Decompile QS Link Task to find radio packet encoding
- Map component config properties (0xB09F etc.) to CCA format bytes
- Compare telnet command parameter structure with CCA packet fields
- Look for CRC-16 implementation in the radio code
