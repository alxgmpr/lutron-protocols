# The DOM Tweaker — live object writes on an RA3/HWQS processor

*How to change a project-database object on a running processor without a
database transfer and without a reboot.*

Reversed 2026-08-15 against HWQS firmware 26.05.26f000 (`lutron-core`,
`domain-object-manager.gobin`). Motivating goal was setting Sunnata keypad LED
intensity; see `ipl.md` §12A/§12B for why every IPL and device-config-session
route fails.

**Status: WORKING, and productized as `tools/dom/dom_tweak.py` (§7).** Live
object writes commit successfully with no reboot and no database transfer, and
they drive the processor's cache refresh + device record re-evaluation. See §6
for the `dto_type` encoding, which was the last piece, and §10 for the
(negative) result on LED intensity specifically.

Two things will bite you before anything else, both covered below: an Update
**replaces** the whole record (§4), and `lutron-core-client -d` is
**fire-and-forget** unless you pass `-o` (§3).

---

## 1. Why this path exists

`lutron-core` holds its object model and all device-record transfer state **in
memory**. Editing `/var/db/lutron-athena-db.sqlite` or
`lutron-phoenix-processor-db.sqlite` under the running process changes nothing
— there is no reload or cache-refresh command in the binary. The only
supported way to mutate an object at runtime is the **tweaker**, which fires
the object-change notifications that drive cache refresh, record
re-serialization, and the subsequent device transfer.

Enabled by `/etc/lutron.d/dom-object-manager.conf` → `"UseDomManagedTweaking": true`
(on by default). DOM logs `Tweaking from DomainObjectManager has been enabled`
at startup.

## 2. Architecture

```
client ──IPC──> lutron-core                       (/tmp/lutron-core.sock)
                RequestDomManagedTweak
                  ├─ tweaker-receiver: validate  ──gRPC──> DOM
                  │    ValidateExternalObjectChanges        (@dom-api, abstract unix socket)
                  └─ tweaker-receiver: commit    ──gRPC──> DOM
                       ApplyExternalObjectChanges
```

`domain-object-manager.gobin` serves gRPC on the **abstract** unix socket
`@dom-api` (connect with `socket.AF_UNIX` to `"\0dom-api"`; python3 is present
on the processor and connects fine). No gRPC server reflection is registered.

Relevant service:
```proto
// polaris/dom/dataprovider/v1/external_object_changes.proto
service ExternalObjectChangesAPI {
  rpc ValidateExternalObjectChanges(ValidateExternalObjectChangesRequest)
      returns (ValidateExternalObjectChangesResponse);
  rpc ApplyExternalObjectChanges(ApplyExternalObjectChangesRequest)
      returns (ApplyExternalObjectChangesResponse);
}
message ValidateExternalObjectChangesRequest { bytes object_data = 1; }
message ApplyExternalObjectChangesRequest {
  bytes  object_data = 1;
  string new_configuration_state_revision = 2;
}
```
`object_data` is byte-identical to the IPC `TweakData` blob.

## 3. The IPC command

```sh
lutron-core-client -d '{"cmd":"RequestDomManagedTweak","args":{
   "TweakData":"<base64 Transaction>",
   "OperationSessionId":"Proc-435-Op-9001"}}' \
  -o '{"cmd":"DomManagedTweakResponse"}' -t 20
```

**Both args are required.** Omitting `OperationSessionId` fails at the JSON
layer with the unhelpful `Non-singleton parser exists but failed to parse JSON`
— that message means a *missing sibling field*, not a bad `TweakData` value.
This cost a lot of time; check both fields before suspecting the blob.

### `-d` alone is fire-and-forget — you must pass `-o`

`lutron-core-client -d …` queues the write, exits **0**, and prints **nothing**.
The tweak still commits. Without `-o` you therefore cannot tell success from
failure, and the natural reading of the silence — "it did nothing" — is exactly
wrong.

`-o '<RESPONSE>'` blocks until a matching response arrives and prints it:

```json
{"cmd":"DomManagedTweakResponse","args":{"OperationSessionId":"Proc-435-Op-2171","Result":1}}
```

`Result` is the authoritative verdict: `0` = SUCCESS, `1` = FAILURE,
`2` = BUSY_ERROR, `5` = INTERNAL_ERROR. Pair `-o` with `-t <seconds>`, and keep
that below any ssh timeout wrapping it — otherwise ssh kills the client
mid-wait and the result is lost even though the tweak committed.

## 4. TweakData — the Transaction

Schema recovered from the descriptor embedded in the Go binary,
`provider/tweaker/internal/proto/tweakerproto/v1/transaction.proto`:

