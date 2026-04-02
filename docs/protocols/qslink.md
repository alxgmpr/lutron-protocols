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

---

## Appendix: CCA Field Mapping

This appendix maps the "magic bytes" in our CCA firmware code to their proper QS Link field names.
These field names have been unchanged since at least 2009.

### Proper Names for CCA Packet Bytes

These bytes appear across multiple CCA packet formats. Our firmware (`cca_commands.cpp`,
`cca_pairing.cpp`) previously used unnamed hex literals for all of them.

| CCA Byte | Value | Proper Name | QS Link Origin | Our Code Reference |
|----------|-------|-------------|----------------|-------------------|
| 6 | `0x21` | `proto_radio_tx` | Radio IC TX command register (addr 0x0288) | `cca_commands.cpp:228`, `cca_pairing.cpp:383` |
| 7 | varies | `format` | Payload length in bytes (format 0x0E = 14 bytes) | `cca_commands.cpp:229` |
| 8 | `0x00`/`0x03` | `flags` | 0x00=normal, 0x03=pico frame | `cca_commands.cpp:230,147` |
| 9-12 | device ID | `object_id` | Device serial number (32-bit big-endian) | `cca_commands.cpp:233-236` |
| 13 (fmt 0x0E) | `0xFE` | `addr_mode` | Component unicast addressing | `cca_commands.cpp:238` |
| 13 (fmt 0x0E) | `0xEF` | `addr_mode` | Group multicast addressing | (format 0x28 byte 25) |
| 13 (fmt 0x0E) | `0xFF` | `addr_mode` | Broadcast to all devices | beacon packets byte 9-13 |
| 14 (fmt 0x0E) | `0x40` | `cmd_class` | Level control (GoToLevel) | `cca_commands.cpp:239` |
| 14 (fmt 0x0E) | `0x42` | `cmd_class` | Dim control (raise/lower) | `cca_commands.cpp:160` |
| 14 (config) | `0x06` | `cmd_class_legacy` | Original 2009 dim/config class | `cca_pairing.cpp:428,460` |
| 15 (fmt 0x0E) | `0x02` | `cmd_type` | Set/Execute command | `cca_commands.cpp:240` |
| 15 (config) | `0x50` | `component_type` | Dimmer component | `cca_pairing.cpp:429,498` |
| 15 (scene cfg) | `0x40` | `component_type_scene` | Scene component | scene config packets |
| 15 (fmt 0x12) | `0x6E` | `entity_type` | Zone binding entity selector; likely a stable table/entity descriptor, not a command subtype | `cca_pairing.cpp:567` |

### Pico Packet Fields (Format 0x0E, Byte Offsets Shifted)

Pico packets embed a second device ID and shift the command fields deeper:

| CCA Byte | Value | Proper Name | Notes |
|----------|-------|-------------|-------|
| 8 | `0x03` | `pico_frame` | Identifies this as a pico/button device frame |
| 12-15 | device ID | `object_id` (repeated) | Second copy of pico's device ID |
| 17 | `0x40`/`0x42` | `cmd_class` (embedded) | 0x40=scene/level, 0x42=dim control |
| 18 | `0x00`/`0x02` | `cmd_type` (embedded) | 0x00=hold, 0x02=step/execute |
| 19 | varies | `cmd_param` | Preset ID (0x20=top) or dim direction (0x01=raise, 0x00=lower) |

### Format 0x28 (Zone Assignment) Fields

Format 0x28 is special: format byte moves to position 6 (no protocol byte) because
the 40-byte payload needs the space.

| CCA Byte | Value | Proper Name | Notes |
|----------|-------|-------------|-------|
| 6 | `0x28` | `format` | At position 6, NOT 7 (exception) |
| 9 | `0x50`/`0x38` | `component_type` | 0x50=dimmer, 0x38=relay |
| 10 | `zone+0x23` | `zone_reference` | Zone ID with offset (non-critical) |
| 18 | `0xFE` | `addr_mode` | Component addressing |
| 19 | `0x06` | `cmd_class_legacy` | Original QS Link dim/config class |
| 20 | `0x40` | `cmd_class` | Level control |
| 25 | `0xEF` | `addr_mode_group` | Group addressing mode |

### Format 0x12 (Final Config) Fields

