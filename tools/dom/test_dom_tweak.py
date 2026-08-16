#!/usr/bin/env python3
"""
Tests for the DOM tweaker.

Run: python3 -m unittest discover -s tools/dom

Nothing here touches a processor — the transport is exercised through injected
fakes, so the whole suite runs on the host.
"""

import base64
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import dom_proto
import dom_types
from dom_processor import (
    ProcessorError,
    classify_dom_log,
    compose_outcome,
    extract_result_code,
    row_to_values,
    sql_quote,
)

# LedControllerDefinition, abbreviated to the shapes under test.
LED_CONTROLLER_FIELDS = [
    {"name": "parent_xid", "number": 1, "type": "string", "repeated": False},
    {"name": "parent_type", "number": 2, "type": "uint32", "repeated": False},
    {"name": "sort_order", "number": 3, "type": "int32", "repeated": False},
    {"name": "device_component_number", "number": 4, "type": "uint32", "repeated": False},
    {"name": "default_nightlight_intensity", "number": 8, "type": "uint32", "repeated": False},
    {"name": "default_status_on_intensity", "number": 9, "type": "uint32", "repeated": False},
]


def values_for(fields, **overrides):
    base = {}
    for spec in fields:
        base[spec["name"]] = "x" if spec["type"] == "string" else 0
    base.update(overrides)
    return base


class TestVarint(unittest.TestCase):
    def test_encodes_single_byte_values_directly(self):
        self.assertEqual(dom_proto.varint(0), b"\x00")
        self.assertEqual(dom_proto.varint(1), b"\x01")
        self.assertEqual(dom_proto.varint(127), b"\x7f")

    def test_continues_past_seven_bits(self):
        self.assertEqual(dom_proto.varint(128), b"\x80\x01")
        self.assertEqual(dom_proto.varint(300), b"\xac\x02")

    def test_encodes_negative_as_twos_complement_64_bit(self):
        # protobuf encodes negative int32 in ten bytes, not as a short varint.
        self.assertEqual(len(dom_proto.varint(-1)), 10)

    def test_round_trips_through_read_varint(self):
        for n in (0, 1, 127, 128, 300, 5194, 2**31 - 1):
            buf = dom_proto.varint(n)
            self.assertEqual(dom_proto.read_varint(buf, 0), (n, len(buf)))


class TestEncodeField(unittest.TestCase):
    def test_encodes_a_string_as_length_delimited(self):
        spec = {"name": "parent_xid", "number": 1, "type": "string"}
        out = dom_proto.encode_field(spec, "AB")
        self.assertEqual(out, b"\x0a\x02AB")

    def test_encodes_an_integer_as_a_varint(self):
        spec = {"name": "sort_order", "number": 3, "type": "int32"}
        self.assertEqual(dom_proto.encode_field(spec, 5), b"\x18\x05")

    def test_rejects_a_string_for_an_integer_field(self):
        spec = {"name": "sort_order", "number": 3, "type": "int32"}
        with self.assertRaises(dom_proto.ProtoEncodeError):
            dom_proto.encode_field(spec, "5")

    def test_rejects_a_negative_value_for_an_unsigned_field(self):
        spec = {"name": "intensity", "number": 8, "type": "uint32"}
        with self.assertRaises(dom_proto.ProtoEncodeError):
            dom_proto.encode_field(spec, -1)

    def test_allows_a_negative_value_for_a_signed_field(self):
        spec = {"name": "sort_order", "number": 3, "type": "int32"}
        self.assertTrue(dom_proto.encode_field(spec, -1))


