#!/usr/bin/env python3
"""
dom-tweak — live object writes on an RA3/HWQS processor, no transfer, no reboot.

`RequestDomManagedTweak` is the only supported way to mutate a project-database
object at runtime. Editing the sqlite files under the running process changes
nothing: lutron-core holds its object model in memory and has no reload. A tweak
fires the object-change notifications that drive cache refresh, record
re-evaluation, and the device transfer that follows.

    dom-tweak.py types                       # registered DTO types + field maps
    dom-tweak.py fields 108                  # one type's fields
    dom-tweak.py show 108 2171               # current record, as proto values
    dom-tweak.py tweak 108 2171 \\
        --set default_status_on_intensity=100    # build + print, sends nothing
    dom-tweak.py tweak 108 2171 \\
        --set default_status_on_intensity=100 --apply   # commit
    dom-tweak.py enumerate --xid <any-valid-xid>        # sweep registered types

Safety
------
* Nothing is sent without `--apply`. The default builds the payload and stops.
* A tweaker Update **replaces** the object's record. This tool always composes
  the complete record from the current database row and applies `--set` on top,
  so untouched fields keep their values instead of resetting to proto3 defaults.
* `configuration_state_revision` is a concurrency token that rotates on every
  commit; it is re-read immediately before each tweak, never cached.
* Validation runs before commit, so a rejected payload touches nothing.

Every successful tweak advances ConfigurationStateRevision even when it writes
identical values, so Designer will see the project as changed and resync.

See docs/protocols/dom-tweaker.md.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import dom_proto  # noqa: E402
import dom_types  # noqa: E402
from dom_processor import (  # noqa: E402
    Processor,
    ProcessorError,
    compose_outcome,
    row_to_values,
)

DEFAULT_HOST = "phoenix"
DEFAULT_SESSION_PREFIX = "Proc-435-Op-"


def parse_set(pairs: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for pair in pairs:
        if "=" not in pair:
            raise SystemExit(f"--set expects field=value, got {pair!r}")
        key, value = pair.split("=", 1)
        key = key.strip()
        if not key:
            raise SystemExit(f"--set has an empty field name: {pair!r}")
        out[key] = value.strip()
    return out


def coerce(spec: dict, raw: str):
    """Turn a --set string into the field's declared type."""
    if spec["type"] in ("string", "bytes"):
        return raw
    try:
        return int(raw, 0)
    except ValueError as exc:
        raise SystemExit(
            f"{spec['name']} is {spec['type']}; {raw!r} is not an integer"
        ) from exc


def make_processor(args) -> Processor:
    return Processor(args.host, timeout=args.timeout)


# -- subcommands ----------------------------------------------------------


def cmd_types(args) -> int:
    print(f"{'type':>5}  {'description':<36} {'definition':<42} fields")
    for dto_type, desc, msg, count in dom_types.registered_table():
        shown = msg or "(no Definition in the DOM binary)"
        print(f"{dto_type:>5}  {desc:<36} {shown:<42} {count if count else '-'}")
    print(f"\n{len(dom_types.REGISTERED_DTO_TYPES)} registered types.")
    for dto_type, note in sorted(dom_types.UNREGISTERED_NOTES.items()):
        print(f"note: {dto_type} is NOT registered — {note}")
    return 0


def cmd_fields(args) -> int:
    fields = dom_types.fields_for_type(args.type)
    name = dom_types.definition_name(args.type)
    print(f"{name} ({dom_types.type_description(args.type)}), "
          f"athena table {dom_types.table_name(args.type)}\n")
    print(f"{'#':>3}  {'field':<38} {'type':<10} column")
    for spec in fields:
        print(
            f"{spec['number']:>3}  {spec['name']:<38} {spec['type']:<10} "
            f"{dom_types.column_name(spec['name'])}"
            + ("  [repeated — not encoded]" if spec.get("repeated") else "")
        )
    return 0


def _load_record(proc: Processor, dto_type: int, object_id: int):
    """Current record for an object, as a complete proto value map."""
    fields = dom_types.fields_for_type(dto_type)
    table = dom_types.table_name(dto_type)
    row = proc.object_row(table, object_id)

    xid_tables = proc.xid_tables()
    type_by_table = {
        dom_types.pascal_case(desc): num
        for num, desc in proc.object_type_names().items()
    }
    resolved: dict[int, tuple[str, str]] = {}

    def resolve(oid: int) -> tuple[str, str]:
        if oid not in resolved:
            resolved[oid] = proc.resolve_object(oid, tables=xid_tables)
        return resolved[oid]

    def xid_lookup(oid: int) -> str:
        return resolve(oid)[0]

    def type_lookup(oid: int) -> int:
        table_name = resolve(oid)[1]
        if table_name not in type_by_table:
            raise ProcessorError(
                f"no ObjectType maps to table {table_name}, so the *_type "
                "companion field cannot be derived"
            )
        return type_by_table[table_name]

    values = row_to_values(
        row, fields, xid_lookup=xid_lookup, type_lookup=type_lookup
    )
    return fields, row, values


def cmd_show(args) -> int:
    proc = make_processor(args)
    fields, row, values = _load_record(proc, args.type, args.object_id)
    xid = row["ExtendedObjectID"]
    print(
        f"{dom_types.definition_name(args.type)} "
        f"ObjectID={args.object_id} XID={xid}\n"
    )
    for spec in fields:
        if spec.get("repeated"):
            continue
        print(f"  {spec['name']:<38} = {values[spec['name']]!r}")
    return 0


