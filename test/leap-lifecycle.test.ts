import test from "node:test";
import {
  checkLeapDetach,
  checkLeapSubscriptionReuse,
  checkLeapTagReuse,
  checkLeapTrace,
} from "../tools/lean/check-leap";

test("a refused subscription cannot dispatch a later same-chunk push", async () => {
  await checkLeapTrace(true, [2, 1], [[0, 0, 0, 1, 0, 1]], true);
});

test("an old request deadline cannot delete a reused ClientTag", async () => {
  await checkLeapTagReuse([1, 0, 0, 0, 0, 0]);
});

test(
  "old subscription rejection preserves a new subscription on the reused tag",
  checkLeapSubscriptionReuse,
);

test("unsubscribe detaches before its acknowledgement", async () => {
  await checkLeapDetach([0, 0, 1, 0, 0, 1]);
});