class TestEncodeDefinition(unittest.TestCase):
    def test_encodes_every_field_in_field_number_order(self):
        values = values_for(LED_CONTROLLER_FIELDS)
        out = dom_proto.encode_definition(LED_CONTROLLER_FIELDS, values)
        decoded = dom_proto.decode_message(out)
        self.assertEqual(sorted(decoded), [1, 2, 3, 4, 8, 9])

    def test_refuses_a_partial_record_because_update_replaces(self):
        # The whole safety argument: an Update is not a merge. Omitting a field
        # resets it to the proto3 default rather than leaving it alone.
        partial = {"default_status_on_intensity": 100}
        with self.assertRaises(dom_proto.ProtoEncodeError) as ctx:
            dom_proto.encode_definition(LED_CONTROLLER_FIELDS, partial)
        self.assertIn("replaces all fields", str(ctx.exception))
        self.assertIn("parent_xid", str(ctx.exception))

    def test_allows_a_partial_record_when_explicitly_opted_out(self):
        out = dom_proto.encode_definition(
            LED_CONTROLLER_FIELDS,
            {"default_status_on_intensity": 100},
            require_complete=False,
        )
        self.assertEqual(sorted(dom_proto.decode_message(out)), [9])

    def test_rejects_a_field_that_does_not_exist(self):
        values = values_for(LED_CONTROLLER_FIELDS, nonsense=1)
        with self.assertRaises(dom_proto.ProtoEncodeError) as ctx:
            dom_proto.encode_definition(LED_CONTROLLER_FIELDS, values)
        self.assertIn("nonsense", str(ctx.exception))

    def test_is_byte_reproducible_for_the_same_values(self):
        values = values_for(LED_CONTROLLER_FIELDS, default_status_on_intensity=100)
        a = dom_proto.encode_definition(LED_CONTROLLER_FIELDS, values)
        b = dom_proto.encode_definition(LED_CONTROLLER_FIELDS, dict(reversed(list(values.items()))))
        self.assertEqual(a, b)

    def test_skips_repeated_fields_rather_than_demanding_them(self):
        fields = LED_CONTROLLER_FIELDS + [
            {"name": "tags", "number": 20, "type": "string", "repeated": True}
        ]
        out = dom_proto.encode_definition(fields, values_for(LED_CONTROLLER_FIELDS))
        self.assertNotIn(20, dom_proto.decode_message(out))


class TestTransaction(unittest.TestCase):
    def test_update_operation_carries_xid_type_and_data(self):
        op = dom_proto.build_operation("XID1", 108, b"\x08\x01")
        outer = dom_proto.decode_message(op)
        # Transaction.operations = 3
        self.assertIn(3, outer)
        single = dom_proto.decode_message(outer[3][0])
        # SingleOperation.update = 2
        self.assertIn(2, single)
        update = dom_proto.decode_message(single[2][0])
        self.assertEqual(update[1][0], b"XID1")
        self.assertEqual(update[2][0], b"108")
        self.assertEqual(update[3][0], b"\x08\x01")

    def test_dto_type_is_the_decimal_number_as_a_string(self):
        # A name-shaped dto_type is rejected by the processor with
        # `dto: DTOType not registered`, so the encoder must stringify the int.
        op = dom_proto.build_operation("XID1", 108, b"")
        update = dom_proto.decode_message(
            dom_proto.decode_message(dom_proto.decode_message(op)[3][0])[2][0]
        )
        self.assertEqual(update[2][0], b"108")

    def test_delete_operation_has_no_data_field(self):
        op = dom_proto.build_operation("XID1", 108, kind=dom_proto.OP_DELETE)
        single = dom_proto.decode_message(dom_proto.decode_message(op)[3][0])
        delete = dom_proto.decode_message(single[3][0])
        self.assertNotIn(3, delete)

    def test_delete_rejects_a_data_payload(self):
        with self.assertRaises(dom_proto.ProtoEncodeError):
            dom_proto.build_operation("X", 108, b"\x01", kind=dom_proto.OP_DELETE)

    def test_update_requires_a_data_payload(self):
        with self.assertRaises(dom_proto.ProtoEncodeError):
            dom_proto.build_operation("X", 108, None)

    def test_transaction_carries_session_and_revision(self):
        txn = dom_proto.build_transaction("Sess-1", "Rev-1", [])
        decoded = dom_proto.decode_message(txn)
        self.assertEqual(decoded[1][0], b"Sess-1")
        self.assertEqual(decoded[2][0], b"Rev-1")

    def test_transaction_holds_multiple_operations(self):
        ops = [
            dom_proto.build_operation("A", 108, b"\x08\x01"),
            dom_proto.build_operation("B", 5, b"\x08\x02"),
        ]
        txn = dom_proto.build_transaction("S", "R", ops)
        self.assertEqual(len(dom_proto.decode_message(txn)[3]), 2)

    def test_tweak_data_is_base64_of_the_transaction(self):
        op = dom_proto.build_operation("A", 108, b"\x08\x01")
        blob = dom_proto.encode_tweak_data("S", "R", [op])
        self.assertEqual(
            base64.b64decode(blob), dom_proto.build_transaction("S", "R", [op])
        )


