#!/usr/bin/env python3
"""
Extract embedded protobuf FileDescriptorProtos from a Go binary.

protobuf-go embeds each .proto as a raw serialized FileDescriptorProto byte
slice. Field 1 of FileDescriptorProto is `name` (string), so every descriptor
starts with 0x0A <varint len> <filename>. We anchor on that, then grow the
buffer until FileDescriptorProto.ParseFromString accepts it and the parsed
name matches — protobuf will happily parse a truncated-at-a-field-boundary
message, so we take the LONGEST prefix that parses and still round-trips to
the same byte length.
"""
import sys, re
from google.protobuf import descriptor_pb2

data = open(sys.argv[1], "rb").read()
want = sys.argv[2] if len(sys.argv) > 2 else None


def varint(buf, i):
    shift = 0
    val = 0
    while i < len(buf):
        b = buf[i]
        val |= (b & 0x7F) << shift
        i += 1
        if not (b & 0x80):
            return val, i
        shift += 7
        if shift > 35:
            break
    return None, i


found = {}
for m in re.finditer(rb"\x0a", data):
    start = m.start()
    ln, j = varint(data, start + 1)
    if not ln or ln < 5 or ln > 200:
        continue
    name = data[j : j + ln]
    if not name.endswith(b".proto"):
        continue
    try:
        nm = name.decode("ascii")
    except UnicodeDecodeError:
        continue
    if not re.fullmatch(r"[A-Za-z0-9_./-]+", nm):
        continue
    if want and want not in nm:
        continue

    # Grow until we find the longest prefix that parses cleanly and consumes
    # everything we hand it.
    best = None
    lo = j + ln
    for end in range(lo, min(lo + 400_000, len(data))):
        chunk = data[start:end]
        fdp = descriptor_pb2.FileDescriptorProto()
        try:
            n = fdp.ParseFromString(chunk)
        except Exception:
            continue
        if n != len(chunk):
            continue
        if fdp.name != nm:
            continue
        best = (chunk, fdp)
    if best and (nm not in found or len(best[0]) > len(found[nm][0])):
        found[nm] = best

for nm, (chunk, fdp) in sorted(found.items()):
    print(f"=== {nm}  ({len(chunk)} bytes) ===")
    print(f"package: {fdp.package}")
    for svc in fdp.service:
        print(f"  service {svc.name}")
        for mth in svc.method:
            print(f"    rpc {mth.name}({mth.input_type}) returns ({mth.output_type})")
    for mt in fdp.message_type:
        print(f"  message {mt.name}")
        for f in mt.field:
            tn = f.type_name or descriptor_pb2.FieldDescriptorProto.Type.Name(f.type)
            lbl = descriptor_pb2.FieldDescriptorProto.Label.Name(f.label).replace(
                "LABEL_", ""
            ).lower()
            print(f"    {lbl} {tn} {f.name} = {f.number};")
    for en in fdp.enum_type:
        print(f"  enum {en.name}")
        for v in en.value:
            print(f"    {v.name} = {v.number};")
