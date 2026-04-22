import assert from "node:assert/strict";
import test from "node:test";
import {
  chooseArtifact,
  detectNewUsbmodem,
  type UsbmodemSnapshot,
} from "../tools/nrf-dfu-flash";

test("chooseArtifact resolves --tmf to the -tmf-dfu.zip", () => {
  const path = chooseArtifact({ tmf: true, rollback: false });
  assert.ok(path.endsWith("/firmware/ncp/ot-ncp-ftd-tmf-dfu.zip"));
});

test("chooseArtifact resolves --rollback to the known-good dfu.zip", () => {
  const path = chooseArtifact({ tmf: false, rollback: true });
  assert.ok(path.endsWith("/firmware/ncp/ot-ncp-ftd-dfu.zip"));
});

test("chooseArtifact rejects zero or both flags", () => {
  assert.throws(() => chooseArtifact({ tmf: false, rollback: false }));
  assert.throws(() => chooseArtifact({ tmf: true, rollback: true }));
});

test("detectNewUsbmodem returns the new port that appeared after reset", () => {
  const before: UsbmodemSnapshot = [
    "/dev/tty.usbmodem101",
    "/dev/tty.usbmodem102",
  ];
  const after: UsbmodemSnapshot = [
    "/dev/tty.usbmodem101",
    "/dev/tty.usbmodem102",
    "/dev/tty.usbmodemDFU5",
  ];
  assert.equal(detectNewUsbmodem(before, after), "/dev/tty.usbmodemDFU5");
});

test("detectNewUsbmodem returns undefined when no new port appeared", () => {
  const before: UsbmodemSnapshot = ["/dev/tty.usbmodem101"];
  const after: UsbmodemSnapshot = ["/dev/tty.usbmodem101"];
  assert.equal(detectNewUsbmodem(before, after), undefined);
});