class TestColumnName(unittest.TestCase):
    def test_snake_case_becomes_pascal_case(self):
        self.assertEqual(
            dom_types.column_name("default_status_on_intensity"),
            "DefaultStatusOnIntensity",
        )

    def test_trailing_id_is_capitalised_as_an_acronym(self):
        self.assertEqual(dom_types.column_name("model_info_id"), "ModelInfoID")

    def test_xid_field_maps_to_the_integer_id_column(self):
        # The proto carries an ExtendedObjectID string; the table stores the
        # numeric ObjectID, so parent_xid is backed by ParentID.
        self.assertEqual(dom_types.column_name("parent_xid"), "ParentID")
        self.assertEqual(
            dom_types.column_name("comm_master_device_xid"), "CommMasterDeviceID"
        )


class TestPascalCase(unittest.TestCase):
    def test_screaming_snake_becomes_the_table_name(self):
        self.assertEqual(dom_types.pascal_case("LED_CONTROLLER"), "LedController")

    def test_does_not_special_case_acronyms(self):
        # The table really is ZoneControllerUi, matching AreaTouchscreenUi.
        self.assertEqual(
            dom_types.pascal_case("ZONE_CONTROLLER_UI"), "ZoneControllerUi"
        )


class TestRegisteredTypes(unittest.TestCase):
    def test_led_controller_is_registered_and_led_is_not(self):
        self.assertIn(108, dom_types.REGISTERED_DTO_TYPES)
        self.assertNotIn(107, dom_types.REGISTERED_DTO_TYPES)

    def test_unregistered_led_explains_the_alternative(self):
        with self.assertRaises(dom_types.UnknownTypeError) as ctx:
            dom_types.definition_name(107)
        self.assertIn("LedController", str(ctx.exception))

    def test_type_with_no_definition_message_fails_clearly(self):
        # 77 is registered for tweaking but has no *Definition in the binary.
        with self.assertRaises(dom_types.UnknownTypeError) as ctx:
            dom_types.definition_name(77)
        self.assertIn("no *Definition", str(ctx.exception))

    def test_every_definition_named_in_the_table_exists_in_the_descriptors(self):
        for dto_type, (desc, msg) in dom_types.REGISTERED_DTO_TYPES.items():
            if msg is None:
                continue
            with self.subTest(dto_type=dto_type):
                self.assertTrue(dom_types.fields_for_definition(msg))

    def test_led_controller_field_map_matches_the_documented_schema(self):
        fields = {f["name"]: f["number"] for f in dom_types.fields_for_type(108)}
        self.assertEqual(fields["parent_xid"], 1)
        self.assertEqual(fields["default_nightlight_intensity"], 8)
        self.assertEqual(fields["default_status_on_intensity"], 9)
        self.assertEqual(fields["model_info_id"], 15)


class TestRowToValues(unittest.TestCase):
    ROW = {
        "ObjectID": "2171",
        "ExtendedObjectID": "SCu2V8-rTfas25_4oABsuQ",
        "ParentID": "2165",
        "ParentType": "5",
        "SortOrder": "0",
        "DeviceComponentNumber": "112",
        "DefaultNightlightIntensity": "0",
        "DefaultStatusOnIntensity": "1",
    }

    def values(self, fields=None, row=None):
        return row_to_values(
            row if row is not None else self.ROW,
            fields if fields is not None else LED_CONTROLLER_FIELDS,
            xid_lookup=lambda oid: f"XID-{oid}",
            type_lookup=lambda oid: 5,
        )

    def test_fills_every_field_from_the_row(self):
        values = self.values()
        self.assertEqual(set(values), {f["name"] for f in LED_CONTROLLER_FIELDS})

    def test_converts_integer_columns_to_ints(self):
        self.assertEqual(self.values()["default_status_on_intensity"], 1)

    def test_resolves_an_xid_field_from_its_id_column(self):
        self.assertEqual(self.values()["parent_xid"], "XID-2165")

    def test_raises_rather_than_silently_dropping_an_unmapped_field(self):
        fields = LED_CONTROLLER_FIELDS + [
            {"name": "not_a_column", "number": 30, "type": "uint32", "repeated": False}
        ]
        with self.assertRaises(ProcessorError) as ctx:
            self.values(fields=fields)
        self.assertIn("not_a_column", str(ctx.exception))

    def test_derives_a_type_companion_that_has_no_column(self):
        # comm_master_device_type has no column; it comes from the referenced
        # object's ObjectType.
        fields = [
            {"name": "comm_master_device_xid", "number": 6, "type": "string", "repeated": False},
            {"name": "comm_master_device_type", "number": 7, "type": "uint32", "repeated": False},
        ]
        row = {"CommMasterDeviceID": "2165"}
        values = row_to_values(
            row, fields, xid_lookup=lambda oid: f"XID-{oid}", type_lookup=lambda oid: 5
        )
        self.assertEqual(values["comm_master_device_type"], 5)


