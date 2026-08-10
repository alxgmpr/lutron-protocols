import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { expandTemplate, type IdIndex } from "../lib/id-harvest";
import {
  collectionPathsFromSpec,
  mergeIdIndex,
  parseSpecPaths,
  planSpecProbe,
  specPathToTemplate,
} from "../lib/spec-probe";

const idx = (entries: Record<string, string[]>): IdIndex =>
  new Map(Object.entries(entries).map(([k, v]) => [k, new Set(v)]));

describe("parseSpecPaths", () => {
  test("returns the path keys verbatim, placeholders intact", () => {
    const yaml = [
      "openapi: 3.0.3",
      "paths:",
      "  /area:",
      "    get:",
      "      operationId: getAreas",
      "  /area/{areaId}/status:",
      "    get:",
      "      operationId: getAreaStatus",
      "components:",
      "  schemas: {}",
    ].join("\n");
    assert.deepEqual(parseSpecPaths(yaml), ["/area", "/area/{areaId}/status"]);
  });

  test("returns nothing for a document with no paths map", () => {
    assert.deepEqual(parseSpecPaths("openapi: 3.0.3\ninfo:\n  title: x\n"), []);
    assert.deepEqual(parseSpecPaths(""), []);
  });
});

describe("specPathToTemplate", () => {
  test("normalises OpenAPI placeholders to the generic {id} form", () => {
    assert.equal(specPathToTemplate("/area/{areaId}"), "/area/{id}");
    assert.equal(
      specPathToTemplate("/area/{areaId}/status"),
      "/area/{id}/status",
    );
  });

  test("leaves paths without placeholders untouched", () => {
    assert.equal(specPathToTemplate("/area"), "/area");
    assert.equal(
      specPathToTemplate("/area/with/explicit/paging"),
      "/area/with/explicit/paging",
    );
  });

  test("keeps every placeholder adjacent to its owning segment", () => {
    // expandTemplate fills a placeholder from the ids harvested for the
    // segment immediately before it, so a substitution that reordered or
    // dropped segments would silently fill from the wrong resource.
    const cases: [string, string][] = [
      [
        "/device/{deviceId}/linknode/{linknodeId}",
        "/device/{id}/linknode/{id}",
      ],
      [
        "/device/{deviceId}/linknode/{linknodeId}/sentby",
        "/device/{id}/linknode/{id}/sentby",
      ],
      [
        "/link/{linkId}/memberdiscoverysession/{memberdiscoverysessionId}/status",
        "/link/{id}/memberdiscoverysession/{id}/status",
      ],
      [
        "/service/sonoshousehold/{sonoshouseholdId}/speaker/{speakerId}/status",
        "/service/sonoshousehold/{id}/speaker/{id}/status",
      ],
      ["/system/action/intruder/{intruderId}", "/system/action/intruder/{id}"],
      ["/server/leap/pairing/{pairingId}", "/server/leap/pairing/{id}"],
    ];
    for (const [specPath, expected] of cases) {
      assert.equal(specPathToTemplate(specPath), expected, specPath);
      const segments = specPathToTemplate(specPath).split("/");
      const original = specPath.split("/");
      assert.equal(segments.length, original.length, `${specPath}: arity`);
      for (let i = 0; i < segments.length; i++) {
        if (segments[i] === "{id}") continue;
        assert.equal(segments[i], original[i], `${specPath}: segment ${i}`);
      }
    }
  });

  test("expands a two-placeholder spec path from both owning resources", () => {
    const index = idx({ device: ["1020"], linknode: ["1022", "1023"] });
    const template = specPathToTemplate(
      "/device/{deviceId}/linknode/{linknodeId}",
    );
    assert.deepEqual(expandTemplate(template, index, 10).sort(), [
      "/device/1020/linknode/1022",
      "/device/1020/linknode/1023",
    ]);
  });
});

describe("collectionPathsFromSpec", () => {
  test("keeps only the non-parameterised paths, in spec order", () => {
    assert.deepEqual(
      collectionPathsFromSpec([
        "/area",
        "/area/{areaId}",
        "/zone",
        "/zone/{zoneId}/status",
        "/device/status",
      ]),
      ["/area", "/zone", "/device/status"],
    );
  });
});

