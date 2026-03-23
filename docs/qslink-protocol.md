# QS Link Protocol

QS Link is an RS-485 wired protocol used between real devices in Lutron's commercial systems (Homeworks QS, Grafik Eye QS, Quantum, etc.). CCA (Clear Connect Type A) reuses the same packet structure over 433 MHz RF instead of RS-485. The ESN-QS (Energi Savr Node) bridges both — it speaks QS Link on its wired RS-485 port and CCA over the air — which is why the packet encoding is identical. This document is based on reverse engineering the ESN-QS firmware, a ColdFire M68K binary from 2009.

## Architecture

```
Telnet command  →  Command Parser  →  Internal Message Queue  →  QS Link Task  →  Radio IC  →  OTA
                   (sub_2c31c etc.)    (sub_1ae30, "QS  ")      (sub_19ed0)       (CC1xxx?)     CCA
```

The QS Link Task (`sub_19ed0`) runs as an RTOS task named "QS  ". It receives messages from other tasks (telnet, button, autodetect, database) via a uC/OS-II message queue, dispatches them by type through a large switch statement (~40 message types), and calls format-specific packet builders that write to the radio IC via `sub_160f4`.

## Radio Hardware Architecture

The ESN-QS has a **dual-channel radio** architecture with DMA-based transfers.

### Memory-Mapped Radio IC Registers

| Address | Purpose |
|---------|---------|
| `0x0284` | Radio status register (read) |
| `0x0288` | Radio command register (write) |
| `0x028C` | Radio config/mode register (read/write) |
| `0x0294` | Radio control register (write) |

### Dual TX Channels

Two independent 512-byte circular ring buffers feed the radio IC:

| | Channel 1 (Primary) | Channel 2 (Secondary) |
|--|--|--|
| Buffer | `0x8004AB78` | `0x8004AD80` |
| Read ptr | `0x4AD78` | `0x4AF80` |
| Commit ptr | `0x4AD7A` | `0x4AF82` |
| Write ptr | `0x4AD7C` | `0x4AF84` |
| TX func (byte) | `sub_1df60` | `sub_1e2e0` |
| TX func (bulk) | `sub_1e01c` | `sub_1e39c` |
| TX func (commit) | `sub_1e1bc` | `sub_1e53c` |
| Used by | GoToLevel, config, addressing | Button events, broadcasts |

Both share SPI control register `data_c842`. The producer-consumer pattern: application writes to the ring buffer, the commit function triggers the radio IC to transmit.

### DMA Controller

A DMA engine at `0x401A0000` handles bulk radio data transfers:
- `0x401A0004` — DMA counter (read)
- `0x401A000C` — DMA control (bit 0 = enable)
- `0x401A000E` — DMA request trigger
- `0x401A0010` — DMA target count

### Interrupt Handlers

| Vector | Address | Handler | Purpose |
|--------|---------|---------|---------|
| 79 | `sub_197d0` | Radio status ISR | Dispatches TX-complete / RX-complete |
| 108 | `sub_19a50` | DMA ISR | Manages bulk data transfer completion |
| 109 | `sub_10758` | Timer/radio ISR | Radio timing control |
| 86-99 | `sub_20b08` | Ethernet ISR | FEC Ethernet driver |
| 117 | `sub_ed10` | System timer ISR | Writes to `0x40150000` |

### Radio Protocol State Machine

A 26-state state machine (function pointer table at `0x1DA3C`) manages the full radio protocol lifecycle:

| States | Purpose |
|--------|---------|
| 0 | Idle (NOP) |
| 1 | Channel selection / timing synchronization |
| 2 | Incoming command dispatch (validates format, routes to handler) |
| 3 | Packet reception management (counters, timeouts, retries) |
| 4-6 | Link maintenance / TX scheduling |
| 7-15 | Small packet format handlers (sub-state machine at `0x1DAA4`) |
| 16-25 | Large packet format handlers |

State 2 (`sub_1d26c`) uses a format lookup table at `0x1DAC4` to identify which CCA packet formats the ESN can receive.

## Radio TX Interface (sub_160f4)

The packet builder calls `sub_160f4(payload_ptr, format_byte)`. This function writes to the radio IC via Channel 1:

```
[total_len] [0x21] [format_byte] [payload_bytes...]
```

