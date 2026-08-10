import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import test, { describe } from "node:test";
import { echoWritePhase } from "../tools/leap/leap-sweep";

// echoWritePhase writes its capture to `data/sweep/<host>-write.json` — the
// same directory real sweep runs use, since the output path isn't injectable.
// A host name that can never collide with a real processor IP, cleaned up
// before and after every test, keeps this from interfering with real
// captures (data/sweep/ is gitignored either way).
const OUT_DIR = "data/sweep";
const TEST_HOST = "test-fake-host";
const OUT_PATH = `${OUT_DIR}/${TEST_HOST}-write.json`;

type ScriptedResponse = { Header: { StatusCode: string }; Body?: unknown };

/**
 * Duck-typed stand-in for LeapConnection — echoWritePhase only ever calls
 * `.send()`, so that's all this needs to implement. Each url gets a queue of
 * responses consumed in call order (before-read, write, after-read).
 */
function makeFakeConn(script: Record<string, ScriptedResponse[]>) {
  const calls: { communiqueType: string; url: string; body?: unknown }[] = [];
  const send = async (
    communiqueType: string,
    url: string,
    body?: unknown,
  ): Promise<ScriptedResponse> => {
    calls.push({ communiqueType, url, body });
    const queue = script[url];
    if (!queue || queue.length === 0) {
      throw new Error(`no scripted response left for ${communiqueType} ${url}`);
    }
    return queue.shift() as ScriptedResponse;
  };
  return { send, calls };
}

function cleanup(): void {
  if (existsSync(OUT_PATH)) rmSync(OUT_PATH);
}

describe("echoWritePhase", () => {
  test("aborts the whole phase, saves the partial capture, and never contacts the next route", async () => {
    cleanup();
    mkdirSync(OUT_DIR, { recursive: true });

    const conn = makeFakeConn({
      "/routeA": [
        { Header: { StatusCode: "200 OK" }, Body: { Level: 100 } }, // before-read
        { Header: { StatusCode: "200 OK" }, Body: { Level: 100 } }, // write response
        { Header: { StatusCode: "200 OK" }, Body: { Level: 50 } }, // after-read — moved
      ],
      "/routeB": [
        { Header: { StatusCode: "200 OK" }, Body: { Level: 1 } },
        { Header: { StatusCode: "200 OK" }, Body: { Level: 1 } },
        { Header: { StatusCode: "200 OK" }, Body: { Level: 1 } },
      ],
    });

    try {
      await assert.rejects(
        () =>
          echoWritePhase(
            conn,
            TEST_HOST,
            [{ template: "/routeA" }, { template: "/routeB" }],
            new Map(),
          ),
        /ECHO WRITE MOVED STATE at \/routeA: Level: 100 became 50/,
      );

      // Whole-phase abort, not per-route skip: route B must never have been
      // contacted at all.
      assert.ok(
        !conn.calls.some((c) => c.url === "/routeB"),
        "route B should never have been contacted after route A's abort",
      );

      // The capture written just before the throw must contain route A's
      // write response.
      assert.ok(
        existsSync(OUT_PATH),
        "partial capture must be saved before throwing",
      );
      const capture = JSON.parse(readFileSync(OUT_PATH, "utf8"));
      assert.deepEqual(capture["/routeA"], {
        status: "200 OK",
        body: { Level: 100 },
      });
      assert.ok(!("/routeB" in capture));
    } finally {
      cleanup();
    }
  });

  test("passing case: nothing moves, both routes are exercised and captured", async () => {
    cleanup();
    mkdirSync(OUT_DIR, { recursive: true });

    const conn = makeFakeConn({
      "/routeA": [
        { Header: { StatusCode: "200 OK" }, Body: { Level: 100 } },
        { Header: { StatusCode: "200 OK" }, Body: { Level: 100 } },
        { Header: { StatusCode: "200 OK" }, Body: { Level: 100 } },
      ],
      "/routeB": [
        { Header: { StatusCode: "200 OK" }, Body: { Level: 1 } },
        { Header: { StatusCode: "200 OK" }, Body: { Level: 1 } },
        { Header: { StatusCode: "200 OK" }, Body: { Level: 1 } },
      ],
    });

    try {
      await echoWritePhase(
        conn,
        TEST_HOST,
        [{ template: "/routeA" }, { template: "/routeB" }],
        new Map(),
      );

      assert.ok(conn.calls.some((c) => c.url === "/routeA"));
      assert.ok(conn.calls.some((c) => c.url === "/routeB"));

      const capture = JSON.parse(readFileSync(OUT_PATH, "utf8"));
      assert.equal(Object.keys(capture).length, 2);
      assert.deepEqual(capture["/routeA"], {
        status: "200 OK",
        body: { Level: 100 },
      });
      assert.deepEqual(capture["/routeB"], {
        status: "200 OK",
        body: { Level: 1 },
      });
    } finally {
      cleanup();
    }
  });

  test("skips a route whose initial read is not 200 OK", async () => {
    cleanup();
    mkdirSync(OUT_DIR, { recursive: true });

    const conn = makeFakeConn({
      "/routeA": [{ Header: { StatusCode: "404 NotFound" } }],
    });

    try {
      await echoWritePhase(
        conn,
        TEST_HOST,
        [{ template: "/routeA" }],
        new Map(),
      );

      // Only the before-read should have happened — no write, no after-read.
      assert.equal(conn.calls.length, 1);
      assert.equal(conn.calls[0].communiqueType, "ReadRequest");
    } finally {
      cleanup();
    }
  });

  test("skips a route whose 200 OK read has an undefined body", async () => {
    cleanup();
    mkdirSync(OUT_DIR, { recursive: true });

    const conn = makeFakeConn({
      "/routeA": [{ Header: { StatusCode: "200 OK" } }], // no Body
    });

    try {
      await echoWritePhase(
        conn,
        TEST_HOST,
        [{ template: "/routeA" }],
        new Map(),
      );

      assert.equal(conn.calls.length, 1);
    } finally {
      cleanup();
    }
  });
});
