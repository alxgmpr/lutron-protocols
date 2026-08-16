#!/usr/bin/env python3
"""
Extract every `<Name>Definition` message from the protobuf descriptors embedded
in domain-object-manager.gobin, and emit the field maps the tweaker needs.

Why this exists separately from extract-go-descriptors.py: that script finds the
end of a descriptor by growing the buffer one byte at a time and re-parsing
(up to 400 KB per candidate). That is fine for one known file and far too slow
for a whole-binary sweep. Here we walk the protobuf wire format directly to find
each descriptor's true end in one pass, which turns a whole-binary extraction
from many minutes into about a second.

  usage: extract_dto_defs.py <gobin> [-o dto_definitions.json]

Output is the generated data behind dom_types.py. Regenerate it when the
processor firmware changes; see docs/protocols/dom-tweaker.md § 7.
"""

import argparse
import json
import re
import sys

try:
    from google.protobuf import descriptor_pb2
except ImportError:
    sys.exit("needs protobuf: uv run --with protobuf extract_dto_defs.py ...")

# FileDescriptorProto field numbers → wire type we expect to see.
# 1 name, 2 package, 3 dependency, 4 message_type, 5 enum_type, 6 service,
# 7 extension, 8 options, 9 source_code_info, 10 public_dependency,
# 11 weak_dependency, 12 syntax, 13 edition.
_LEN_FIELDS = {1, 2, 3, 4, 5, 6, 7, 8, 9, 12}
_VARINT_FIELDS = {10, 11, 13}
# public_dependency/weak_dependency may also arrive packed (wire type 2).
_PACKABLE = {10, 11}

_PROTO_TYPE = descriptor_pb2.FieldDescriptorProto.Type


def read_varint(buf: bytes, i: int):
    """Return (value, next_index), or (None, i) if malformed."""
    shift = 0
    val = 0
    while i < len(buf):
        b = buf[i]
        val |= (b & 0x7F) << shift
        i += 1
        if not (b & 0x80):
            return val, i
        shift += 7
        if shift > 63:
            break
    return None, i


def descriptor_end(data: bytes, start: int) -> int:
    """
    Walk top-level FileDescriptorProto fields from `start` and return the offset
    one past the last valid one. Stops at the first tag that could not belong to
    a FileDescriptorProto, which is where the embedded blob ends.
    """
    i = start
    while i < len(data):
        tag, j = read_varint(data, i)
        if tag is None or tag == 0:
            break
        field, wire = tag >> 3, tag & 7

        if wire == 2 and (field in _LEN_FIELDS or field in _PACKABLE):
            ln, k = read_varint(data, j)
            if ln is None or k + ln > len(data):
                break
            i = k + ln
        elif wire == 0 and field in _VARINT_FIELDS:
            val, k = read_varint(data, j)
            if val is None:
                break
            i = k
        else:
            break
    return i


def parse_descriptors(data: bytes, path_filter: str | None):
    """Yield every FileDescriptorProto embedded in `data`."""
    seen: dict[str, descriptor_pb2.FileDescriptorProto] = {}

    for m in re.finditer(rb"\x0a", data):
        start = m.start()
        ln, j = read_varint(data, start + 1)
        if not ln or ln < 5 or ln > 200:
            continue
        raw_name = data[j : j + ln]
        if not raw_name.endswith(b".proto"):
            continue
        try:
            name = raw_name.decode("ascii")
        except UnicodeDecodeError:
            continue
        if not re.fullmatch(r"[A-Za-z0-9_./-]+", name):
            continue
        if path_filter and path_filter not in name:
            continue

        end = descriptor_end(data, start)
        chunk = data[start:end]
        fdp = descriptor_pb2.FileDescriptorProto()
        try:
            if fdp.ParseFromString(chunk) != len(chunk) or fdp.name != name:
                continue
        except Exception:
            continue

        # A file can appear more than once; keep the richest copy.
        prev = seen.get(name)
        if prev is None or len(fdp.message_type) > len(prev.message_type):
            seen[name] = fdp

    return seen


def field_entry(f) -> dict:
    """One protobuf field, reduced to what an encoder needs."""
    type_name = f.type_name.lstrip(".") if f.type_name else _PROTO_TYPE.Name(f.type)
    return {
        "name": f.name,
        "number": f.number,
        "type": _PROTO_TYPE.Name(f.type).replace("TYPE_", "").lower(),
        "type_name": type_name if f.type_name else None,
        "repeated": f.label == descriptor_pb2.FieldDescriptorProto.LABEL_REPEATED,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("gobin", help="path to domain-object-manager.gobin")
    ap.add_argument("-o", "--out", help="write JSON here (default: stdout)")
    ap.add_argument(
        "--filter",
        default="domainobject/dto/v1/",
        help="only descriptors whose path contains this (default: the DTO dir)",
    )
    ap.add_argument(
        "--suffix",
        default="Definition",
        help="only messages whose name ends with this (default: Definition)",
    )
    args = ap.parse_args()

    with open(args.gobin, "rb") as fh:
        data = fh.read()

    files = parse_descriptors(data, args.filter or None)

    messages: dict[str, dict] = {}
    for name, fdp in sorted(files.items()):
        for mt in fdp.message_type:
            if args.suffix and not mt.name.endswith(args.suffix):
                continue
            messages[mt.name] = {
                "proto": name,
                "package": fdp.package,
                "fields": [field_entry(f) for f in mt.field],
            }

    out = {
        "source": args.gobin.rsplit("/", 1)[-1],
        "descriptor_files": len(files),
        "messages": messages,
    }
    text = json.dumps(out, indent=2, sort_keys=True) + "\n"

    if args.out:
        with open(args.out, "w") as fh:
            fh.write(text)
        print(
            f"{len(files)} descriptors, {len(messages)} *{args.suffix} messages "
            f"-> {args.out}",
            file=sys.stderr,
        )
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