- `total_len` = format_byte + 3
- `0x21` = radio command byte (transmit)
- `format_byte` = number of payload bytes (and the CCA "format" we see OTA)
- `payload_bytes` = the application data

A second TX path (`sub_16f4c`) writes via Channel 2 with the same framing. Button events and broadcasts use Channel 2.

The radio IC then wraps this in CCA framing (N81 encoding, preamble, sync word, type byte, CRC-16).

**This means the CCA "format byte" in the packet header IS the payload length.** Format 0x0E = 14 payload bytes. This is why type 0x80-0x9F packets are 24 bytes (up to 19 payload bytes + header + CRC) and type 0xA0+ are 53 bytes.

## Packet Payload Structure

All payloads follow a common structure in the first 8 bytes:

```
Offset  Size  Field           Values
0       1     flags           0x00 (normal), other values TBD
1-4     4     object_id       Device serial number (32-bit, big-endian)
5       1     addr_mode       0xFE=component, 0xEF=group, 0xFF=broadcast
6       1     cmd_class       Command class (see below)
7       1     cmd_type        Command type (see below)
8+      var   cmd_data        Format-specific data
```

### Address Mode Byte (offset 5)

| Value | Mode | Description |
|-------|------|-------------|
| 0xFE  | Component | Target a specific component/zone on the device |
| 0xEF  | Group | Target all components in a group |
| 0xFF  | Broadcast | Target all devices (used in initialization) |

### Command Classes (offset 6)

| Value | Class | Used For |
|-------|-------|----------|
| 0x01  | Device Control | Identify, mode changes |
| 0x03  | Select/Query | Component selection, addressing queries |
| 0x05  | Button/PM | Button events and PM (pico) actions |
| 0x06  | Dim Control | Raise/lower/stop (QS-era, became 0x42 in modern CCA) |
| 0x08  | Assign/Bind | Address assignment, component binding |
| 0x09  | Scene | Scene activation and control |
| 0x40  | Level Control | GoToLevel (set to specific level) |

### Command Types (offset 7)

| Value | Type | Context |
|-------|------|---------|
| 0x01  | Scene activate | With cmd_class 0x09 |
| 0x02  | Set/Execute | Level set, addressing, etc. |
| 0x05  | Button event | With cmd_class 0x05 (PM/pico) |
| 0x0E  | FW bind | Firmware update addressing (cmd_class 0x08) |
| 0x22  | Identify | Flash LEDs / self-identify |
| 0x33  | Config | Device configuration (cmd_class 0x01) |
| 0x50  | Raise start | Dim raise (cmd_class 0x06) |
| 0x63  | Lower | Dim lower (cmd_class 0x06) |
| 0x67  | Stop | Dim stop (cmd_class 0x06) |
| 0xA3  | Address assign | Component address programming |
| 0xA5  | Address query | Component address read |

## Format-Specific Payload Layouts

### Format 0x0E: GoToLevel (14 bytes)

Used by: `DEVICECOMPONENTGOTOLEVEL`, `DEVICEGROUPGOTOLEVEL`

```
Offset  Size  Field           Component             Group
0       1     flags           0x00                  0x00
1-4     4     object_id       device serial         device serial
5       1     addr_mode       0xFE                  0xEF
6       1     cmd_class       0x40                  0x40
7       1     cmd_type        0x02                  0x02
8-9     2     component       component number      0x0000
10-11   2     level           0x0000-0xFEFF         0x0000-0xFEFF
12-13   2     reserved        0x0000                0x0000
```

Level encoding: `level = percent * 0xFEFF / 100`
Example: 50% = 0x7F7F (confirmed by firmware error string)

### Format 0x09: Device Control (9 bytes)

Used by: `DEVICECOMPONENTIDENTIFY` (msg 0x30), select/addressing

```
Offset  Size  Field           Identify              Select
0       1     flags           0x00                  0x00
1-4     4     object_id       device serial         device serial
5       1     addr_mode       0xFE                  0xFE
6       1     cmd_class       0x01                  0x03
7       1     cmd_type        0x22                  0x02
8       1     parameter       mode                  0x0D
```

### Format 0x0A: Address Assign (10 bytes)

Used by: addressing/initialization sequence