class TestDomLogClassification(unittest.TestCase):
    def test_detects_an_unregistered_dto_type(self):
        ok, reason = classify_dom_log(
            ['ApplyExternalObjectChanges: dto: DTOType not registered: "LedDefinition"']
        )
        self.assertFalse(ok)
        self.assertIn("not registered", reason)

    def test_detects_a_stale_configuration_state_revision(self):
        ok, reason = classify_dom_log(
            ['expected ConfigurationStateRevision "A" does not match current "B"']
        )
        self.assertFalse(ok)
        self.assertIn("does not match current", reason)

    def test_detects_success(self):
        ok, reason = classify_dom_log(
            ["Info: Tweak completed with success: TweakerSessionID={x}"]
        )
        self.assertTrue(ok)
        self.assertIsNone(reason)

    def test_a_failure_after_a_success_line_still_fails(self):
        ok, _ = classify_dom_log(
            [
                "Info: Tweak completed with success",
                "ApplyExternalObjectChanges: dto: DTOType not registered",
            ]
        )
        self.assertFalse(ok)

    def test_silence_is_not_success(self):
        ok, reason = classify_dom_log([])
        self.assertFalse(ok)
        self.assertIsNone(reason)


class TestResultCode(unittest.TestCase):
    def test_extracts_the_result_from_the_broadcast(self):
        line = '[CORE] Broadcasting: {"cmd":"DomManagedTweakResponse","args":{"Result":0}}'
        self.assertEqual(extract_result_code(line), 0)

    def test_extracts_a_nonzero_result(self):
        line = '{"cmd":"DomManagedTweakResponse","args":{"Result":2}}'
        self.assertEqual(extract_result_code(line), 2)

    def test_returns_none_when_absent(self):
        self.assertIsNone(extract_result_code("nothing here"))

    def test_a_nonzero_result_overrides_a_success_looking_log(self):
        outcome = compose_outcome(
            '{"cmd":"DomManagedTweakResponse","args":{"Result":2}}',
            ["Info: Tweak completed with success"],
        )
        self.assertFalse(outcome.ok)
        self.assertIn("BUSY_ERROR", outcome.summary())

    def test_success_requires_both_signals(self):
        outcome = compose_outcome(
            '{"cmd":"DomManagedTweakResponse","args":{"Result":0}}',
            ["Info: Tweak completed with success"],
        )
        self.assertTrue(outcome.ok)

    def test_result_zero_with_a_silent_dom_log_is_still_success(self):
        # The DOM log records rejections, not successes — a good tweak often
        # writes nothing there. Demanding a success line would fail every one.
        outcome = compose_outcome(
            '{"cmd":"DomManagedTweakResponse","args":{"Result":0}}', []
        )
        self.assertTrue(outcome.ok)

    def test_a_stale_revision_reports_the_log_reason_not_the_generic_code(self):
        outcome = compose_outcome(
            '{"cmd":"DomManagedTweakResponse","args":{"Result":1}}',
            ['expected ConfigurationStateRevision "A" does not match current "B"'],
        )
        self.assertFalse(outcome.ok)
        self.assertIn("does not match current", outcome.reason)

    def test_a_missing_response_is_a_failure_not_an_assumed_success(self):
        # `-d` without `-o` is fire-and-forget: it commits and prints nothing.
        # Silence must never read as success.
        outcome = compose_outcome("", [])
        self.assertFalse(outcome.ok)
        self.assertIn("no DomManagedTweakResponse", outcome.reason)


class TestSqlQuote(unittest.TestCase):
    def test_wraps_in_single_quotes(self):
        self.assertEqual(sql_quote("abc"), "'abc'")

    def test_doubles_embedded_quotes(self):
        self.assertEqual(sql_quote("O'Brien"), "'O''Brien'")


if __name__ == "__main__":
    unittest.main()