describe("mergeIdIndex", () => {
  test("live ids crowd out fallback ids entirely when live fills the limit", () => {
    // The regression this whole function exists for: a previous run inserted
    // stale fixture ids from a DIFFERENT processor first, and expandTemplate
    // takes the first `limit` ids in insertion order — so the live ids were
    // never probed at all, and 16 routes came back
    // `404 This resource does not exist` describing the ids rather than the
    // routes. Under the old fallback-first ordering this assertion fails:
    // the result would be the fallback ids.
    const live = idx({
      controlstation: ["101", "102", "103", "104", "105", "106", "107", "108"],
    });
    const fallback = idx({
      controlstation: ["901", "902", "903", "904", "905", "906", "907", "908"],
    });

    const merged = mergeIdIndex(live, fallback, 8);
    const ids = [...(merged.get("controlstation") ?? [])];

    assert.equal(ids.length, 8);
    assert.deepEqual(ids, [
      "101",
      "102",
      "103",
      "104",
      "105",
      "106",
      "107",
      "108",
    ]);
    for (const id of ids) {
      assert.ok(
        live.get("controlstation")?.has(id),
        `${id} is not a live id — fallback ids crowded out live ones`,
      );
    }
  });

  test("the crowd-out also holds through expandTemplate, which is where it bit", () => {
    const live = idx({ vbutton: ["1", "2", "3", "4", "5", "6", "7", "8"] });
    const fallback = idx({ vbutton: ["91", "92", "93", "94", "95", "96"] });
    const urls = expandTemplate(
      specPathToTemplate("/vbutton/{vbuttonId}"),
      mergeIdIndex(live, fallback, 8),
      8,
    );
    assert.deepEqual(urls, [
      "/vbutton/1",
      "/vbutton/2",
      "/vbutton/3",
      "/vbutton/4",
      "/vbutton/5",
      "/vbutton/6",
      "/vbutton/7",
      "/vbutton/8",
    ]);
  });

  test("fallback ids fill only the capacity live leaves, and come after", () => {
    const live = idx({ zone: ["1", "2"] });
    const fallback = idx({ zone: ["50", "51", "52", "53", "54"] });
    const ids = [...(mergeIdIndex(live, fallback, 5).get("zone") ?? [])];
    assert.deepEqual(ids, ["1", "2", "50", "51", "52"]);
  });

  test("does not duplicate an id present in both indexes", () => {
    const live = idx({ zone: ["1", "2"] });
    const fallback = idx({ zone: ["2", "3"] });
    assert.deepEqual(
      [...(mergeIdIndex(live, fallback, 8).get("zone") ?? [])],
      ["1", "2", "3"],
    );
  });

  test("keeps resources present in only one of the two indexes", () => {
    const merged = mergeIdIndex(idx({ zone: ["1"] }), idx({ area: ["9"] }), 8);
    assert.deepEqual([...(merged.get("zone") ?? [])], ["1"]);
    assert.deepEqual([...(merged.get("area") ?? [])], ["9"]);
  });

  test("truncates live itself at the limit", () => {
    const live = idx({ zone: ["1", "2", "3", "4", "5"] });
    assert.equal(mergeIdIndex(live, new Map(), 3).get("zone")?.size, 3);
  });

  test("a non-positive limit yields no ids at all", () => {
    assert.equal(mergeIdIndex(idx({ zone: ["1"] }), new Map(), 0).size, 0);
  });
});

describe("planSpecProbe", () => {
  const index = idx({
    area: ["32", "33"],
    zone: ["518"],
    device: ["1020"],
    linknode: ["1022"],
  });

  test("expands parameterised paths and passes plain ones through", () => {
    const plan = planSpecProbe(["/area", "/area/{areaId}/status"], index, 8);
    assert.deepEqual(plan.urls, [
      "/area",
      "/area/32/status",
      "/area/33/status",
    ]);
    assert.deepEqual(plan.skipped, []);
  });

  test("reports unexpandable templates instead of dropping them", () => {
    const plan = planSpecProbe(
      ["/zone/{zoneId}", "/timeclock/{timeclockId}/status"],
      index,
      8,
    );
    assert.deepEqual(plan.urls, ["/zone/518"]);
    assert.deepEqual(plan.skipped, [
      {
        specPath: "/timeclock/{timeclockId}/status",
        template: "/timeclock/{id}/status",
        missingResource: "timeclock",
      },
    ]);
  });

  test("names the first unfilled owner in a multi-placeholder path", () => {
    const plan = planSpecProbe(
      [
        "/link/{linkId}/memberdiscoverysession/{memberdiscoverysessionId}/status",
      ],
      index,
      8,
    );
    assert.equal(plan.urls.length, 0);
    assert.equal(plan.skipped[0].missingResource, "link");
  });

  test("skips the `with` pseudo-owner rather than probing a wrong id", () => {
    // `/service/alexadatasummary/scene/with/{withId}` satisfies the naming
    // convention only nominally — no resource named `with` ever yields ids.
    const plan = planSpecProbe(
      ["/service/alexadatasummary/scene/with/{withId}"],
      index,
      8,
    );
    assert.deepEqual(plan.urls, []);
    assert.equal(plan.skipped[0].missingResource, "with");
  });

  test("deduplicates urls two spec paths expand to the same way", () => {
    const plan = planSpecProbe(["/zone/{zoneId}", "/zone/{zoneId}"], index, 8);
    assert.deepEqual(plan.urls, ["/zone/518"]);
  });

  test("honours the per-template limit", () => {
    const many = idx({ area: ["1", "2", "3", "4", "5"] });
    const plan = planSpecProbe(["/area/{areaId}"], many, 2);
    assert.equal(plan.urls.length, 2);
  });

  test("an empty spec plans nothing and skips nothing", () => {
    assert.deepEqual(planSpecProbe([], index, 8), { urls: [], skipped: [] });
  });
});