```
Offset  Size  Field
0       1     flags           0x00
1-4     4     object_id       device serial
5       1     addr_mode       0xFE
6       1     cmd_class       0x08
7       1     cmd_type        0xA3
8-9     2     component       component number to assign
```

### Format 0x0D: Extended Addressing (13 bytes)

Used by: addressing with secondary object ID

```
Offset  Size  Field
0       1     flags           0x00
1-4     4     object_id       device serial
5       1     addr_mode       0xFE
6       1     cmd_class       0x08
7       1     cmd_type        0xA5
8-11    4     target_id       secondary object ID
12      1     addr_type       addressing type byte
```

### Format 0x0E: Scene Activation (variable, 12+ bytes)

Used by: `DEVICEAREAGOTOSCENE` (msg 0x23)

```
Offset  Size  Field
0       1     flags           0x00
1-4     4     object_id       device serial
5       1     arg4            (area/scene controller ref)
6       1     cmd_class       0x09 (scene)
7       1     cmd_type        0x01 (activate)
8-9     2     scene_ctrl      scene controller component
10      1     scene_num       scene number (1-byte)
11      1     data_len        additional data length
12+     var   scene_data      scene-specific data
```

## QS Link Task Message Types

The QS Link Task dispatches on `msg[8]` (message type byte in the internal queue message):

| Type | Handler | Purpose |
|------|---------|---------|
| 0x02 | timer   | Periodic link maintenance, sends msg 0x31 |
| 0x03 | sub_171b4 | Broadcast initialization (format varies by sub-type) |
| 0x04 | sub_18acc | Device configuration |
| 0x05 | sub_18b3c | Device configuration (extended) |
| 0x06 | sub_171b4 | Broadcast reset (format 0x1C, addr 0xFFFFFF) |
| 0x07 | sub_16c34 | Device naming |
| 0x08 | sub_16bb0 | Component naming |
| 0x09 | sub_16dc8/16e60 | Monitoring enable/disable |
| 0x0a | sub_16ca4 | **Addressing sequence** (multi-packet: format 0x0D + 0x09) |
| 0x0b | sub_16b24 | **Component GoToLevel** (format 0x0E) |
| 0x0c | sub_16aa4 | **Group GoToLevel** (format 0x0E) |
| 0x0d | sub_169a8 | PM (programming master) mode |
| 0x0e | sub_16918 | PM exit mode |
| 0x0f | sub_16888 | **Component self-identify** (format 0x09 + 0x0A) |
| 0x10 | sub_16664/1656c/16444 | Component control (raise/lower/stop) |
| 0x11 | sub_16714/1656c/16444 | Group control (raise/lower/stop) |
| 0x12 | sub_16a40 | Component unaddress |
| 0x13 | sub_162bc/161ec/1746c | Database/flat file transfer |
| 0x14 | sub_11438+13fdc | Full system initialization |
| 0x16 | sub_17b48 | Button event processing |
| 0x17 | sub_17c38 | Button config |
| 0x18 | sub_17d28 | Button mode |
| 0x19 | sub_1c104 | Daylighting control |
| 0x1a | sub_17fd4 | Sensor data |
| 0x1b | sub_18070 | Sensor config |
| 0x1c | sub_180f8 | Schema query |
| 0x1d | sub_18154 | Flat file transfer |
| 0x1e | sub_18554 | Component level set (alternative path) |
| 0x1f | sub_185cc/149f8 | Component initialize |
| 0x20 | sub_18778 | Database extraction |
| 0x21 | sub_18210 | Device mode query |
| 0x22 | sub_1840c | Device mode set |
| 0x23 | sub_188e8 | **Area GoToScene** (variable format) |
| 0x25 | sub_18838 | Area GoToScene (group variant) |
| 0x29 | sub_1791c | Config property transfer |
| 0x30 | sub_16600 | Device identify (format 0x09) |
| 0x35 | sub_167e4 | Firmware update control |
| 0x37 | sub_1193c+118f8 | System status query |
| 0x41 | sub_18554 | Special level set (0x603C, 0x42007) |
| 0x42 | sub_179e0 | Broadcast query (0xFFFFFF, 5) |
| 0x45 | sub_182dc | Database sync |
| 0x46 | sub_18338 | Image transfer control |
| 0x47 | sub_18394 | Config property set |
| 0x4a | sub_18bb0 | Extended device config |
| 0x4b-0x54 | various | Additional config/transfer handlers |

