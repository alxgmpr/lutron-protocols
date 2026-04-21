# IPL Protocol: RA3 Designer Integration Port (TLS:8902 or WSS)

The RA3 processor exposes a binary protocol used by Lutron Designer for project
transfer, device configuration, and real-time state sync. Historically carried on
raw TLS:8902; newer processors may advertise a WSS endpoint alongside (same payload,
WebSocket transport). Lutron docs sometimes call this **LIP** ("Lutron Integration
Protocol"); Designer's own code uses **IPL** everywhere — they are the same thing.

**Original capture**: 2026-03-06 (RA3 HWQS, firmware v03.247).
**Revised from RE**: 2026-04-19 — reversed framing, operation enums, and transport
discovery from Designer 26.0.2.100 DLLs (see §2–§6).

---

## 1. Connection & TLS

The IPL server uses mutual TLS with a certificate chain separate from the LEAP API (port 8081).

### Server Certificate Chain

```
radioRa3-products (root, self-signed by lutron-root)
  └── radioRa3-devices
        └── radioRa3-processors-027-4725-24
              └── radiora3-a0b1c2d3e4f5-server (leaf, ECDSA P-256)
```

### Client Certificate Requirements

The processor requests client certs signed by:
```
CN=Lutron Project SubSystem Certificate Authority
O=Lutron Electronics Co., Inc.
ST=PA, C=US
```

This is a **project-level CA** — each Designer project generates its own SubSystem CA.
The CA cert + private key are stored in `cert_v2.pfx` on the Designer workstation.

### Certificate Extraction

Certs were extracted from the Lutron Designer Windows Store app:
```
C:\Program Files\WindowsApps\LutronElectronics.LutronDesignerGamma_26.0.2.100_x86__...\
  QuantumResi\BinDirectory\CertificateStore\
```

**Files found in Designer's CertificateStore:**

| File | Purpose |
|------|---------|
| `residential_local_access.pfx` | Generic residential GUI cert (signed by Designer CA, NOT accepted by processor) |
| `commercial_local_access.pfx` | Generic commercial GUI cert |
| `one_gui_local_access.pfx` | OneGUI interface cert |
| `radioRa3_products.crt` | RA3 product root CA (for server verification) |
| `homeworksqs_products.crt` | HWQS product root CA |
| `athena_products.crt` | Athena product CA |
| `myroom_products.crt` | MyRoom product CA |
| `quantum_products.crt` | Quantum product CA |

**Key finding**: The `residential_local_access.pfx` cert is signed by `CN=Lutron Designer Certificate Authority`,
but the processor expects `CN=Lutron Project SubSystem Certificate Authority`. These are different CAs.

The project-specific SubSystem CA was found separately at `C:\Users\<user>\cert_v2.pfx` — this PFX
contains the CA's own certificate and private key (empty password, ECDSA P-384). Using this CA,
we generated a client cert that the processor accepts.

### Connection Setup

```bash
# Extract CA from PFX (empty password, legacy crypto)
openssl pkcs12 -in cert_v2.pfx -out cert_v2.pem -nodes -passin pass: -legacy

# Generate client key and cert
openssl ecparam -genkey -name secp384r1 -out ipl_client_key.pem
openssl req -new -key ipl_client_key.pem -out ipl_client.csr \
  -subj "/C=US/ST=PA/O=Lutron Electronics Co., Inc./CN=Designer Client"
openssl x509 -req -in ipl_client.csr -CA cert_v2_client.pem -CAkey cert_v2_key.pem \
  -CAcreateserial -out ipl_client_cert.pem -days 3650 -sha384

# Connect
openssl s_client -connect <ra3-ip>:8902 \
  -cert ipl_client_cert.pem -key ipl_client_key.pem -quiet
```

Cipher negotiated: **TLS_CHACHA20_POLY1305_SHA256** (TLSv1.3).

---

## 2. Protocol Framing (from Designer RE, 2026-04-19)

Reversed from `Lutron.Gulliver.Infrastructure.dll`:
`CommunicationFramework.Message.MessageHeader.WriteWith()`,
`CommunicationFramework.Protocol.GulliverProtocolReader`,
`CommunicationFramework.CommunicationManager` (enums).

**Byte order is BIG-ENDIAN for all multi-byte integers.** `GulliverProtocolReader/Writer`
override .NET `BinaryReader/Writer` and do explicit byte-by-byte BE serialisation. Strings
use UTF-16BE (`Encoding.BigEndianUnicode`): 2 bytes per char, variable-length strings are
prefixed with a uint16 BE length and terminated with `00 00`.

### Message Header + Payload (Version3)

```
Offset  Size  Field
0       3     Magic: 'L' 'E' 'I' (0x4C 0x45 0x49)
3       1     Packed: [Version:3][RecvProc:1][Attempt:1][MsgType:3]
4       2     systemId (uint16 BE)  -- 1 byte for Version2, omitted for Version1
6       1     senderId   (address on processor-to-system map)
7       1     receiverId (0xFF = broadcast)
8       2     messageId (uint16 BE, monotonically increasing per sender)
10      16    requestedAcknowledgementSet  -- ONLY when Attempt==Resend (0x08 bit)
10/26   2     operationId (uint16 BE)  -- ONLY when HasOperationId (Command/Response/Event/Control/Telemetry)

-- after the header, if the message HasPayload (all types except Acknowledgement):
12/28   2     payloadLength (uint16 BE)      -- per MessageFactorylet.ReadPayload
14/30   N     payload bytes                  -- operation-specific body
```

**Critical:** the payload is always preceded by a 2-byte BE length prefix. Missing it
causes the processor to try parsing the first two body bytes as the length and then
expect a `LEI` magic at `body[2+parsed_len:]` — when the magic isn't there, the TCP
connection is torn down.

Minimum Version3 Command wire size: 14 bytes (12-byte header + 2-byte length 0 for empty body).

### The Packed Type Byte (offset 3)

| Bits    | Mask | Field              | Values |
|---------|------|--------------------|--------|
| 7-5     | 0xE0 | Version            | `0x00`=V1, `0x20`=V2, `0x40`=V3, `0x60`=V4, … |
| 4       | 0x10 | ReceiverProcessing | `0x00`=NoAcks, `0x10`=Normal |
| 3       | 0x08 | Attempt            | `0x00`=Original, `0x08`=Resend |
| 2-0     | 0x07 | MessageType        | `0`=Command, `1`=Ack, `2`=Response, `3`=Event, `4`=Control, `5`=Telemetry |

RA3 uses **Version3**. `IPLVersionManager.MAX_VERSION_SUPPORTED` is Version3 (the client
warns if a processor advertises Version4+). So the 4th byte is almost always `0x40 | msgType`:

| Byte | ASCII | MsgType | Direction | Purpose |
|------|-------|---------|-----------|---------|
| 0x40 | `@`   | Command | Both | Request with operationId from `Command.Operation` enum |
| 0x41 | `A`   | Ack     | Both | Acknowledges a command/event by messageId; no op, no payload |
| 0x42 | `B`   | Response | Processor → Client | Response to a command |
| 0x43 | `C`   | Event   | Processor → Client | Async event (button press, occupancy, IP announcement, …) |
| 0x44 | `D`   | Control | Both | Flow control (`RequestResendOne`, `RequestResendMany`, `ResendNAK`) |
| 0x45 | `E`   | Telemetry | Processor → Client | Continuous data push (`Runtime`=1, `Configuration`=2) |

**Correction vs. the 2026-03 capture write-up:** `LEIC` is NOT a keepalive — it's an **Event**
frame (button presses, occupancy, LED feedback, etc.). The "Subtype" was actually the
`operationId`, not a random type code. What we called "init" (subtype `0x001C`) was
**DiagnosticBeacon** (opId 28).

### Message Delimiting

There is **no outer length prefix** on the stream. `TcpReceiver.WaitForMessage` reads into
an 8KB buffer and, on each chunk, iterates through `LutronProtocol` (`IPL`, `DeviceIP`)
and calls a per-protocol validator delegate that returns the number of bytes consumed for
a complete message (0 if incomplete). Multiple IPL messages can therefore be pipelined
back-to-back in a single TCP payload.

---

## 3. Message Types in Detail

Each `MessageType` is dispatched by `MessageFactory` to a type-specific `Factorylet`
(see `CommunicationFramework.Message.Factorylet.*`). Commands and Events subclass
the abstract base classes `Command` / `EventAction` and implement
`MarshalPayload(GulliverProtocolWriter)` + `UnmarshalData(…)`.

### 3.1 Command (LEI@, MsgType=0)

OperationId comes from `CommunicationFramework.Action.Command.Operation` (~70 values).
Highlights (full list decompiled in §6):

| opId  | Name                          | Direction |
|-------|-------------------------------|-----------|
| 11    | Ping                          | Both |
| 12    | PresetActivate                | Client → Proc |
| 13    | GoToLevel                     | Client → Proc |
| 16    | GoToScene                     | Client → Proc |
| 20/21/22 | Raise / Lower / StopRaiseLower | Client → Proc |
| 28    | DiagnosticBeacon              | Proc → Client (periodic, previously misidentified as "init") |
| 44    | DeviceSetOutputLevel          | Client → Proc |
| 46    | DevOrLinkInitialize           | Client → Proc |
| 92    | RequestTelnetDiagnosticUser   | Client → Proc |
| 270   | ClearFileSystem               | Client → Proc |
| 271   | SendSystemFile                | Client → Proc (file xfer) |
| 272/273 | UpdateDeviceFirmware / UpdateProcessorFirmware | Client → Proc |
| 284   | FactoryResetDevice            | Client → Proc |
| 306   | RequestObjectTweaks           | Client → Proc |
| 307-309 | Start / Block / End TweakedDataExtraction | Proc ↔ Client |
| 330-333 | PrepareForDatabaseTransfer / DatabaseUri / DatabaseTransferStatus / CompleteDatabaseTransfer | DB push |
| 335   | ReportSchemaVersion           | Proc → Client |
| 338   | ReportIPLProtocolVersion      | Proc → Client (part of init) |
| 340   | GoToLoadState                 | Client → Proc |
| 344   | DatabaseSyncUri               | DB pull |
| 346   | ReportDatabaseSyncInfo        | Proc → Client |
| 347/348 | RequestDeviceNotInDatabase / ReportDeviceNotInDatabase | Device discovery |
| 65532 | **Init** (`InitCommand`)      | Session bootstrap |
| 65533-65535 | TestPing / TestFullReset / Test | Diagnostic |

### 3.2 Acknowledgement (LEIA, MsgType=1)

Ack of a prior command/event by `messageId`. Has no operationId and no payload (per
`AcknowledgementFactorylet`). Only sent when `ReceiverProcessing == Normal` (bit 4 set).

### 3.3 Response (LEIB, MsgType=2)

Response to a command. OperationId matches the command being responded to. Parsed by
`ResponseFactorylet`.

### 3.4 Event (LEIC, MsgType=3)

Async event from the processor. `EventAction` parses: `uint32 BE objectId` + `uint16 BE objectType`
+ per-event-type body. Event IDs (`ProcessorEventIdType`):

| Id | Event |
|----|-------|
| 0  | ButtonPress |
| 1  | ButtonRelease |
| 2  | ButtonMultiTap |
| 3  | ButtonHold |
| 4  | LogEntry |
| 5  | CriticalFailure |
| 6  | OccupancyStateChange |
| 7  | TimeClockExecute |
| 8  | DeviceParameterVerification |
| 9  | DeviceUploadProgress |
| 10 | SceneSave |
| 11 | DeviceUpdateError |
| 12 | LinkUpdateComplete |
| 13 | AfterHoursEvent |
| 15 | BACnetEvent |
| 16 | HyperionEvent |
| 17 | HyperionEndOfDay |
| 18 | AutoReplaceEvent |
| 22 | InfraRedSensorEvent |
| 34 | CordlessWakeupPressEvent |
| 35 | CordlessWakeupReleaseEvent |
| 47 | IPAnnouncementEvent |
| 51 | DeviceUploadProgrammingError |
| 52 | DeviceUploadCriticalError |
| 60 | IntegrationCommandEvent |

#### Button event body (ops 0/1/2/3)

```
uint32 BE  objectId         (keypad/pico device object id)
uint16 BE  objectType        (ObjectType.Device = 7)
uint16 BE  componentNumber   (physical button number — matches LEAP Button.ButtonNumber)
[trailing bytes — originator / LED-affinity / state; layout TBD]
```

Decoded by `decodeButtonEvent()` in `lib/ipl.ts`. `ipl-monitor.ts` prints
`ButtonPress dev=483(Office) type=7 comp=1`. Trailing bytes are surfaced as
hex until their layout is confirmed against the DLL.

### 3.5 Control (LEID, MsgType=4)

Flow control / reliability layer. `Control.Operation` enum:

| opId | Name |
|------|------|
| 0 | Unknown |
| 1 | RequestResendOne |
| 2 | RequestResendMany |
| 3 | ResendNegativeAcknowledgment |

Tied to `CommunicationFramework.Reactor.ReplySetManager` / `OrderByMessageIdPassive` —
the receiver tracks gaps in sender messageIds and requests retransmissions.

### 3.6 Telemetry (LEIE, MsgType=5)

Continuous property push. `Telemetry.Operation`:

| opId | Name |
|------|------|
| 1 | Runtime (levels, occupancy, LEDs — what Designer's UI renders) |
| 2 | Configuration (device settings, tweaks) |

Body is a stream of `MonitorIdentifier → value` pairs (see `RuntimeServer.MonitorIdentifierConverter`).

#### Decoded RuntimeProperty values (Telemetry/Runtime)

Per-property value encoding pulled from `RuntimePropertyConverter`. `ipl-monitor.ts`
pretty-prints the following:

| Prop # | Name | Encoding | Rendered |
|-------:|------|----------|----------|
| 1 / 4 / 38 / 39 | Level / CurrentLevel / Occupied / Unoccupied | `[cmd:u8][level16:u16 BE]` or bare `u16 BE` | `50% (0x7f80)` |
| 43 / 45 / 46 | Tilt / TiltCurrent / BacklightIntensity | level16 | `50%` |
| 135 / 136 | TargetVibrancy / CurrentVibrancy | level16 (inferred) | `50%` |
| 10 | LastPresetActivated | `u32 BE` preset object id | `preset=496` |
| 14 / 67 | CurrentScene / SceneSelect | `u16 BE` scene number | `scene=2` |
| 16 / 28 / 156 | OccupancyStatus / OccupancyActive / PresenceStatus | 1 byte; 1=Unknown, 3=Occupied, 4=Unoccupied, 255=Disabled | `Occupied` |
| 23 | LED_STATUS | `u16 BE`; low byte = on/off | `led=ON` |
| 77 / 128 | UpdateProgress / RemainingBatteryLevel | `u8` percent | `75%` |
| 91 / 254 | AreaLightingState / AreaOnOff | 1 byte bool | `ON` / `off` |
| 130 | DaytimeNighttimeState | 1 byte; 0=Day, 1=Night | `Day` |
| 131 | ConnectionStatus | 1 byte; 3=Connected, 4=Disconnected (inferred; shares the occupancy-style enum space) | `Connected` |
| 139 / 140 | TargetCCT / CurrentCCT | `u16 BE` Kelvin (inferred; Ketra ~1400–6500K) | `2700K` |

Properties marked "inferred" are high-confidence guesses pending wire
verification — they fall back to raw hex if the byte length doesn't match.

---

## 4. Decoded Command Body Layouts

All integers below are big-endian. Derived by decompiling `MarshalPayload` /
`UnmarshalData` on each `*Command` class.

### DeviceSetOutputLevel (opId 44) — 10 bytes

```
byte   processorNumber
byte   linkNumber
uint32 BE  serialNumberOfDevice   (8-char hex device serial, e.g. 0x0595E68D)
uint16 BE  componentNumber
uint16 BE  outputLevel            (level16 = percent * 0xFEFF / 100)
```

This is the Designer-side equivalent of the Telnet `#DEVICE,...,14,level` command.
No fade field — matches the telnet protocol note that DEVICE actions don't carry
fade; the dimmer uses its programmed default ramp.

### GoToLevel (opId 13) — 14 bytes (OUTPUT path, has fade) ✅ verified

```
uint32 BE  objectId            (LEAP integration id / zone id)
uint16 BE  objectType          (ObjectType.Zone = 15 for a zone)
uint16 BE  level               (level16 = pct * 0xFEFF / 100)
uint16 BE  originatorFeature   (OriginatorFeature.GUI = 9)
uint16 BE  fadeTime            (quarter-seconds; seconds * 4)
uint16 BE  delay               (quarter-seconds)
```

`const ushort MAX_LEVEL = 65279` (0xFEFF). `const ushort FadeTime = 0` and
`Delay = 0` are the GoToLevelCommand defaults.

Verified end-to-end on 2026-04-19 against RA3 @ 10.1.1.133 using `tools/ipl-cmd.ts`:
`gotolevel 546 50 1 0` drove zone 546 "Standing Desk Lamps" to 50% with a 1s fade and
got a `Telemetry/Runtime` feedback frame back with `obj=0x0222 prop=0x000F val=0x7F80`.

### DiagnosticBeacon (opId 28) — variable (36 / 40 / 49 bytes, incoming)

Processor → Client periodic beacon; Designer parses it in `UnmarshalData`:

```
byte[4]   deviceTypeSerialNumber
byte[16]  databaseGUID
uint16 BE majorOsRev, minorOsRev, buildOsRev
uint16 BE majorBootRev, minorBootRev, buildBootRev
-- if body length >= 36:
byte      (reserved, skipped)
byte      deviceProduct  (DeviceProduct enum)
byte      hardwareRev
byte      operatingMode  (ProcessorOperatingModes)
-- if body length == 40:
uint32 BE lastTweakTimestamp
-- if body length == 49:
byte[9]   (unknown extra — RA3 uses this variant)
```

This matches the 49-byte "init" body previously captured. The `08 67 63 08 06 67 A2 CB`
prefix was (devSerial) + databaseGUID bytes, not opaque binary.

### ReportIPLProtocolVersion (opId 338) — 8 bytes, incoming

```
uint32 BE IPLMajorVersion
uint32 BE IPLMinorVersion
```

Sent by the processor during session bootstrap so Designer can update
`IPLVersionManager.processorVersionMap[systemId][processorId]`.

### ReportDatabaseSyncInfo (opId 346) — 20 bytes, incoming

```
byte[16]  GUID
uint32 BE ModifiedObjectCount
```

Triggers a delta sync if the GUID differs from Designer's local DB.

### Init (opId 65532) — abstract `InitCommand`

`Lutron.Gulliver.Infrastructure.CommunicationFramework.Action.InitCommand` is abstract
and has no subclass in the Designer DLLs I decompiled — the concrete body is supplied
elsewhere (likely `Lutron.ProcessorTransfer.dll` / processor firmware). Distinct from
DiagnosticBeacon (28); `InitCommand.GetOperationId()` returns `65532` (0xFFFC), not 28.

### GoToScene (opId 16) — 14 bytes ✅ verified

```
uint32 BE  objectId          (Area objectId; ObjectType.Area = 2)
uint16 BE  objectType         (= 2 for Area)
uint16 BE  sceneNumber        (0 = Off; 1..N = scene index for that area)
uint16 BE  originatorFeature  (OriginatorFeature.GUI = 9)
uint16 BE  fadeTime           (quarter-seconds)
uint16 BE  delay              (quarter-seconds)
```

Same shape as GoToLevel with `level` replaced by `sceneNumber`. Verified on
2026-04-19 against RA3 area 32 (Office): sn=0→0%, sn=1→100%, sn=2→75%,
sn=3→49%, sn=4→24%. Out-of-range scene numbers (e.g. 16 in a 5-scene area)
are silently dropped — no ack, no level change.

### Raise (20) / Lower (21) / StopRaiseLower (22) — 12 bytes each ✅ verified

```
uint32 BE  objectId           (Area objectId; ObjectType.Area = 2)
uint16 BE  objectType          (= 2 for Area)
uint16 BE  originatorFeature   (OriginatorFeature.GUI = 9)
uint16 BE  fadeTime            (quarter-seconds; the dimmer's ramp rate cap)
uint16 BE  delay               (quarter-seconds)
```

Same shape as GoToLevel/GoToScene minus the level/scene field. All three
opIds share this 12-byte layout. Raise/Lower begin a continuous ramp at the
area's programmed rate; StopRaiseLower halts an in-progress ramp. Verified
2026-04-19 against RA3 area 32 — visible level changes on linked zones with
matching `Telemetry/Runtime` Level frames; `stoprl` mid-ramp halts the fade
at the intermediate level (caught one ramp at 74% mid-flight).

### PresetActivate (opId 12) — bus-internal only

Every binary body shape tested gets a `LEIA` ack but no side effect. The
correct external path for preset activation is **opId 60 `IntegrationCommand`
with `#DEVICE,<keypadId>,<btnNum>,3\n`** — see below. This routes through the
processor's `INTEGRATION_COMMAND_PROCESSOR` which runs the keypad button's
`ProgrammingModel` (AdvancedToggle, SingleAction, etc.), which then invokes
the preset internally.

### IntegrationCommand (opId 60) — ASCII string payload ✅ verified

```
body = ascii bytes of a telnet-style line, terminated with '\n'
```

The processor registers a single `Command` handler (opId **60**) whose body
is a line of ASCII text dispatched through `INTEGRATION_COMMAND_PROCESSOR`
— the same dispatcher the legacy RA2/HWQS telnet integration port used.
On RA3 the telnet TCP port (23) is closed, but the dispatcher itself is
reachable from the IPL TLS port (8902) via opId 60.

Registered command verbs (from `sub_1177518` in lutron-core
v26.01.13f000):

| Verb              | Purpose                                             |
|-------------------|-----------------------------------------------------|
| `#DEVICE`         | Simulate keypad events (Press/Release/Hold/MultiTap)|
| `?DEVICE`         | Query device state                                  |
| `#OUTPUT`         | Set a zone's output level                           |
| `?OUTPUT`         | Query a zone's level                                |
| `#AREA` / `?AREA` | Area-scoped scene/state commands                    |
| `#SHADEGRP` / `?SHADEGRP` | Shade-group commands                        |
| `#TIMECLOCK` / `?TIMECLOCK` | Timeclock commands                        |
| `?INTEGRATIONID`  | Query integration ID                                |
| `#SYSTEM` / `?SYSTEM` | System-wide commands                            |
| `?HELP`           | List available commands                             |
| `#SYSVAR` / `?SYSVAR` | System-variable get/set                         |
| `#EMULATE`        | Emulator hooks                                      |
| `#PARTITIONWALL` / `?PARTITIONWALL` | Partition-wall state               |
| `?GROUP`          | Query temporary groups                              |
| `#MONITORING`     | Subscribe to telemetry                              |

#### `#DEVICE,<deviceObjectId>,<buttonNumber>,<action>\n`

Action codes (from `sub_1188918` switch):

| Action | Telnet name | Dispatch |
|--------|-------------|----------|
| 3      | Press       | `CORE_TASK.sendKeypadEvent(btn, 0x38, 0, …)` |
| 4      | Release     | `CORE_TASK.sendKeypadEvent(btn, 0x38, 1, …)` |
| 5      | Hold        | `CORE_TASK.sendKeypadEvent(btn, 0x38, 3, …)` |
| 6      | MultiTap    | `CORE_TASK.sendKeypadEvent(btn, 0x38, 2, …)` |

`deviceObjectId` is the LEAP `/device/<id>` id of the keypad (NOT the
button's `/button/<id>`). `buttonNumber` is the physical button position
(1-based, matches LEAP `Button.ButtonNumber`). The newline is required.

Verified 2026-04-19 on RA3 firmware v26.01.13f000 against SunnataHybridKeypad
device 483 button 1 (bound to preset 496 Office Entrance): sending `#DEVICE,
483,1,3\n` then `#DEVICE,483,1,4\n` toggles zones 518/546/574 through the
button's `AdvancedToggleProgrammingModel` (primary preset 75%, secondary 0%).
Tooling exposes this as `ipl-cmd.ts press <deviceObjId> <btnNum>`.

#### `#OUTPUT,<integrationId>,<action>[,<args>]\n`

Action codes (jump table at 0x118b1fc in `sub_118aef8`, indexed by
`actionCode-1` with bound `cmp #34`):

| Action | Telnet name        | Args                       | Implemented |
|--------|--------------------|----------------------------|-------------|
| 1      | Set/Get Level      | `level[,fade[,delay]]`     | ✅ wire     |
| 2      | Start Raising      | —                          | ✅ wire     |
| 3      | Start Lowering     | —                          | ✅ wire     |
| 4      | Stop Raise/Lower   | —                          | ✅ wire     |
| 5      | Start Flash        | (per LIP guide)            | ✅ in fw    |
| 6      | Pulse Time         | (per LIP guide)            | ✅ in fw    |
| 7, 8   | (unsupported)      |                            | ❌ falls through |
| 9      | Set Tilt           | shades                     | ✅ in fw    |
| 10–21  | (tilt / lift / ALD variants — see LIP guide §5)            | ✅ in fw    |
| 22–30  | (unsupported)      |                            | ❌ falls through |
| 31     | (per LIP guide)    |                            | ✅ in fw    |
| 32–34  | (unsupported)      |                            | ❌ falls through |
| 35     | (per LIP guide)    |                            | ✅ in fw    |

`integrationId` is the **Designer-assigned Integration ID** (small integer,
project-local, ≠ LEAP zone object id). The mapping lives in the Designer SQL
DB table `tblIntegrationID` (columns `DomainControlBaseObjectID`,
`IntegrationID`, `DomainControlBaseObjectType`); see
`docs/infrastructure/designer-db.md`. RA3's LEAP API does **not** expose the
mapping, so without Designer DB access there is no in-band lookup.

Per the firmware arg-count check on action 1 (`(argc-4) <= 2`), `delay` requires
`fade` — `#OUTPUT,id,1,level,,delay` is rejected with `~ERROR,1`.

Tooling exposes the four wire-tested actions:

```
ipl-cmd.ts output-set   <intId> <pct> [fade] [delay]
ipl-cmd.ts output-raise <intId>
ipl-cmd.ts output-lower <intId>
ipl-cmd.ts output-stop  <intId>
```

The encoders in `lib/ipl.ts` (`bodyOutputSetLevel`, `bodyOutputStartRaising`,
`bodyOutputStartLowering`, `bodyOutputStopRaiseLower`) emit byte-identical
output to the equivalent `intcmd` raw string — verified 2026-04-19 by diffing
the Command frame hex.

**Side-effect verification status (2026-04-19):** the firmware dispatcher
exists and accepts the bytes (no `~ERROR` echoed back; bus-internal `op=349
RequestSetLEDState` and Telemetry frames follow). Direct effect verification
on the test rig is **blocked on the IntegrationID map** — the IDs we probed
(1–15) produced ambient telemetry indistinguishable from background activity,
and the historical claim "intID 5 → LEAP zone 10508" no longer reproduces
(zone 10508 not in current LEAP dump). The encoder is correct by construction
(disassembly + wire equivalence); per-zone effect verification is gated on
populating `data/integration-ids-<host>.json` via Designer DB.

**Telemetry routing for OUTPUT changes:** Level Telemetry from an OUTPUT
change is delivered against an `objectType=3` **LoadController**, not against
the Zone (`objectType=15`). To map a LoadController obj → Zone obj, query
`/loadcontroller/<id>` over LEAP and follow `AssociatedZone.href`. (Discovery
2026-04-19: LC obj 3650 → `/loadcontroller/3650` → zone 3663 "Closet Light".)
`ObjectType.LoadController` is added to `lib/ipl.ts` so consumers can decode it.

#### Important caveats (verified empirically, RA3 2026-04-19)

1. **ID spaces differ per verb.**
   - `#DEVICE,<id>,…` takes the **LEAP `/device/<id>` object id** (e.g. 483 for a
     SunnataHybridKeypad).
   - `#OUTPUT,<id>,…` takes the **Designer-assigned Integration ID** (small
     integer, ≠ LEAP zone object id). `#OUTPUT,5,1,50,2` triggered Level
     telemetry for LEAP zone 10508, not zone 5; `#OUTPUT,546,…` did nothing.
   - `#AREA`, `#SHADEGRP`, `#TIMECLOCK`, `#SYSVAR`, `?GROUP` almost certainly
     use the Integration ID convention too — the mapping is project-local and
     lives in Designer.

2. **Query verbs (`?DEVICE`, `?OUTPUT`, `?HELP`, `?SYSVAR`, …) return nothing
   on the IPL connection.** The processor dispatches the text response to
   `TERMINAL_TASK_INTF` (the telnet session), not back on the IPL TLS socket.
   If you need the answer, either use LEAP (which has proper request/response
   over 8081) or observe the corresponding telemetry after a write.

3. **Write verbs still work** — state changes surface as normal LEIE/Runtime
   telemetry frames on the same IPL connection.

4. **Unsupported verbs** fall through to `"Command not yet supported\n"` (goes
   to TERMINAL_TASK, so silent from the IPL side). Only the verbs in the table
   above are registered in `INTEGRATION_COMMAND_PROCESSOR::ctor`.

### Full Command.Operation enum (truncated)

Extracted from `Command.Operation` — 70+ values. See
`Lutron.Gulliver.Infrastructure.dll!Lutron.Gulliver.Infrastructure.CommunicationFramework.Action.Command.Operation`
for the complete list (attributed with `[I18NInformation]` resource IDs for
human-readable names in the Designer UI).

### Bus-internal-only opIds — NOT externally reachable (verified 2026-04-19)

opIds **12 PresetActivate**, **16 GoToScene**, **20 Raise**, **21 Lower**, and
**22 StopRaiseLower** are declared in `Command.Operation` but the integration
TLS port (8902) silently drops them. They are bus-internal messages flowing
between processor halves (master ↔ link processors) over the internal IPC bus,
not client-facing IPL commands.

**Evidence:**

1. **No Designer marshaller.** Designer's `Infrastructure.dll` has 70+ `Command`
   subclasses with `MarshalPayload(GulliverProtocolWriter)` overrides; none map
   to opIds 12/16/20/21/22. Compare to GoToLevel (13) which is implemented in
   `…ProcessorProtocolActions.CommandType.GoToLevelCommand`.

2. **Designer uses LEAP for these semantics.**
   `Lutron.Gulliver.ModelViews.UpdateLoadInRealTimeViaLeap.ZoneRaiseCommand()`
   calls `ZoneRequestHandler.RaiseCommand()` — a LEAP request handler returning
   `LeapCommandResponse`. The class is literally named `…viaLeap`; there is no
   IPL fallback path.

3. **Public Telnet integration also routes through LEAP.** The Telnet
   integration server translates `#OUTPUT,n,2` (Start Raising) into LEAP
   `Lutron.Services.Core.LAPFramework.RaiseRequest`, not into IPL opId 20.

4. **Wire-test confirmation.** Sending opId 20/21/22 with multiple body shapes
   (6 / 8 / 12 bytes) and multiple senderIds (1, 0) to RA3 zone 546 produced:
   no `LEIA` ack, no `LEIE/Runtime` Level Telemetry, and no observable level
   change (verified via `GetRuntimeProperty Level` immediately after). For
   contrast, `GoToLevel` (opId 13) produces an immediate ack plus Level
   Telemetry plus the actual level change.

5. **Firmware symbols match the bus-internal hypothesis.** `lutron-core` (the
   processor's C++ task supervisor) exports
   `TASK_CORE::sendRaiseMessage(…RAISE_LOWER_DATA…)` and
   `SYSTEM_CONTROL_OUTGOING_PRESET_ACTION_COMMAND_VISITOR::visitStopRaise(STOP_RAISE_INFO)`
   — these are *outgoing* code paths from master to link processors over the
   internal bus. The integration port has no incoming parser for these opIds.

**Recommendation for callers wanting Raise / Lower / Stop / Scene / Preset:**

| Want                                  | Use                                                           |
|---------------------------------------|---------------------------------------------------------------|
| Raise / Lower / Stop on a zone        | LEAP `RaiseRequest` / `LowerRequest` / `StopRequest` (8081)   |
| GoToScene on an area                  | LEAP `GoToSceneRequest` (8081)                                |
| **Preset activation**                 | **IPL opId 60 `#DEVICE,<keypadId>,<btnNum>,3\n` (see §4.1)**  |
| Plain-text from a script              | Telnet integration protocol (port 23, public docs)            |

The LEAP request models live in `Lutron.Services.Core.LAPFramework.dll` —
`RaiseRequest`, `LowerRequest`, `StopRequest`, `GoToSceneRequest`,
`GoToSceneCommand`. The HTTP-style request URIs are `/zone/{id}/commandprocessor`
with body `{ "Command": { "CommandType": "Raise" } }` etc.

**Why these opIds exist in the enum at all.** The processor firmware shares
`Command.Operation` between two transports: the external integration port
(subset of opIds accepted) and the internal bus (full set, including these 5).
Designer surfaces the entire enum via `[I18NInformation]` because the diagnostics
viewer needs human names for both kinds.

---

## 5. Session Bootstrap (revised)

The `00 3B "RequestSetLEDState" … <zlib>` stream captured previously appears to be a
**separate named-RPC layer** inside a Command payload (still not fully located — no
class of that name exists in the Infrastructure DLL's `Command` subtypes). The strings
list it alongside other `Request*` names, suggesting a generic dispatcher. Until that
wrapper is located, treat those string-prefixed bodies as out-of-spec relative to the
`Command.Operation` enum-based commands above.

Typical open-session flow (inferred from enum + IPLVersionManager):

1. Designer opens mTLS to the processor's IPL endpoint.
2. Processor sends `DiagnosticBeacon` (opId 28, Version3 Command) with firmware + DB GUID.
3. Designer may send `Ping` (11) to confirm liveness.
4. Processor sends `ReportIPLProtocolVersion` (338) with major/minor.
5. Processor sends `ReportSchemaVersion` (335) + `ReportDatabaseSyncInfo` (346).
6. If DB GUID differs, Designer requests sync (`DatabaseSyncUri`=344, `PrepareForDatabaseTransfer`=330, `DatabaseUri`=331, `CompleteDatabaseTransfer`=333).
7. Processor continuously streams `Telemetry/Runtime` (LEIE, opId=1) with live zone levels / LEDs / occupancy.

---

## 6. WSS vs. TCP Transport (key finding, 2026-04-19)

There is **no separate "WSS protocol."** WSS is one of three transport options in the
`CommunicationProtocolType` enum:

```cs
// Lutron.Gulliver.NetworkFramework.dll
public enum CommunicationProtocolType { Udp, Tcp, WSS }
```

The `LutronProtocol` enum — what we actually speak over the wire — has only two values:
`IPL` and `DeviceIP`. So:

- **`LutronProtocol.IPL`** over **`CommunicationProtocolType.Tcp`** = the classic
  TLS:8902 stream this doc describes (LEI-framed binary).
- **`LutronProtocol.IPL`** over **`CommunicationProtocolType.WSS`** = the same LEI-framed
  binary payload carried inside WebSocket frames on a different port.
- **`LutronProtocol.IPL`** over **`CommunicationProtocolType.Udp`** = legacy QS/RA2 UDP
  variant (`CommunicationProtocolTypeHelper.GetDefaultCommunicationProtocol() == Udp`).

### Per-Processor Transport Discovery

Designer asks LEAP for the processor's server definitions (via
`PostActivationSettingsRequestHandler.ReadMultipleServerDefinitions`) and gets back a
list like:

```json
[
  { "Type": "IPL",      "EndPoints": [
      { "Protocol": "TCP", "Port": 8902 },
      { "Protocol": "WSS", "Port": <?> }   // only if EnableWSS flag enabled
  ]},
  { "Type": "DeviceIP", "EndPoints": [ ... ] }
]
```

`ProcessorModelView.IsWSSEnabled()` returns true when a WSS endpoint is advertised
under the IPL server definition (`IsProtocolEnabledOnIplServer(WSS)`).

### Feature-flag gated rollout

Two Rollout.io flags in `FeatureFlagServiceProvider.FlagsContainer` gate the WSS
migration:

| Flag | Effect |
|------|--------|
| `EnableWSS` | Allow Designer to negotiate WSS instead of raw TCP for new activations |
| `EnableWSSMigration` | Upgrade already-activated processors (`ApplySecuitySettingsPipeline.UpdateWssSettingOnProcessor`) |

Post-activation, `ProcessorModelView.EnableWSS()` does:

```cs
if (GetIplServerDefinition() != null) {
    result = IsProtocolEnabledOnIplServer(CommunicationProtocolType.WSS)
          || new PostActivationSettingsRequestHandler().EnableWSS(this);
}
```

i.e., either the processor already exposes a WSS endpoint, or Designer POSTs a LEAP
request that asks it to start doing so.

### Framing differences

**None at the IPL payload level.** Once the stream is established (either raw TLS/TCP
or inside a WebSocket), the LEI framing, operationIds, body layouts, and endianness are
all identical. The port/handshake differ; the protocol bytes do not.

### Nomenclature

- "IPL" is how Designer's code names the protocol. User-facing Lutron docs sometimes
  call it **LIP** ("Lutron Integration Protocol") — treat `LIP` and `IPL` as the same
  thing in this codebase. There is no class literally named `LIP*`; all internal
  identifiers are `Ipl*` / `IPL*`.

---

## 7. Revised Traffic-Pattern Notes

The previously observed 5-second "cycle" was not a protocol feature but a consequence
of `Telemetry/Runtime` (LEIE) being refreshed alongside `Event` (LEIC) bursts for
button/LED state. Re-labeling what we captured:

| Old label     | Actual |
|---------------|--------|
| `LEI@ RequestSetLEDState` | `Command` frame, operationId TBD (named-RPC wrapper, not in `Command.Operation`) |
| `LEIE heartbeat` (body=`00`) | `Telemetry/Runtime` (opId=1) with an empty monitor-item list |
| `LEIE status batch` | `Telemetry/Runtime` (opId=1) carrying level/occupancy/LED items |
| `LEIC keepalive` | `Event` (MsgType=3) — a `ProcessorEventIdType` (button/LED/occupancy) |
| `LEI@ init, subtype 00 1C` | `Command` `DiagnosticBeacon` (opId=28) — not Init |

### Known Command Names (string table, for future searches)

`Lutron.Gulliver.Infrastructure.dll` strings still show these names; most are telemetry
monitor identifiers or LEAP-side RPC wrappers rather than raw IPL operationIds:

| Name | Likely Layer |
|------|--------------|
| `RequestSetLEDState` | Named-RPC wrapper inside a Command (dispatcher not yet located) |
| `RequestIPLProtocolVersion` | Triggers opId 338 |
| `RequestSchemaVersion` | Triggers opId 335 |
| `RequestDatabaseSync` / `RequestDatabaseSyncInfo` | Triggers opIds 344 / 346 |
| `RequestDeviceNotInDatabase` | opId 347 |
| `RequestDeviceTransferStatus` | opId 341 |
| `RequestObjectTweaks` | opId 306 |
| `RequestTweakChanges` | opId 69 |
| `RequestTelnetDiagnosticUser` | opId 92 |
| `DeviceSetOutputLevel` | opId 44 |
| `EndTweakedDataExtraction` | opId 309 |

---

## 8. Comparison with LEAP API

| Feature | LEAP (8081) | IPL (8902 TCP / WSS alt) |
|---------|-------------|--------------------------|
| Transport | JSON over TLS | Binary (LEI framing) over TLS or WSS; 8N1 over Udp for legacy |
| Auth | LEAP certs (lutron-root CA) | Project SubSystem CA |
| Direction | Request/response | Bidirectional: Commands + async Events + continuous Telemetry |
| Zone control | `CreateRequest GoToLevel` | `GoToLevel` (opId 13) / `DeviceSetOutputLevel` (opId 44) |
| Device config | Caseta only | `RequestObjectTweaks` (opId 306) + `TweakedObjectDataBlock` (opId 308) |
| Database | Per-endpoint reads | `DatabaseSyncUri` (344) / `DatabaseUri` (331) + chunk transfer |
| Real-time | Subscribe to events | `Telemetry/Runtime` (MsgType=5, opId=1) pushes continuous updates |
| Endianness | JSON (N/A) | **Big-endian** (custom `GulliverProtocol{Reader,Writer}`) |
| Strings | UTF-8 JSON | **UTF-16BE** variable-length-prefixed |

---

## 9. Tools

| Tool | Purpose |
|------|---------|
| `tools/ipl-client.ts` | Read-only: connect, decode, display IPL traffic (uses old framing — needs update) |
| `tools/ipl-cmd.ts` | Write-path: send a proper Version3 Command with correct length-prefixed body (verified GoToLevel) |
| `tools/leap-explore.ts` | Comprehensive LEAP endpoint scanner |
| ~~`tools/leap-frida.js`~~ | Removed — Frida TLS hook, blocked by SIP |
| ~~`tools/leap-lldb-intercept.py`~~ | Removed — LLDB TLS breakpoint, blocked by hardened runtime |

### IPL Client Usage

```bash
bun run tools/ipl-client.ts                    # Connect and show all messages
bun run tools/ipl-client.ts --quiet            # Only state changes + commands
bun run tools/ipl-client.ts --save             # Save raw + parsed data to data/
bun run tools/ipl-client.ts --host <ra3-ip>  # Specify processor IP
```

---

## 10. Certificate Files

All in `certs/designer/`:

| File | Source | Purpose |
|------|--------|---------|
| `cert_v2.pfx` | Windows VM | Project SubSystem CA (key + cert, empty password) |
| `cert_v2_client.pem` | Extracted | SubSystem CA cert (PEM) |
| `cert_v2_key.pem` | Extracted | SubSystem CA private key (PEM) |
| `ipl_client_cert.pem` | Generated | Our client cert (signed by SubSystem CA) |
| `ipl_client_key.pem` | Generated | Our client private key |
| `radioRa3_products.crt` | Designer | RA3 product root CA (server verification) |
| `residential_local_access.pfx` | Designer | Generic residential GUI cert (NOT accepted by processor) |
| `commercial_local_access.pfx` | Designer | Generic commercial GUI cert |
| `one_gui_local_access.pfx` | Designer | OneGUI interface cert |
| `proc_cert2.pfx` | Windows VM | Processor's own server cert |

---

## 11. Future Work

1. ~~**Decompile Designer**~~ — **DONE**. See §2–§6.
2. **Named-RPC wrapper**: Locate the Command subclass that wraps
   `RequestSetLEDState` + zlib-JSON payloads. The `Command.Operation` enum doesn't
   cover it directly; look for a dispatch class in `Lutron.Gulliver.DomainObjects.dll`
   or `Lutron.ProcessorTransfer.dll`.
3. **InitCommand body**: `InitCommand` is abstract in `Infrastructure.dll` (opId 65532);
   find its concrete subclass (likely in `Lutron.ProcessorTransfer.dll` or processor
   firmware) to replay a real session bootstrap.
4. **Database sync**: Issue `DatabaseSyncUri` (344) + follow the chunk-transfer
   state machine (`PrepareForDatabaseTransfer` 330 → `DatabaseUri` 331 →
   `DatabaseTransferStatus` 332 → `CompleteDatabaseTransfer` 333) to pull the full
   project DB.
5. **Device config via IPL**: Implement `RequestObjectTweaks` (306) +
   `StartTweakedDataExtraction` (307) / `TweakedObjectDataBlock` (308) /
   `EndTweakedDataExtraction` (309) to modify trim, phase, fade, LED settings —
   fields hidden on RA3's LEAP API.
6. **WSS transport**: Capture a Designer session with `EnableWSS` flag on to confirm
   the WebSocket framing (port, sub-protocol name, ping/pong handling).
7. **Update `tools/ipl-client.ts`**: Replace the old "LEIC=keepalive" logic with
   the corrected Event/Telemetry/Control decode + operationId lookup.

## 12. Telnet Integration Protocol (ESN Interface)

Source: `telnet-reference.pdf` — Lutron Integration Protocol Guide, Revision AH, 172 pages.
Covers: QS Standalone, RadioRA 2, Quantum, Athena, HomeWorks QS, myRoom plus.

### Telnet Action Numbers <-> CCA/CCX Mapping

The telnet protocol's action numbers are consistent across ALL Lutron systems and map to CCA/CCX binary protocols:

#### OUTPUT Actions (zone/load control — maps to bridge/Vive format 0x0E)
| Action | # | CCA | CCX |
|--------|---|-----|-----|
| Set Zone Level | 1 | Format 0x0E SET_LEVEL (level + fade + delay) | Type 0 LEVEL_CONTROL |
| Start Raising | 2 | Hold-start 0x09 + dim steps 0x0b (raise) | Type 2 DIM_HOLD |
| Start Lowering | 3 | Same (lower direction) | Type 2 DIM_HOLD |
| Stop Raise/Lower | 4 | Hold-release | - |
| Start Flashing | 5 | Unknown in CCA | - |
| Pulse Time | 6 | CCO pulse | - |
| Tilt Level | 9 | Shade tilt | CCX COMPONENT_CMD? |
| Lift & Tilt | 10 | Shade lift+tilt | CCX COMPONENT_CMD? |
| Motor Jog | 18-21 | - | CCX COMPONENT_CMD params? |

#### DEVICE Actions (component control — maps to pico/keypad packets)
| Action | # | CCA | CCX |
|--------|---|-----|-----|
| Press / Occupied | 3 | Button press packet | Type 1 BUTTON_PRESS |
| Release / Unoccupied | 4 | Button release | - |
| Hold | 5 | CCA hold command | - |
| Double-tap | 6 | CCA double-tap | - |
| Scene | 7 | - | Type 36 SCENE_RECALL |
| LED State | 9 | Format 0x11 LED config | - |
| Light Level | 14 | Pico set-level (through zone controller) | - |
| Zone Lock | 15 | Config format? | - |
| Scene Lock | 16 | Config format? | - |
| Raise | 18 | Start raising | - |
| Lower | 19 | Start lowering | - |
| Stop | 20 | Stop | - |
| Hold Release | 32 | Hold-release packet | - |

### OUTPUT vs DEVICE: The Fundamental Split

- **OUTPUT** = direct zone/load control with level + fade + delay. Maps to bridge format 0x0E (8-byte payload with fade at byte 19).
- **DEVICE** = component-based control (buttons, LEDs, zone controllers). Maps to pico/keypad packets (5-byte payload, no fade field).

#### Implications for Pico Set-Level
- DEVICE action 14 (Set Light Level) DOES accept level + fade + delay parameters in QS Standalone
- But for RadioRA 2: "Use OUTPUT command with equivalent action number" — i.e., RadioRA 2 devices expect level+fade via OUTPUT, not DEVICE
- Pico is strictly a DEVICE — its telnet integration only supports Press(3) and Release(4)
- The pico set-level hack works because DEVICE action 14 carries a level value, but the ~1-2 min slow fade is likely the dimmer's **default ramp rate** for non-OUTPUT commands
- The slow fade is NOT a bug — it's the dimmer applying its programmed/default fade rate when receiving a level change through a DEVICE path rather than an OUTPUT path

### Quarter-Second Fade Resolution is Universal

Doc states: "Fractional seconds will be rounded down to the nearest quarter second" — appears in EVERY command with fade/delay. Confirms CCA byte 19 encoding: `byte19 = seconds * 4` (quarter-seconds). Default fade = 1 second (0x04). Min = 0.25s (0x01).

### Component Number Patterns

#### Pico (DEVICE)
- Non-4B: Button 1=2, Button 2=3, Button 3=4, Raise=5, Lower=6
- PJ2-4B: Button 1=8, Button 2=9, Button 3=10, Button 4=11

#### Keypads (seeTouch, Hybrid, etc.)
- Buttons: component 1-17 (varies by model)
- **LEDs = button number + 80** (LED 1=81, LED 2=82, etc.)
- Raise/Lower: component 16-25 range

#### GRAFIK Eye QS
- Zone controllers: 1-24
- Scene buttons: 70,71,76,77,83
- Scene controller: 141
- LEDs: 201, 210, 219, 228, 237 (scene LEDs)
- Occupancy sensors: 500-529 (wireless), 700-763 (EcoSystem)

### Fan Speed Level Bands
0%=Off, 1-25%=Low, 26-50%=Medium, 56-75%=Med-High, 76-100%=High.
Same 0-100% level encoding, just interpreted in bands.

### Device Serial Numbers = 8-char Hex (32-bit)
`?INTEGRATIONID,1,5678EFEF` — the 8-char hex is the same 32-bit device ID we use in CCA (e.g., 0x0595E68D).

### MONITORING Types -> CCA Packet Categories
| Type | # | CCA Relevance |
|------|---|---------------|
| Diagnostic | 1 | Debug/diag |
| Button | 3 | BTN packets |
| LED | 4 | LED config (0x11) |
| Zone | 5 | STATE_RPT / level feedback |
| Occupancy | 6 | Occ sensor packets |
| Scene | 8 | Scene recall |
| HVAC | 17 | HVAC packets |
| Mode | 18 | System mode |
| Shade Group | 23 | Shade group packets |

### AREA Model
- Areas contain zones and devices
- Scenes: 0-32 (0=Off), per-area
- Scene activation = action 6 with scene number
- Occupancy states: 3=Occupied, 4=Unoccupied, 255=Unknown (same as Press/Release!)
- Maps to CCX SCENE_RECALL (type 36) and DEVICE_REPORT (type 27)

### "Clear Connect Device" (CCD) Prefix
Page 145: Maestro dimmer models include "Clear Connect Device Models (CCD-W)" — official name for the CCA-family devices.

### Systems Covered
- **QS Standalone**: QS Link (RS485), integration via QSE-CI-NWK-E
- **RadioRA 2**: RF (CCA), integration via Main Repeater telnet/RS232
- **Quantum**: Commercial, integration via QSE-CI-NWK-E
- **Athena**: Newest commercial (Ketra + QS + EcoSystem), integration via QSE-CI-NWK-E
- **HomeWorks QS**: Premier residential, integration via HQP6-2 processor
- **myRoom plus**: Hospitality, integration via GCU-HOSP

All share the same command structure, action numbers, and device model. The binary CCA/CCX protocols are the RF/Thread transport for these same logical commands.
