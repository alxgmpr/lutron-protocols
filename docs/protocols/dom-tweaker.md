# The DOM Tweaker — live object writes on an RA3/HWQS processor

*How to change a project-database object on a running processor without a
database transfer and without a reboot.*

Reversed 2026-08-15 against HWQS firmware 26.05.26f000 (`lutron-core`,
`domain-object-manager.gobin`). Motivating goal was setting Sunnata keypad LED
intensity; see `ipl.md` §12A/§12B for why every IPL and device-config-session
route fails.

**Status: WORKING.** Live object writes commit successfully with no reboot and
no database transfer, and they drive the processor's cache refresh + device
record re-evaluation. See §6 for the `dto_type` encoding, which was the last
piece, and §10 for the (negative) result on LED intensity specifically.

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
   "OperationSessionId":"Proc-435-Op-9001"}}'
```

**Both args are required.** Omitting `OperationSessionId` fails at the JSON
layer with the unhelpful `Non-singleton parser exists but failed to parse JSON`
— that message means a *missing sibling field*, not a bad `TweakData` value.
This cost a lot of time; check both fields before suspecting the blob.

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

**Registered DTO types observed on 26.05.26f000:**
`2, 3, 4, 5, 9, 10, 15, 32, 34, 43, 44, 46, 57, 58, 60, 74, 77, 92, 94, 108`
— Area, SwitchLegController, ControlStation, ControlStationDevice,
ZoneControlUI, SwitchLeg, Zone, LinkNode, Link, Preset, PresetAssignment,
Processor, Button, EngravingPosition, SingleActionProgrammingModel,
AdvancedToggleProgrammingModel, MasterRaiseLowerProgrammingModel,
KeypadController, ButtonGroup, **LedController**.

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
| `tools/dom/extract-go-descriptors.py` | Pull embedded protobuf `FileDescriptorProto`s out of a Go binary and print services/messages/enums. Anchors on the `0x0A <len> <name>.proto` prefix and keeps the longest prefix that round-trips. |
| `tools/dom/build-tweak.py` | Build a base64 `Transaction` for `RequestDomManagedTweak` (hand-rolled protobuf; no deps). |

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