## Telnet Integration Protocol

The ESN-QS runs a telnet server with four modes:

| Prompt | Mode | Purpose |
|--------|------|---------|
| `LNET:OSM>` | Operating System Mode | System info, network config |
| `LNET:ADDR>` | Addressing Mode | Device addressing/initialization |
| `LNET:DBM>` | Database Mode | Database queries, flat file transfer |
| `LNET:UPM>` | User Programming Mode | Scene/level/PM programming |

Commands are uppercase ASCII strings with hex parameters:
```
DEVICECOMPONENTGOTOLEVEL,0xAABBCCDD,0x0082,0x7F7F
                         ^object_id ^comp  ^level(50%)
```

Responses use the same format:
```
DEVICEADDRESSINGSTATUS,0xAABBCCDD,0x0082,0x01
QSREPORTCOMPONENTCONFIGPROPERTY,0xAABBCCDD,0x0082,0xB09F,0x01,...
```

### Configuration Parameters (LUTRON namespace)

Accessed via `LUTRON,<param>,<value>` / `/LUTRON`:

| Parameter | Size | Description |
|-----------|------|-------------|
| MACADDR | 6 bytes | Ethernet MAC address |
| CMDREV | 2 bytes | Command revision |
| PRODFAM | 2 bytes | Product family |
| PRODTYPE | 2 bytes | Product type |
| DEVTYPE | 2 bytes | Device type |
| NAME | 28 bytes | Device name |
| UNINAME | 28 bytes | Unicode device name |
| IPADDR | 4 bytes | IP address (default 192.168.250.1) |
| SUBNETMK | 4 bytes | Subnet mask |
| GATEADDR | 4 bytes | Gateway address |
| DHCP | 1 byte | DHCP enable |
| TELPORT | 2 bytes | Telnet port |
| CODEVER | 2 bytes | Code version |
| SERNUM | 4 bytes | Serial number |
| RSTPASS | var | Reset password |

## Device Type Enumeration

From the firmware's device type table (0x13E80):

| Index | Name | Description |
|-------|------|-------------|
| 0 | GRAFIKEYE | Grafik Eye QS |
| 1 | SHADE | QS shade controller |
| 2 | POWERPANEL | Power panel |
| 3 | QSENWK | QS Energi Savr Node wireless keypad |
| 4 | QSIOS | QS input/output shading |
| 5 | QSEDMX | QS Energi Savr DMX |
| 6 | ESN_DALI | ESN with DALI output |
| 7 | ESN_ECO | ESN eco-system |
| 8 | ESN_0TO10_INT | ESN 0-10V (international) |
| 9 | ESN_SWITCH_INT | ESN switch (international) |
| 10 | ESN_0TO10_DOM | ESN 0-10V (domestic) |
| 11 | ESN_SOFT_SWITCH_DOM | ESN soft switch (domestic) |
| 12 | QSM | Quantum System Manager |
| 13 | IREYE | IR Eye (occupancy sensor) |
| 14 | ESNETH | ESN Ethernet |

## Network Services

- **Telnet**: Configurable port, main command interface
- **FTP**: Anonymous access to `ftp://anonymous@<ip>/proc<n>/xml.dat` for config XML
- **HTTP**: Configurable port
- **NetBIOS**: Device discovery
- **ICMP Ping**: Enable/disable via config
- **UDP Autodetect**: Broadcast discovery service

## Mapping to Modern CCA

| QS Link Concept | Modern CCA Equivalent |
|-----------------|----------------------|
| Object ID (4 bytes) | Device ID / Serial Number |
| Component (2 bytes) | Zone ID |
| Group | Group addressing (addr_mode 0xEF) |
| Area + Scene | Scene activation |
| PM (Programming Master) | Pico remote / keypad |
| Flat File (FF) | Config data transfer |
| Schema | Database version |
| cmd_class 0x40 | Our "command class" field in format 0x0E |
| cmd_type 0x02 | Set-level command |
| Format byte = payload length | CCA packet format field |

## Firmware Update Protocol

Reverse engineered from the Energi Savr macOS app (arm64). The app communicates with ESN-QS devices over telnet to perform two types of firmware updates:

### 1. ESN OS Firmware Update (S-Record Path)