| CCA Byte | Value | Proper Name | Notes |
|----------|-------|-------------|-------|
| 14 | `0x06` | `cmd_class_legacy` | Original config class |
| 15 | `0x6E` | `entity_type` | Likely "zone binding" table/entity selector |
| 24 | zone | `zone_id` | **THE** authoritative zone assignment byte |
| 25 | `0xEF` | `addr_mode_group` | Group addressing |

### Format 0x13 (Dimming Capability) Fields

| CCA Byte | Value | Proper Name | Notes |
|----------|-------|-------------|-------|
| 14 | `0x06` | `cmd_class_legacy` | Original config class (NOT modern 0x42) |
| 15 | `0x50` | `component_type` | Dimmer |
| 17 | `0x0D` | profile_0 | Conserved capability/profile tuple byte |
| 18 | `0x08` | profile_1 | Conserved capability/profile tuple byte |
| 19 | `0x02` | profile_2 | Conserved capability/profile tuple byte |
| 20 | `0x0F` | profile_3 | Conserved capability/profile tuple byte |
| 21 | `0x03` | profile_4 | Conserved capability/profile tuple byte |

### Format 0x14 (Function Mapping) Fields

| CCA Byte | Value | Proper Name | Notes |
|----------|-------|-------------|-------|
| 14 | `0x06` | `cmd_class_legacy` | Original config class |
| 15 | `0x50` | `component_type` | Dimmer |
| 19 | `0xFE` | `addr_mode`? | Or could be level high byte |
| 20 | `0xFF` | unknown | Possibly max level |
| 22 | `0x02` | `dimmer_capability` | Dimmer=0x02, relay=0x00 |

### Addressing Mode Values

| Value | Constant Name | Description | Where Used |
|-------|---------------|-------------|------------|
| `0xFE` | `ADDR_MODE_COMPONENT` | Unicast to a specific component/zone | Byte 13 in SET_LEVEL, byte 18 in fmt 0x28 |
| `0xEF` | `ADDR_MODE_GROUP` | Multicast to all components in a group | Byte 25 in fmt 0x28, byte 25 in fmt 0x12 |
| `0xFF` | `ADDR_MODE_BROADCAST` | Broadcast to all devices on the link | Beacon packets (bytes 9-13 = 0xFF) |

### Command Class Evolution (2009 → 2024)

The command class byte tells the device what kind of operation to perform.

| QS Link (2009) | Value | Modern CCA | Value | Status |
|----------------|-------|------------|-------|--------|
| Level control | `0x40` | Level control | `0x40` | **UNCHANGED** since 2009 |
| Dim control | `0x06` | Dim control | `0x42` | Runtime changed, but 0x06 persists in config/pairing packets |
| Button/PM | `0x05` | (embedded in pico structure) | — | Folded into pico frame type |
| Scene | `0x09` | (implicit in format) | — | May appear in fmt 0x28 byte 29 |
| Addressing | `0x08` | (implicit in packet type) | — | Folded into type byte 0xA0+ |
| Device control | `0x01` | (identify, mode) | — | Used in format 0x09 |
| Select/Query | `0x03` | (addressing) | — | Used in format 0x09 |

Key insight: **0x06 in config/pairing packets is NOT a mystery byte** — it's the original
2009 dim control command class, kept for backwards compatibility in the config path even though
runtime control moved to 0x42.

### Command Type Values

| Value | Constant Name | Meaning | Where Used |
|-------|---------------|---------|------------|
| `0x02` | `CMD_TYPE_EXECUTE` | Set/Execute (go to level) | Byte 15 in SET_LEVEL, byte 18 in pico |
| `0x00` | `CMD_TYPE_HOLD` | Hold/Start | Pico byte 18 for hold-start |
| `0x22` | `CMD_TYPE_IDENTIFY` | Flash LEDs / self-identify | Format 0x09 |
| `0x33` | `CMD_TYPE_CONFIG` | Device configuration | Config packets |
| `0x50` | `CMD_TYPE_RAISE_START` | Dim raise (legacy) | QS Link dim control |
| `0x63` | `CMD_TYPE_LOWER` | Dim lower (legacy) | QS Link dim control |
| `0x67` | `CMD_TYPE_STOP` | Dim stop (legacy) | QS Link dim control |
| `0xA3` | `CMD_TYPE_ADDR_ASSIGN` | Address programming | Format 0x0A |
| `0xA5` | `CMD_TYPE_ADDR_QUERY` | Address read | Format 0x0D |