def cmd_tweak(args) -> int:
    proc = make_processor(args)
    overrides = parse_set(args.set)
    if not overrides:
        raise SystemExit("nothing to change — pass at least one --set field=value")

    fields, row, values = _load_record(proc, args.type, args.object_id)
    by_name = {f["name"]: f for f in fields}

    unknown = set(overrides) - set(by_name)
    if unknown:
        raise SystemExit(
            f"no such field(s) on {dom_types.definition_name(args.type)}: "
            f"{', '.join(sorted(unknown))} "
            f"(try `dom-tweak.py fields {args.type}`)"
        )

    changes = []
    for name, raw in overrides.items():
        new = coerce(by_name[name], raw)
        old = values[name]
        changes.append((name, old, new))
        values[name] = new

    xid = row["ExtendedObjectID"]
    print(f"{dom_types.definition_name(args.type)} ObjectID={args.object_id} XID={xid}")
    for name, old, new in changes:
        marker = "" if old != new else "   (unchanged)"
        print(f"  {name}: {old!r} -> {new!r}{marker}")

    data = dom_proto.encode_definition(fields, values)

    # Re-read immediately before building: the token rotates on every commit.
    revision = proc.configuration_state_revision()
    session = args.session or f"{DEFAULT_SESSION_PREFIX}{args.object_id}"
    operation = dom_proto.build_operation(xid, args.type, data)
    blob = dom_proto.encode_tweak_data(session, revision, [operation])

    print(f"\nconfiguration_state_revision = {revision}")
    print(f"operation_session_id         = {session}")
    print(f"TweakData ({len(blob)} chars) = {blob}")

    if not args.apply:
        print(
            "\nNot sent. This was a build-only run; add --apply to commit.\n"
            "The complete record was composed from the current row, so the "
            "fields above are the only ones that change."
        )
        return 0

    mark = proc.dom_log_mark()
    core_output = proc.request_tweak(blob, session)
    outcome = compose_outcome(core_output, proc.dom_log_since(mark))

    print(f"\n{outcome.summary()}")
    if args.verbose or not outcome.ok:
        for line in outcome.dom_log:
            print(f"  dom| {line}")
        if core_output.strip():
            for line in core_output.splitlines():
                print(f"  core| {line}")
    if outcome.ok:
        print(f"new revision = {proc.configuration_state_revision()}")
    return 0 if outcome.ok else 1


def cmd_enumerate(args) -> int:
    """
    Sweep dto_type and classify the DOM log to rediscover the registered set.

    Cheap and safe: an unregistered type fails at deserialization and a
    registered one fails at the XID lookup, so neither reaches the database.
    Registered types are the ones that get far enough to report
    `reading object ID for XID <x> with ObjectType 0xNN`.
    """
    proc = make_processor(args)
    revision = proc.configuration_state_revision()
    registered: list[int] = []

    for dto_type in range(args.start, args.end + 1):
        session = f"{DEFAULT_SESSION_PREFIX}sweep-{dto_type}"
        operation = dom_proto.build_operation(args.xid, dto_type, b"")
        blob = dom_proto.encode_tweak_data(session, revision, [operation])

        mark = proc.dom_log_mark()
        proc.request_tweak(blob, session)
        lines = proc.dom_log_since(mark)

        text = "\n".join(lines)
        if "DTOType not registered" in text:
            verdict = "unregistered"
        elif "reading object ID for XID" in text or "no rows in result set" in text:
            verdict = "REGISTERED"
            registered.append(dto_type)
        else:
            verdict = "?"
        if verdict != "unregistered" or args.verbose:
            print(f"{dto_type:>4}: {verdict}")

    print(f"\nregistered: {', '.join(str(t) for t in registered) or '(none)'}")
    return 0


# -- entry point ----------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    # Shared options live on a parent parser so they work either side of the
    # subcommand — `-v tweak ...` and `tweak ... -v` both being natural to type.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--host", default=DEFAULT_HOST, help="processor ssh host")
    common.add_argument("--timeout", type=int, default=30, help="ssh timeout (s)")
    common.add_argument("-v", "--verbose", action="store_true")

    ap = argparse.ArgumentParser(
        prog="dom-tweak.py",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
        parents=[common],
    )
    sub = ap.add_subparsers(dest="command", required=True)

    p = sub.add_parser("types", help="list registered DTO types", parents=[common])
    p.set_defaults(func=cmd_types)

    p = sub.add_parser(
        "fields", help="show a type's Definition fields", parents=[common]
    )
    p.add_argument("type", type=int)
    p.set_defaults(func=cmd_fields)

    p = sub.add_parser(
        "show", help="read an object's current record", parents=[common]
    )
    p.add_argument("type", type=int)
    p.add_argument("object_id", type=int)
    p.set_defaults(func=cmd_show)

    p = sub.add_parser("tweak", help="change fields on one object", parents=[common])
    p.add_argument("type", type=int)
    p.add_argument("object_id", type=int)
    p.add_argument(
        "--set",
        action="append",
        default=[],
        metavar="FIELD=VALUE",
        help="repeatable; applied on top of the current record",
    )
    p.add_argument("--session", help="OperationSessionId (default: derived)")
    p.add_argument(
        "--apply",
        action="store_true",
        help="actually commit; without this the payload is built and printed only",
    )
    p.set_defaults(func=cmd_tweak)

    p = sub.add_parser(
        "enumerate",
        help="sweep dto_type to find registered types",
        parents=[common],
    )
    p.add_argument("--xid", required=True, help="any valid ExtendedObjectID")
    p.add_argument("--start", type=int, default=0)
    p.add_argument("--end", type=int, default=260)
    p.set_defaults(func=cmd_enumerate)

    return ap


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except (ProcessorError, dom_types.UnknownTypeError, dom_proto.ProtoEncodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