Updates the main ColdFire firmware on the ESN processor itself. Uses Motorola S-record format.

**Sequence:**

```
App                         ESN-QS (telnet)
 │                             │
 │  BEGINFIRMWAREUPDATE,...    │  ← record_count, os_version, device_class,
 │ ─────────────────────────► │    num_devices, serial_numbers, mode
 │                             │
 │  BEGINFIRMWAREUPDATEACK,... │  ← returns serial numbers of devices entering boot
 │ ◄───────────────────────── │
 │                             │
 │  SENDFIRMWARESRECORD,...    │  ← seq_num, data_length, s_record_data
 │ ─────────────────────────► │
 │  SRECORDACK,seq             │  ← ACK with next requested seq number
 │ ◄───────────────────────── │
 │  ... (repeat for all records) ...
 │                             │
 │  FIRMWAREUPGRADECOMPLETE,...│  ← serial_number, new_version
 │ ◄───────────────────────── │
```

**Command formats (from marshalPayload):**

```
BEGINFIRMWAREUPDATE,0x<record_count>,0x<os_version>,0x<device_class>,0x<mode>,<serial_list>
  record_count:  number of S-records to send
  os_version:    target version as "major.minor" → 2-byte hex each, concatenated
  device_class:  category code (0x01000000=ballast → subCategory, 0x060E0000/0x09000000 → category)
  mode:          0x00=normal, 0xDD/0xEE/0xFF=special modes
  serial_list:   comma-separated "0xAABBCCDD,0xEEFFGGHH,..." device serial numbers

SENDFIRMWARESRECORD,0x<seq_num>,0x<data_length>,<s_record_data>
  seq_num:       0-based record index
  data_length:   length of s_record_data string
  s_record_data: raw S-record line (e.g., "S1130800...")
```

**Response formats (from firmware strings):**

```
BEGINFIRMWAREUPDATEACK,0x<error_code>,0x<serial_number>
SRECORDACK,0x<next_seq>
SRECORDNACK,0x<failed_seq>
FIRMWAREUPGRADECOMPLETE,0x<serial_number>,0x<major><minor>
FIRMWAREUPDATEERROR,0x<error_code>
DEVICEREPROGRAMTIMEOUT,0x<serial_number>
ESNPROCESSINGOSUPGRADE
```

**Timeouts:** 20s for BEGINFIRMWAREUPDATE ACK, 25s per S-record ACK, 60s for upgrade complete.

**FirmwareManager state machine:**
1. `loadFirmwareRecords` — reads S-record file via `ESNFileManager`
2. `sendCommandBeginFirmwareUgrade` — sends BEGINFIRMWAREUPDATE, sets state 0x50, starts 20s timer
3. `handleCRBeginFirmwareUpgrade:` — validates serial numbers, stops timer, calls `sendRequestedFirmwareRecordAtIndex:0`
4. `handleCRRecordAck:` — gets next seq from ACK, calls `sendRequestedFirmwareRecordAtIndex:`
5. On last record ACK: sets `isFirmwareTransferred`, waits 60s for FIRMWAREUPGRADECOMPLETE
6. `handleCRFirwareUpgradeComplete:` — updates device firmware version, checks if all devices done

### 2. Ballast/Component Firmware Update (Image Transfer Path)

Updates sub-devices (ballasts, DALI drivers) connected to the ESN's output loops. Uses Intel HEX format parsed by `BallastFirmwareFile`.

**BallastFirmwareFile** parses Intel HEX records:
- Allocates 64KB (`0x10000` bytes) initialized to 0xFF
- Processes each line: record type 0x00 = data, type 0x04 = extended address
- Concatenates upper address bytes with record address for full 32-bit addressing
- Tracks startAddress, endAddress, pageSize, pageWait, blockWait from XML metadata
- Computes whole-file checksum

**Component update state machine (per-device):**