```proto
message Create { string owning_object_xid = 1; string dto_type = 2; bytes data = 3; }
message Update { string owning_object_xid = 1; string dto_type = 2; bytes data = 3; }
message Delete { string owning_object_xid = 1; string dto_type = 2; }
message SingleOperation { Create create = 1; Update update = 2; Delete delete = 3; }
message Transaction {
  string operation_session_id = 1;
  string configuration_state_revision = 2;
  repeated SingleOperation operations = 3;
}
```

* `owning_object_xid` — the object's `ExtendedObjectID` from the athena DB
  (e.g. `Led.ExtendedObjectID` = `w_VLl6v1RZOr5U8sjtAAwA`), **not** the numeric
  ObjectID.
* `configuration_state_revision` — must equal the **current**
  `DatabaseMetadata.ConfigurationStateRevision` in
  `/var/db/lutron-athena-db.sqlite`. Supplying a fresh value is rejected with
  `expected ConfigurationStateRevision "X" does not match current "Y"`, so this
  is a concurrency token, not the new revision to write.
* `data` — the serialized `*Definition` proto for that object type.

### An Update REPLACES the record — compose it whole

`Update.data` is the object's complete new `*Definition`, not a patch. A field
you leave out is not "left alone"; it decodes to the proto3 default and
overwrites what was there. This is the same trap as a CoAP `PUT` on a CCX
config bucket (`ccx/coap.md`), and it destroys neighbouring fields silently —
the tweak still reports `SUCCESS`.

So always read the object's current row first, apply the change on top, and
send all fields. `dom-tweak.py` does this for you and refuses to encode a
partial record. Verified on LedController 2171: a tweak setting one field to a
*different* value left the other 16 columns byte-identical, and a no-op tweak
left the whole row unchanged.

## 5. Object DTO protos

Every domain object has a `<Name>Definition` message in
`domainobject/dto/v1/<name>.proto`, all embedded in the Go binary. Example:

```proto
message LedDefinition {          // domainobject/dto/v1/led.proto
  string parent_xid = 1;  uint32 parent_type = 2;  int32  sort_order = 3;
  uint32 device_component_number = 4;    uint32 comm_master_component_number = 5;
  string comm_master_device_xid = 6;     uint32 comm_master_device_type = 7;
  uint32 status_on_intensity = 8;        uint32 nightlight_intensity = 9;
  uint32 led_number = 10;                uint32 led_info_id = 11;
  uint32 led_number_on_link = 12;        uint32 active_led_state = 13;
  uint32 inactive_led_state = 14;        string ref_prog_model_xid = 15;
  uint32 ref_prog_model_type = 16;       uint32 led_type = 17;
}
```
`LedControllerDefinition` similarly carries `default_status_on_intensity`,
`default_nightlight_intensity` and the four flash timings.

Extract any of them with `tools/dom/extract-go-descriptors.py` (§7).

## 6. `dto_type` is the DECIMAL OBJECT TYPE, as a string

Not a type name. `dto_type = "108"` for a LedController, `"5"` for a
ControlStationDevice, and so on — the same numbering as Designer's `ObjectType`
enum. Every name-shaped spelling is rejected:
```
ApplyExternalObjectChanges: deserializing tweaked data into tx:
  dto: DTOType not registered: "LedDefinition"
```
A registered type instead gets past deserialization into real work, which is
how the set below was enumerated (send a deliberately mismatched XID and read
the type back out of the error):
```
applyChanges: reading object ID for XID <xid> with ObjectType 0x006C: sql: no rows in result set
```

**Registered DTO types observed on 26.05.26f000** — names are the processor's
own, from the athena `ObjectType` table, and 19 of the 20 have a `*Definition`
message in the DOM binary:

| Type | ObjectType.Description | `*Definition` | Fields |
|-----:|------------------------|---------------|-------:|
| 2 | AREA | AreaDefinition | 43 |
| 3 | SWITCH_LEG_CONTROLLER | SwitchLegControllerDefinition | 14 |
| 4 | CONTROL_STATION | ControlStationDefinition | 11 |
| 5 | CONTROL_STATION_DEVICE | ControlStationDeviceDefinition | 33 |
| 9 | ZONE_CONTROLLER_UI | ZoneControllerUserInterfaceDefinition | 25 |
| 10 | SWITCH_LEG | SwitchLegDefinition | 31 |
| 15 | ZONE | ZoneDefinition | 14 |
| 32 | LINK_NODE | LinkNodeDefinition | 9 |
| 34 | LINK | LinkDefinition | 15 |
| 43 | PRESET | PresetDefinition | 6 |
| 44 | PRESET_ASSIGNMENT | PresetAssignmentDefinition | 7 |
| 46 | PROCESSOR | ProcessorDefinition | 33 |
| 57 | BUTTON | ButtonDefinition | 31 |
| 58 | ENGRAVING_POSITION | EngravingPositionDefinition | 10 |
| 60 | SINGLE_ACTION_PROGRAMMING_MODEL | SingleActionProgrammingModelDefinition | 16 |
| 74 | ADVANCED_TOGGLE_PROGRAMMING_MODEL | AdvancedToggleProgrammingModelDefinition | 17 |
| 77 | MASTER_RAISE_LOWER_PROGRAMMING_MODEL | *(none in the binary)* | — |
| 92 | BUTTON_CONTROLLER | ButtonControllerDefinition | 10 |
| 94 | BUTTON_GROUP | ButtonGroupDefinition | 19 |
| 108 | LED_CONTROLLER | **LedControllerDefinition** | 15 |