### Format Byte = Payload Length (Confirmed)

The format byte at CCA byte 7 (or byte 6 for format 0x28) literally equals the number of
payload bytes following the header. This is confirmed by the QS Link radio TX path which
writes `[total_len][0x21][format_byte][payload]` where payload is exactly `format_byte` bytes.

| Format | Payload Size | Used For |
|--------|-------------|----------|
| `0x04` | 4 bytes | Button tap (press/release) |
| `0x09` | 9 bytes | Device control (identify, select) |
| `0x0A` | 10 bytes | Address assign |
| `0x0C` | 12 bytes | Beacon / dim stop |
| `0x0D` | 13 bytes | Extended addressing with secondary ID |
| `0x0E` | 14 bytes | GoToLevel, button extended |
| `0x12` | 18 bytes | Final config with zone |
| `0x13` | 19 bytes | Dimming capability config |
| `0x14` | 20 bytes | Function mapping |
| `0x15` | 21 bytes | Trim / phase config |
| `0x1A` | 26 bytes | Scene config |
| `0x1C` | 28 bytes | Fade config / broadcast reset |
| `0x28` | 40 bytes | Zone assignment (format at byte 6, no protocol byte) |

The format 0x28 exception: 40 bytes of payload is so large that the `proto_radio_tx` byte
(0x21) is omitted and the format byte moves from position 7 to position 6 to reclaim 1 byte.

### Component Type Values

| Value | Constant Name | Description | Where Used |
|-------|---------------|-------------|------------|
| `0x50` | `COMPONENT_TYPE_DIMMER` | Dimmer component/zone | Fmt 0x28:9, fmt 0x13:15, fmt 0x14:15 |
| `0x38` | `COMPONENT_TYPE_RELAY` | Relay/switch component | Fmt 0x28:9 for relay pairing |
| `0x40` | `COMPONENT_TYPE_SCENE` | Scene component | Scene config byte 15 |

### Hypotheses to Investigate

Based on QS Link protocol knowledge applied to CCA:

#### 1. Broadcast Addressing (ADDR_MODE_BROADCAST = 0xFF)

**Status**: TESTED 2026-02-16 — no response. Devices ignored broadcast SET_LEVEL.

**Hypothesis**: Setting byte 13 to `0xFF` (broadcast) in a SET_LEVEL packet should
command ALL devices on the network, without knowing their device IDs.

**Evidence**: QS Link explicitly defines 0xFF as broadcast mode. Our beacon packets
already use 0xFF at bytes 9-13 (the target ID position) and devices respond.

**Test**: Sent format 0x0E SET_LEVEL with `object_id = 0xFFFFFFFF`,
`addr_mode = 0xFF`, source = Caseta bridge zone ID. No device responded.

**Conclusion**: CCA devices do NOT honor broadcast addressing for level control.
The Caseta "all lights off" feature confirms this — it sends individual unicast
commands to each device rather than a single broadcast. Broadcast may only work
for discovery/beacon purposes, not runtime control.

#### 2. Group Addressing for Control (ADDR_MODE_GROUP = 0xEF)

**Hypothesis**: We can control multiple devices simultaneously using group addressing
(byte 13 = `0xEF`) if they share a group assignment from pairing.

**Evidence**: QS Link defines group GoToLevel as the same format 0x0E but with
`addr_mode = 0xEF` and component = `0x0000`. Format 0x28 zone assignment includes
`addr_mode_group = 0xEF` at byte 25, suggesting devices are assigned to groups during pairing.

**Test**: Send SET_LEVEL with `addr_mode = 0xEF` and see if paired devices respond.

#### 3. New Command Classes We Haven't Tried

**Hypothesis**: Sending known QS Link command classes that differ from our usual 0x40/0x42
may trigger additional device behaviors.

| Class | QS Link Meaning | Worth Trying? |
|-------|-----------------|---------------|
| `0x01` | Device control (identify, mode) | **YES** — could trigger LED flash without pairing |
| `0x03` | Select/Query | **YES** — could query device state or component info |
| `0x05` | Button/PM events | Maybe — pico already handles this differently |
| `0x08` | Address assign | **YES** — could reassign devices to new zones |
| `0x09` | Scene activation | **YES** — could trigger stored scenes |

