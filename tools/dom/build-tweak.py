#!/usr/bin/env python3
"""
Build a tweaker Transaction blob (TweakData) for RequestDomManagedTweak.

Schema recovered from the embedded descriptor in domain-object-manager.gobin,
provider/tweaker/internal/proto/tweakerproto/v1/transaction.proto:

  Transaction { string operation_session_id=1; string configuration_state_revision=2;
                repeated SingleOperation operations=3; }
  SingleOperation { Create create=1; Update update=2; Delete delete=3; }
  Update { string owning_object_xid=1; string dto_type=2; bytes data=3; }

and domainobject/dto/v1/led.proto:
  LedDefinition { parent_xid=1, parent_type=2, sort_order=3,
                  device_component_number=4, comm_master_component_number=5,
                  comm_master_device_xid=6, comm_master_device_type=7,
                  status_on_intensity=8, nightlight_intensity=9, led_number=10,
                  led_info_id=11, led_number_on_link=12, active_led_state=13,
                  inactive_led_state=14, ref_prog_model_xid=15,
                  ref_prog_model_type=16, led_type=17 }
"""
import base64
import sys


def varint(n: int) -> bytes:
    out = b""
    while True:
        b = n & 0x7F
        n >>= 7
        out += bytes([b | (0x80 if n else 0)])
        if not n:
            return out


def tag(field: int, wire: int) -> bytes:
    return varint((field << 3) | wire)


def vfield(field: int, value: int) -> bytes:
    """varint field (int32/uint32)"""
    return tag(field, 0) + varint(value)


def lfield(field: int, value) -> bytes:
    """length-delimited field (string/bytes/message)"""
    if isinstance(value, str):
        value = value.encode("utf-8")
    return tag(field, 2) + varint(len(value)) + value


def led_definition(
    parent_xid,
    parent_type,
    sort_order,
    device_component_number,
    comm_master_component_number,
    comm_master_device_xid,
    comm_master_device_type,
    status_on_intensity,
    nightlight_intensity,
    led_number,
    led_info_id,
    led_number_on_link,
    active_led_state,
    inactive_led_state,
    ref_prog_model_xid,
    ref_prog_model_type,
    led_type,
) -> bytes:
    return b"".join(
        [
            lfield(1, parent_xid),
            vfield(2, parent_type),
            vfield(3, sort_order),
            vfield(4, device_component_number),
            vfield(5, comm_master_component_number),
            lfield(6, comm_master_device_xid),
            vfield(7, comm_master_device_type),
            vfield(8, status_on_intensity),
            vfield(9, nightlight_intensity),
            vfield(10, led_number),
            vfield(11, led_info_id),
            vfield(12, led_number_on_link),
            vfield(13, active_led_state),
            vfield(14, inactive_led_state),
            lfield(15, ref_prog_model_xid),
            vfield(16, ref_prog_model_type),
            vfield(17, led_type),
        ]
    )


def transaction(session_id: str, config_rev: str, updates) -> bytes:
    ops = b""
    for owning_xid, dto_type, data in updates:
        upd = lfield(1, owning_xid) + lfield(2, dto_type) + lfield(3, data)
        ops += lfield(3, lfield(2, upd))  # SingleOperation.update -> Transaction.operations
    return lfield(1, session_id) + lfield(2, config_rev) + ops


if __name__ == "__main__":
    # ------------------------------------------------------------------
    # Everything above is generic. The block below is a worked EXAMPLE for
    # one specific object (Kitchen SunnataHybridKeypad LED, /led/2172) on one
    # specific system — the XIDs, ids and config-state revision are all
    # site-specific. To reuse: pull the object's row + ExtendedObjectID from
    # /var/db/lutron-athena-db.sqlite, its parent's ExtendedObjectID, and
    # DatabaseMetadata.ConfigurationStateRevision, then substitute below.
    #
    #   usage: build-tweak.py [statusOnIntensity] [nightlightIntensity]
    #                         [operationSessionId] [dtoType] [configStateRevision]
    #
    # NOTE: dto_type is still unresolved — see docs/protocols/dom-tweaker.md §6.
    # ------------------------------------------------------------------
    status = int(sys.argv[1]) if len(sys.argv) > 1 else 25
    night = int(sys.argv[2]) if len(sys.argv) > 2 else 40
    session = sys.argv[3] if len(sys.argv) > 3 else "Proc-435-Op-9001"
    dto_type = sys.argv[4] if len(sys.argv) > 4 else "LedDefinition"
    config_rev = sys.argv[5] if len(sys.argv) > 5 else "x4tw2sPISiuo_1Zplmv68Q"

    led = led_definition(
        parent_xid="hjr5TljxS8W1RH6dv2A8Xw",
        parent_type=5,
        sort_order=0,
        device_component_number=81,
        comm_master_component_number=81,
        comm_master_device_xid="hjr5TljxS8W1RH6dv2A8Xw",
        comm_master_device_type=5,
        status_on_intensity=status,
        nightlight_intensity=night,
        led_number=5,
        led_info_id=5207,
        led_number_on_link=24,
        active_led_state=1,
        inactive_led_state=0,
        ref_prog_model_xid="amgrXmkxSHS6NpdV-ht8Qg",
        ref_prog_model_type=171,
        led_type=1,
    )
    txn = transaction(
        session, config_rev, [("w_VLl6v1RZOr5U8sjtAAwA", dto_type, led)]
    )
    print(base64.b64encode(txn).decode())
