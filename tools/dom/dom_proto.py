"""
Protobuf wire encoding for the DOM tweaker.

Hand-rolled rather than generated: the processor's descriptors are recovered
from a stripped Go binary, and taking a protoc/grpcio dependency to encode a
handful of flat messages would make the tool harder to run than the thing it
replaces. Everything here is pure and dependency-free so it unit-tests on the
host.

Schemas — provider/tweaker/internal/proto/tweakerproto/v1/transaction.proto:

    message Create { string owning_object_xid = 1; string dto_type = 2; bytes data = 3; }
    message Update { string owning_object_xid = 1; string dto_type = 2; bytes data = 3; }
    message Delete { string owning_object_xid = 1; string dto_type = 2; }
    message SingleOperation { Create create = 1; Update update = 2; Delete delete = 3; }
    message Transaction {
      string operation_session_id = 1;
      string configuration_state_revision = 2;
      repeated SingleOperation operations = 3;
    }

See docs/protocols/dom-tweaker.md.
"""

from __future__ import annotations

import base64
from typing import Any, Iterable, Mapping, Sequence

# Wire types
WIRE_VARINT = 0
WIRE_LEN = 2

# Field numbers inside Create/Update/Delete
_F_OWNING_XID = 1
_F_DTO_TYPE = 2
_F_DATA = 3

# SingleOperation field numbers
OP_CREATE = 1
OP_UPDATE = 2
OP_DELETE = 3

# Transaction field numbers
_F_SESSION_ID = 1
_F_CONFIG_REV = 2
_F_OPERATIONS = 3

# Proto scalar types we encode as varints. Everything else in the DTO
# definitions is a string or bytes (length-delimited).
_VARINT_TYPES = {
    "int32",
    "int64",
    "uint32",
    "uint64",
    "bool",
    "enum",
}
_SIGNED_TYPES = {"int32", "int64", "sint32", "sint64"}
_LEN_TYPES = {"string", "bytes", "message"}


class ProtoEncodeError(ValueError):
    """A value could not be encoded for its declared field type."""


def varint(n: int) -> bytes:
    """Encode an unsigned varint. Negative ints use two's-complement 64-bit,
    matching protobuf's encoding of negative int32/int64."""
    if n < 0:
        n += 1 << 64
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        out.append(b | (0x80 if n else 0))
        if not n:
            return bytes(out)


def tag(field: int, wire: int) -> bytes:
    return varint((field << 3) | wire)


def varint_field(field: int, value: int) -> bytes:
    return tag(field, WIRE_VARINT) + varint(value)


def len_field(field: int, value: bytes | str) -> bytes:
    if isinstance(value, str):
        value = value.encode("utf-8")
    return tag(field, WIRE_LEN) + varint(len(value)) + value


def read_varint(buf: bytes, i: int) -> tuple[int, int]:
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
    raise ProtoEncodeError("truncated varint")


def encode_field(spec: Mapping[str, Any], value: Any) -> bytes:
    """Encode one field of a *Definition message from its descriptor entry."""
    ftype = spec["type"]
    number = spec["number"]

    if ftype in _VARINT_TYPES:
        if isinstance(value, bool):
            value = int(value)
        if not isinstance(value, int):
            raise ProtoEncodeError(
                f"field {spec['name']} is {ftype}, got {type(value).__name__}"
            )
        if ftype not in _SIGNED_TYPES and value < 0:
            raise ProtoEncodeError(
                f"field {spec['name']} is unsigned {ftype}, got {value}"
            )
        return varint_field(number, value)

    if ftype in _LEN_TYPES:
        if isinstance(value, (bytes, bytearray)):
            return len_field(number, bytes(value))
        if isinstance(value, str):
            return len_field(number, value)
        raise ProtoEncodeError(
            f"field {spec['name']} is {ftype}, got {type(value).__name__}"
        )

    raise ProtoEncodeError(f"unsupported field type {ftype!r} on {spec['name']}")


def encode_definition(
    fields: Sequence[Mapping[str, Any]],
    values: Mapping[str, Any],
    *,
    require_complete: bool = True,
) -> bytes:
    """
    Serialize a *Definition message.

    `fields` is the descriptor entry list from dto_definitions.json; `values`
    maps proto field name → value.

    A tweaker Update **replaces** the object's stored data — it is not a merge.
    Omitting a field therefore resets it to the proto3 default rather than
    leaving it alone, which silently destroys whatever was there. So by default
    every non-repeated field must be supplied; pass require_complete=False only
    when you have independently established that a partial message is safe.
    """
    encodable = [f for f in fields if not f.get("repeated")]

    if require_complete:
        missing = [f["name"] for f in encodable if f["name"] not in values]
        if missing:
            raise ProtoEncodeError(
                "incomplete record — a tweaker Update replaces all fields, so "
                "these would be reset to their defaults: " + ", ".join(missing)
            )

    unknown = set(values) - {f["name"] for f in fields}
    if unknown:
        raise ProtoEncodeError(f"no such field(s): {', '.join(sorted(unknown))}")

    # Ascending field number: not required by protobuf, but it makes the blob
    # byte-reproducible so two runs of the same tweak are diffable.
    out = bytearray()
    for spec in sorted(encodable, key=lambda f: f["number"]):
        if spec["name"] in values:
            out += encode_field(spec, values[spec["name"]])
    return bytes(out)


def build_operation(
    owning_object_xid: str,
    dto_type: int | str,
    data: bytes | None = None,
    *,
    kind: int = OP_UPDATE,
) -> bytes:
    """One SingleOperation, ready to embed in a Transaction."""
    body = len_field(_F_OWNING_XID, owning_object_xid) + len_field(
        _F_DTO_TYPE, str(dto_type)
    )
    if kind != OP_DELETE:
        if data is None:
            raise ProtoEncodeError("create/update operations need a data payload")
        body += len_field(_F_DATA, data)
    elif data is not None:
        raise ProtoEncodeError("delete operations take no data payload")
    return len_field(_F_OPERATIONS, len_field(kind, body))


def build_transaction(
    operation_session_id: str,
    configuration_state_revision: str,
    operations: Iterable[bytes],
) -> bytes:
    """Assemble a Transaction. `operations` come from build_operation()."""
    out = len_field(_F_SESSION_ID, operation_session_id) + len_field(
        _F_CONFIG_REV, configuration_state_revision
    )
    for op in operations:
        out += op
    return out


def encode_tweak_data(
    operation_session_id: str,
    configuration_state_revision: str,
    operations: Iterable[bytes],
) -> str:
    """The base64 `TweakData` argument for RequestDomManagedTweak."""
    txn = build_transaction(
        operation_session_id, configuration_state_revision, operations
    )
    return base64.b64encode(txn).decode("ascii")


def decode_message(buf: bytes) -> dict[int, list[Any]]:
    """
    Minimal wire-format reader used by the tests to prove what was encoded.
    Returns {field_number: [values]} — varints as ints, length-delimited as bytes.
    """
    out: dict[int, list[Any]] = {}
    i = 0
    while i < len(buf):
        key, i = read_varint(buf, i)
        field, wire = key >> 3, key & 7
        if wire == WIRE_VARINT:
            val, i = read_varint(buf, i)
        elif wire == WIRE_LEN:
            ln, i = read_varint(buf, i)
            val = buf[i : i + ln]
            if len(val) != ln:
                raise ProtoEncodeError("truncated length-delimited field")
            i += ln
        else:
            raise ProtoEncodeError(f"unsupported wire type {wire}")
        out.setdefault(field, []).append(val)
    return out
