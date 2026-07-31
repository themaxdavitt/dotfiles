import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { parsePlannotatorDecision, reviewPlanWithPlannotator } from "../src/plannotator";

let tempDir: string;
let planPath: string;

before(() => {
  tempDir = mkdtempSync(join(tmpdir(), "session-planner-plannotator-"));
  planPath = join(tempDir, "plan.md");
  writeFileSync(planPath, "# Plan\n");
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function fakePlannotator(name: string, body: string): string {
  const path = join(tempDir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("parsePlannotatorDecision", () => {
  test("reads the decision from the last JSON line, ignoring log noise", () => {
    assert.deepEqual(parsePlannotatorDecision('log line\n{"decision":"approved"}'), {
      decision: "approved",
    });
  });

  test("carries annotation feedback", () => {
    assert.deepEqual(
      parsePlannotatorDecision('{"decision":"annotated","feedback":"tighten scope"}'),
      { decision: "annotated", feedback: "tighten scope" },
    );
  });

  test("tolerates an annotation with no feedback text", () => {
    assert.deepEqual(parsePlannotatorDecision('{"decision":"annotated"}'), {
      decision: "annotated",
      feedback: "",
    });
  });

  test("reads a dismissal", () => {
    assert.deepEqual(parsePlannotatorDecision('{"decision":"dismissed"}'), {
      decision: "dismissed",
    });
  });

  test("treats no output as a dismissal", () => {
    assert.deepEqual(parsePlannotatorDecision(""), { decision: "dismissed" });
  });

  test("throws on an unknown decision rather than guessing", () => {
    assert.throws(() => parsePlannotatorDecision('{"decision":"whatever"}'), /unknown decision/);
  });

  test("throws when nothing parses as JSON", () => {
    assert.throws(() => parsePlannotatorDecision("not json at all"), /did not return JSON/);
  });
});

describe("reviewPlanWithPlannotator", () => {
  test("invokes the documented CLI contract and reports approval", async () => {
    const binary = fakePlannotator(
      "plannotator-approved",
      `
if [ "$1" != "annotate" ] || [ "$3" != "--gate" ] || [ "$4" != "--json" ]; then
  echo "bad args: $*" >&2
  exit 12
fi
echo '{"decision":"approved"}'
`,
    );
    assert.deepEqual(await reviewPlanWithPlannotator(planPath, { binary }), { status: "approved" });
  });

  test("reports requested revisions with their feedback", async () => {
    const binary = fakePlannotator(
      "plannotator-annotated",
      `echo '{"decision":"annotated","feedback":"Add rollback step."}'`,
    );
    assert.deepEqual(await reviewPlanWithPlannotator(planPath, { binary }), {
      status: "annotated",
      feedback: "Add rollback step.",
    });
  });

  test("reports a dismissal", async () => {
    const binary = fakePlannotator("plannotator-dismissed", `echo '{"decision":"dismissed"}'`);
    assert.deepEqual(await reviewPlanWithPlannotator(planPath, { binary }), {
      status: "dismissed",
      feedback: "Plan review was dismissed without approval.",
    });
  });

  test("surfaces stderr when the reviewer crashes", async () => {
    const binary = fakePlannotator("plannotator-failing", `echo "review crashed" >&2\nexit 7`);
    assert.deepEqual(await reviewPlanWithPlannotator(planPath, { binary }), {
      status: "error",
      feedback: "review crashed",
    });
  });

  test("distinguishes an uninstalled reviewer from a crash", async () => {
    // The caller turns this into a tool result, and "not installed" needs a
    // different next step from "your plan was rejected".
    const result = await reviewPlanWithPlannotator(planPath, {
      binary: join(tempDir, "missing-plannotator"),
    });
    assert.equal(result.status, "unavailable");
  });

  test("reports unparseable output as an error rather than approving", async () => {
    const binary = fakePlannotator("plannotator-garbage", `echo 'not json at all'`);
    assert.equal((await reviewPlanWithPlannotator(planPath, { binary })).status, "error");
  });

  test("treats an abort as a dismissal", async () => {
    const controller = new AbortController();
    const binary = fakePlannotator("plannotator-slow", `sleep 5`);
    const pending = reviewPlanWithPlannotator(planPath, { binary, signal: controller.signal });
    controller.abort();
    assert.deepEqual(await pending, {
      status: "dismissed",
      feedback: "Plan review was aborted.",
    });
  });

  test("never rejects, whatever the reviewer does", async () => {
    // Every failure has to come back as a result the model can act on.
    const binary = fakePlannotator("plannotator-empty", `exit 0`);
    const result = await reviewPlanWithPlannotator(planPath, { binary });
    assert.equal(result.status, "dismissed");
  });
});
