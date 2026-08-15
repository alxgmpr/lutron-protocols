#!/usr/bin/env python3
"""
Minimal gRPC client for the DOM API. Uses raw byte serializers so no generated
stubs are needed — the wire messages are hand-encoded from the descriptors
extracted out of domain-object-manager.gobin.
"""
import sys

import grpc


def varint(n):
    out = b""
    while True:
        b = n & 0x7F
        n >>= 7
        out += bytes([b | (0x80 if n else 0)])
        if not n:
            return out


def tag(f, w):
    return varint((f << 3) | w)


def vf(f, v):
    return tag(f, 0) + varint(v)


def lf(f, v):
    if isinstance(v, str):
        v = v.encode()
    return tag(f, 2) + varint(len(v)) + v


def create_alias_request(alias: str, object_type: int, object_xid: str, req_id: str):
    object_identifier = lf(2, object_xid)                       # ObjectIdentifier.object_xid
    object_reference = vf(1, object_type) + lf(2, object_identifier)
    definition = lf(1, alias) + lf(2, object_reference)         # ObjectAliasCreateDefinition
    unique_id = lf(1, req_id)                                   # UniqueID.value
    return lf(1, definition) + lf(2, unique_id)                 # ObjectAliasAPICreateRequest


def hexdump(b):
    return b.hex() if b else "(empty)"


def main():
    target = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1:19090"
    alias = sys.argv[2] if len(sys.argv) > 2 else "zzprobe-capture"
    obj_type = int(sys.argv[3]) if len(sys.argv) > 3 else 107
    obj_xid = sys.argv[4] if len(sys.argv) > 4 else "w_VLl6v1RZOr5U8sjtAAwA"

    req = create_alias_request(alias, obj_type, obj_xid, "probe-req-1")
    print(f"request bytes: {hexdump(req)}")

    ch = grpc.insecure_channel(target)
    grpc.channel_ready_future(ch).result(timeout=15)
    print("channel ready")

    call = ch.unary_unary(
        "/polaris.dom.objects.ObjectAliasAPI/Create",
        request_serializer=lambda b: b,
        response_deserializer=lambda b: b,
    )
    try:
        resp = call(req, timeout=30)
        print(f"OK response: {hexdump(resp)}")
        try:
            print("ascii:", resp.decode("latin1"))
        except Exception:
            pass
    except grpc.RpcError as e:
        print(f"RPC FAILED code={e.code()} details={e.details()}")


main()
