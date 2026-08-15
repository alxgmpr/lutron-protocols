#!/usr/bin/env python3
"""
Build a Transaction that updates LedController 2171 (Kitchen SunnataHybridKeypad).

dto_type is the DECIMAL OBJECT TYPE as a string. LedController = "108".
(Led = 107 is NOT a registered DTO type; registered set observed:
 2,3,4,5,9,10,15,32,34,43,44,46,57,58,60,74,77,92,94,108)

LedControllerDefinition (domainobject/dto/v1/led_controller.proto):
  1 parent_xid, 2 parent_type, 3 sort_order, 4 device_component_number,
  5 comm_master_component_number, 6 comm_master_device_xid,
  7 comm_master_device_type, 8 default_nightlight_intensity,
  9 default_status_on_intensity, 10 fake_feedback_time,
  11 flash_one_off_time, 12 flash_one_on_time, 13 flash_two_off_time,
  14 flash_two_on_time, 15 model_info_id
"""
import base64
import sys

# --- minimal protobuf encoders (kept local so this runs standalone, no deps) ---
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


def led_controller_definition(default_nightlight, default_status_on):
    return b"".join([
        lf(1, "hjr5TljxS8W1RH6dv2A8Xw"),   # parent_xid  (device 2165)
        vf(2, 5),                           # parent_type ControlStationDevice
        vf(3, 0),                           # sort_order
        vf(4, 112),                         # device_component_number
        vf(5, 112),                         # comm_master_component_number
        lf(6, "hjr5TljxS8W1RH6dv2A8Xw"),   # comm_master_device_xid
        vf(7, 5),                           # comm_master_device_type
        vf(8, default_nightlight),          # default_nightlight_intensity
        vf(9, default_status_on),           # default_status_on_intensity
        vf(10, 0),                          # fake_feedback_time
        vf(11, 25),                         # flash_one_off_time
        vf(12, 25),                         # flash_one_on_time
        vf(13, 6),                          # flash_two_off_time
        vf(14, 6),                          # flash_two_on_time
        vf(15, 5194),                       # model_info_id
    ])


def transaction(session_id, config_rev, owning_xid, dto_type, data):
    upd = lf(1, owning_xid) + lf(2, dto_type) + lf(3, data)
    return lf(1, session_id) + lf(2, config_rev) + lf(3, lf(2, upd))


if __name__ == "__main__":
    night = int(sys.argv[1]) if len(sys.argv) > 1 else 40
    status = int(sys.argv[2]) if len(sys.argv) > 2 else 1
    session = sys.argv[3] if len(sys.argv) > 3 else "Proc-435-Op-5001"
    rev = sys.argv[4] if len(sys.argv) > 4 else "x4tw2sPISiuo_1Zplmv68Q"
    data = led_controller_definition(night, status)
    txn = transaction(session, rev, "SCu2V8-rTfas25_4oABsuQ", "108", data)
    print(base64.b64encode(txn).decode())