```
App                         ESN-QS                     Ballast
 │                             │                         │
 │  DEVICEENTEREXITMODE,...    │                         │
 │ ─────────────────────────► │  (put ballast in FW     │
 │                             │   upgrade mode via QS)  │
 │  (2s delay)                 │                         │
 │                             │                         │
 │  BEGINCOMPONENTFIRMWAREFILETRANSFERPROCESS,...         │
 │ ─────────────────────────► │  ← serial, file_id,     │
 │                             │    start_addr, end_addr,│
 │  REPORTBEGINCOMPONENTFIRMWAREFILETRANSFERPROCESSACK    │    checksum
 │ ◄───────────────────────── │                         │
 │                             │                         │
 │  IMAGESENDTRANSFERRECORD,...│  ← page data (256B)     │
 │ ─────────────────────────► │ ─────────────────────► │
 │  IMAGESENDACKRECEIVEDRECORD │                         │
 │ ◄───────────────────────── │                         │
 │  ... (repeat for all pages) ...
 │                             │                         │
 │  IMAGESENDCOMPLETE,...      │                         │
 │ ◄───────────────────────── │                         │
 │                             │                         │
 │  REPORTENTEROREXITCOMPONENTFIRMWAREUPGRADESTATEACK     │
 │ ◄───────────────────────── │  (ballast reboots)      │
```

**Command formats:**

```
BEGINCOMPONENTFIRMWAREFILETRANSFERPROCESS,0x<serial>,0x<file_id>,0x<start_addr>,0x<end_addr>,0x<checksum>

IMAGEEXTRACTREQUEST,0x<serial>,0x<image_type>

IMAGEEXTRACTACKRECEIVEDRECORD,0x<serial>,0x<image_type>,0x<schema_rev>,0x<last_record>
```

**Response formats (from firmware):**

```
IMAGEEXTRACTRETURNRECORD,0x<serial>,0x<image_type>,0x<schema_rev>,0x<total_size>,0x<record_addr>,0x<record_num>,<data>
IMAGEEXTRACTCOMPLETE,0x<serial>,0x<image_type>,0x<schema_rev>,0x<total_size>,0x<total_records>,0x<result>
IMAGESENDCOMPLETE,0x<serial>,0x<image_type>,0x<schema_rev>,0x<total_size>,0x<total_records>,0x<result>
IMAGESENDACKRECEIVEDRECORD,0x<serial>,0x<image_type>,0x<schema_rev>,0x<record_num>
REPORTBEGINCOMPONENTFIRMWAREFILETRANSFERPROCESSACK
REPORTENTEROREXITCOMPONENTFIRMWAREUPGRADESTATEACK
```

**Concurrency:** Up to 2 devices can be flashed simultaneously (`countForDevicesBusyWithTransferringFirmware < 2`). Additional devices are queued.

**Loop structure:** Ballasts are organized by ESN output loop (loop 1 = component 0x81, loop 2 = component 0x82). If both loops have the same ballast firmware file, they're combined. Otherwise they're flashed as separate `BallastUpdateCommand` instances.

### Transport Layer

All commands are sent over **telnet** (TCP). The `CommunicationEntity.sendCommandToDFCDevice:` method:
1. Calls `marshalPayload` on the command object → returns NSData containing the ASCII command string
2. Calls `prepareNetWorkMessage:NetworkMessage:` which appends the payload + `\r\n` terminator
3. Sends via `telnetManager.sendMessageOnTelnetConnection:` (fire-and-forget) or `sendMessageOnTelnetConnectionAndInvokeAckWaiter:` (waits for response notification)

Response parsing: The telnet manager fires `NSNotification` events (e.g., "SRECORDACK", "BEGINFIRMWAREUPDATEACK") which the `FirmwareManager` observes. Response classes (e.g., `CRImageExtractReturnRecord`) split the response string on `,` and parse each field via `ConversionManager.convertHexStringToInt:`.

### Ballast Firmware Package Structure

The `Ballast Firmware for Demo.buf` file is a ZIP archive containing:
- `FlexBallastModelsXMLData.xml` — ballast model metadata (pageSize, pageWait, blockWait, address ranges)
- Multiple `.hex` files — Intel HEX firmware for different ballast types (EC5, H-Series, BMF, BMJ/XPJ, EC3)
- Device family 0x13, typical address range 0x0800-0x7FFF, page size 256 bytes

## Source

- **Binary**: `Energi Savr.app/FirmWare file for Demo.s19`
- **Architecture**: Motorola 68K / ColdFire (M68000 family)
- **Product**: QSNE-2DAL-D (Energi Savr Node QS)
- **Copyright**: 2009 Lutron Electronics Co., Inc.
- **RTOS**: uC/OS-II style (OSQPost, message queues, task priorities)