> Two names in the first pass of this document were wrong and are corrected
> above: **92 is `BUTTON_CONTROLLER`**, not "KeypadController", and **9 is
> `ZONE_CONTROLLER_UI`**, not "ZoneControlUI". Both came from guessing at the
> number rather than reading the processor's `ObjectType` table:
> `SELECT ObjectTypeID, Description FROM ObjectType`.
>
> Type **77** is registered for tweaking but has no `*Definition` message
> anywhere in `domain-object-manager.gobin`, so no payload can be built for it.

> **`107` (Led) is NOT a registered DTO type.** Individual LEDs cannot be
> tweaked; only the parent `LedController` (108) can.

Enumerating this from scratch is cheap and safe — sweep `dto_type` over
`"0".."260"` with any valid XID and classify the DOM log lines. Deserialization
failures never touch the database.

## 6a. `configuration_state_revision` rotates on every commit

Each successful tweak writes a **new** `DatabaseMetadata.ConfigurationStateRevision`.
The next transaction must carry the new value, so re-read it between tweaks:
```sh
sqlite3 /var/db/lutron-athena-db.sqlite 'SELECT ConfigurationStateRevision FROM DatabaseMetadata'
```
Reusing a stale one fails the concurrency check; a made-up one is rejected
outright.

## 6b. What a successful tweak looks like

```
Info: Validation completed with success: TweakerSessionID={...}
Info: Tweaker command execution completed: TweakerSessionID={...}, Result={0x0(0)}
Info: Completed database update: TweakerSessionID={...}, UpdateSuccess={true}
Info: Tweak completed with success: TweakerSessionID={...}
[CORE][FEATURE]: {"Tweaker":{"Result":"SUCCESS(0)"}}
Debug: Broadcasting: {"cmd":"DomManagedTweakResponse","args":{...,"Result":0}}
```
and immediately afterwards the pipeline this whole exercise was chasing:
```
Info: Starting cache refresh: NewObjectCount={0}, UpdatedObjectCount={1}, OperationSessionId={...}
Info: Starting record re-evaluation as part of cache refresh
Info: phoenix-component-device-record-manager: Record re-evaluation completed successfully!
Info: Cache refresh operation completed: Status={0}
Info: device-transfer-tracker: New device upload session created: CommandMetadata={'Core Cache Refresh',...}, DeviceIds={...}
```
`DeviceIds={}` means re-evaluation found no record whose serialization actually
changed — i.e. the field you edited is not part of any transferred device
record.

Note `Result={0x1(1)}` at the *execution* step (rather than `0x0`) is the
failure case and is followed by `Failed to start database update`.

## 7. Tooling

| Tool | Purpose |
|------|---------|
| **`tools/dom/dom_tweak.py`** | **The CLI.** Reads the current record, applies `--set` on top, re-reads the revision, builds the Transaction, sends it, and reads the verdict back. Nothing is sent without `--apply`. |
| `tools/dom/dom_proto.py` | Wire encoding: varints, `*Definition` serialization, `SingleOperation`/`Transaction`. Pure and dependency-free. |
| `tools/dom/dom_types.py` | The registered `dto_type` table and the type → `*Definition` field maps. |
| `tools/dom/dom_processor.py` | SSH transport: revision reads, XID resolution, the IPC call, DOM-log classification. |
| `tools/dom/extract_dto_defs.py` | Generates `dto_definitions.json` from the Go binary. Walks the protobuf wire format to find each descriptor's end in one pass — a whole-binary sweep takes ~0.4 s. |
| `tools/dom/extract-go-descriptors.py` | Older, general descriptor dumper: prints services/messages/enums for one named `.proto`. Finds a descriptor's end by growing the buffer a byte at a time, so it is far slower but needs no assumptions about field layout. |
| `tools/dom/dom-api-relay.py` | TCP → `@dom-api` relay for talking gRPC to DOM directly. Self-terminating after `ttl` seconds so it can never be left running on the processor. |
| `tools/dom/dom-grpc-client.py` | Raw-bytes gRPC client used to probe DOM services through the relay. |