**Test**: Build format 0x09 (9-byte) packets with various command classes directed at
a known device ID.

#### 4. Device Discovery via Format 0x0A (Address Assign)

**Status**: TESTED 2026-02-16 — no response from Vive dimmer. Back-pocketed.

**Hypothesis**: Format 0x0A with `cmd_type = 0xA5` (address query) can discover
devices on the network by requesting their address/component information.

**Evidence**: QS Link has `DEVICEREQUESTCOMPONENTPRESENT` (cmd 0x1F) and
`DEVICECOMPONENTINITIALIZE` (cmd 0x0F, with type 0x00=NEW/UNADDRESSED) which scan
for devices. The radio packet format for this is format 0x0A + format 0x09.

**Test**: Sent format 0x09 with `cmd_class = 0x03` (select), `cmd_type = 0x02`
(execute) to known device ID. Packets transmitted but no response observed.

**Likely issue**: Used target device ID as source ID — device may require command
from a paired hub/bridge ID. Also, packet structure may need adjustment for
modern CCA (e.g. different format, additional fields).

#### 5. Factory Reset via Format 0x1C Broadcast

**Hypothesis**: QS Link message type 0x06 is "broadcast reset" which sends format 0x1C
to address `0xFFFFFF` with parameter 5. This may factory-reset devices over CCA.

**Evidence**: The ESN firmware explicitly handles this as a separate message type from
normal format 0x1C (fade config). The address 0xFFFFFF + specific parameter = DFC
(Default Factory Config).

**Test**: **DO NOT TEST CASUALLY** — this could unpair all devices. Only test with a
sacrificial device isolated from the production system.

#### 6. Component Self-Identify (Format 0x09 + 0x0A)

**Status**: TESTED 2026-02-16 — no response from Vive dimmer. Back-pocketed.

**Hypothesis**: Sending format 0x09 with `cmd_class = 0x01` (device control) and
`cmd_type = 0x22` (identify) to a device ID should make it flash its LED without
requiring any pairing.

**Evidence**: QS Link handler 0x30 (`DEVICEIDENTIFY`) builds exactly this packet.
Identify is a fundamental device function that should work regardless of pairing state.

**Test**: Sent format 0x09 with the known field values targeting Vive dimmer 09626657.
Packets transmitted (confirmed via TX echo) but no LED flash or response observed.

**Likely issue**: Used target device ID as source ID (bytes 2-5). Device may only
accept identify from a recognized hub/bridge source. TX echo showed `src=57666209`
(wrong endian in decoder display) and device ID correctly at bytes 9-12. May also
need to be sent from a paired integration ID rather than the device's own ID.

#### 7. The 0x06 → 0x42 Migration Pattern

**Hypothesis**: Config/pairing packets use `cmd_class = 0x06` (legacy) because the
configuration path was never updated from the 2009 QS Link protocol, while the
runtime control path was updated to use `cmd_class = 0x42` for dim control.

**Evidence**: In our code, every config format (0x13, 0x14, 0x28, 0x12) uses 0x06
at the cmd_class position, while runtime dim packets use 0x42. This is NOT a different
protocol — it's the same field with legacy vs modern values.

**Implication**: This means we could potentially use modern command class values in
config packets too, OR use legacy values in runtime packets. Neither is tested.

### Unchanged Since 2009

These protocol elements are confirmed identical between QS Link (2009) and CCA (2024+):

- **Level encoding**: `percent * 0xFEFF / 100`
- **CRC-16 polynomial**: 0xCA0F
- **Sequence increment**: +6 per packet, wraps at 0x48
- **Padding**: 0x00 for extended packets
- **Protocol byte**: 0x21
- **Command class 0x40** = level control
- **Addressing modes**: 0xFE/0xEF/0xFF
- **Format byte** = payload length
- **Component types**: 0x50=dimmer, 0x38=relay

### CCA Field Mapping Source

Field names and protocol structure derived from:
- ESN-QS firmware (`Energi Savr.app/FirmWare file for Demo.s19`) — ColdFire M68K, 2009
- Energi Savr macOS app (`Energi Savr.app`) — arm64, CommunicationFramework class model
- Cross-referencing with modern CCA captures from CC1101 and RTL-SDR