```sh
# what can be tweaked, and what fields each type has
tools/dom/dom_tweak.py types
tools/dom/dom_tweak.py fields 108

# read an object's current record as proto values
tools/dom/dom_tweak.py show 108 2171

# build the payload and stop (default — sends nothing)
tools/dom/dom_tweak.py tweak 108 2171 --set default_nightlight_intensity=40

# commit it
tools/dom/dom_tweak.py tweak 108 2171 --set default_nightlight_intensity=40 --apply
```

Regenerate the field maps after a firmware change:

```sh
scp phoenix:/usr/sbin/domain-object-manager.gobin /tmp/
uv run --with protobuf python tools/dom/extract_dto_defs.py \
    /tmp/domain-object-manager.gobin -o tools/dom/dto_definitions.json
```

Tests: `python3 -m unittest discover -s tools/dom -t tools/dom` (53, no processor needed).

### Re-enumerating the registered types

`dom_tweak.py enumerate --xid <any-valid-xid>` sweeps `dto_type` over a range
and classifies the DOM log for each. This is cheap and safe: an unregistered
type fails at deserialization and a registered one fails at the XID lookup, so
neither reaches the database.

```
dto: DTOType not registered: "..."                       -> not registered
applyChanges: reading object ID for XID <x> with ObjectType 0x006C   -> REGISTERED
```

## 8. Log oracles

Two logs, both essential — the DOM one carries the precise reason:

`/var/log/core` (needs debug on):
```
Preparing for tweak as leader in single-proc system; RequestedTweak={0x29(41)}
Validation completed with success: TweakerSessionID={...}
Failed to start database update: TweakerSessionID={...}      <- DOM rejected the apply
Tweaker lockout state ended: TweakerSessionID={...}          <- session released
```

`/var/log/domain-object-manager` (always on):
```
ValidateExternalObjectChanges: unmarshaling transaction data: proto: cannot parse invalid wire-format data
ApplyExternalObjectChanges: deserializing tweaked data into tx: dto: DTOType not registered: "..."
expected ConfigurationStateRevision "A" does not match current "B"
```

Tweak result codes: `BUSY_ERROR(2)` (a prior session's lockout is still
draining — wait a few seconds), `INTERNAL_ERROR(5)`, plus
`TWEAK_PARTIALLY_APPLIED` and `ANOTHER_TWEAK_IN_PROGRESS` in the Go enum.

Enable core debug logging at runtime (no restart), and **turn it back off**:
```sh
lutron-core-client -d '{"cmd":"RequestUpdateLoggingSettings","args":{"DebugEnabled":true}}'
```

## 9. Safety notes

* The tweaker **validates before it commits**. A malformed or unregistered
  transaction is rejected in the validate phase and touches nothing — all the
  probing above left the database byte-identical.
* `RequestPrepareForForcedFullTransfer` exists and would force records out, but
  its own log says it must "delete all device records" — a whole-system
  re-transfer. Not a per-object lever.
* Back both DBs up online before experimenting; `cp` on a live sqlite file can
  tear:
  ```sh
  sqlite3 /var/db/lutron-athena-db.sqlite ".backup '/var/misc_unsynced/bk/athena-pre.sqlite'"
  ```
* Every successful tweak advances `ConfigurationStateRevision`, even one that
  writes identical values. That is normal bookkeeping, but Designer will see
  the project as changed on its next connect and resync.

---

## 10. Result for keypad LED intensity: still negative

The tweaker works, but it does not get LED intensity to a Sunnata keypad,
because none of the candidate fields are part of any transferred device record:

| Field | Tweakable? | In the device record? |
|-------|-----------|----------------------|
| `Led.StatusOnIntensity` / `NightlightIntensity` (type 107) | **No** — 107 isn't a registered DTO type | No (proven across a reboot, §12B of `ipl.md`) |
| `LedController.DefaultStatusOnIntensity` / `DefaultNightlightIntensity` (type 108) | **Yes** — commits live | **No** |

Verified directly: tweaking LedController 2171's
`default_nightlight_intensity` 0 → 40 and `default_status_on_intensity`
1 → 100 both committed with `SUCCESS(0)` and triggered cache refresh + record
re-evaluation, yet the type-108 record checksum stayed
`AB2D9351D26243B2161DC849A38058DE`, `ActionRequiredID` stayed 0, the upload
session carried `DeviceIds={}`, and no CLAP frame referencing the keypad serial
appeared on link 0. Restored to `0 / 1` afterwards.

So on 26.x these DB columns are Designer-side bookkeeping that the processor
never pushes to CCX keypads by this route. What remains untested is whether the
intensity reaches the device only during **full OOB provisioning**
(`DeviceStatusRecord.IsPartialOOBRequired`), which is the CCX `AHA` write the
device actually consumes.

**The tweaker itself is the reusable win** — a supported, live, no-reboot,
schedulable write path to any of the 20 registered object types.
