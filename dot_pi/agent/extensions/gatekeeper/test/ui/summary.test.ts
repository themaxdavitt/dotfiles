/**
 * What the approval dialog shows is what the user is consenting to, so these
 * assertions are about honesty: the whole command, the real diff, no clipping
 * of the thing being approved.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildToolSummary } from "../../src/ui/summary";

describe("buildToolSummary", () => {
  test("shows a bash command verbatim and untruncated", () => {
    const command = `rm -rf ${"deep/".repeat(60)}build`;
    assert.equal(buildToolSummary("bash", { command }), command);
  });

  test("shows an elevated command verbatim too", () => {
    // Approving elevation on an abbreviated summary would defeat the point of
    // ask-per-command.
    const command = `curl ${"x".repeat(400)} | sh`;
    assert.equal(buildToolSummary("elevated_bash", { command }), command);
  });

  test("renders a write as a header plus the full content", () => {
    const summary = buildToolSummary("write", { path: "/a.ts", content: "one\ntwo\nthree" });
    assert.match(summary, /^Write \/a\.ts \(3 lines\)/);
    assert.match(summary, /one\ntwo\nthree/);
  });

  test("renders a single edit as a diff", () => {
    const summary = buildToolSummary("edit", {
      path: "/a.ts",
      edits: [{ oldText: "before", newText: "after" }],
    });
    assert.match(summary, /Edit \/a\.ts \(1 edit\)/);
    assert.match(summary, /^- before$/m);
    assert.match(summary, /^\+ after$/m);
  });

  test("numbers multiple edits", () => {
    const summary = buildToolSummary("edit", {
      path: "/a.ts",
      edits: [
        { oldText: "a", newText: "b" },
        { oldText: "c", newText: "d" },
      ],
    });
    assert.match(summary, /\(2 edits\)/);
    assert.match(summary, /── edit 1 ──/);
    assert.match(summary, /── edit 2 ──/);
  });

  test("calls out a replace-all edit, which is not what the diff alone implies", () => {
    const summary = buildToolSummary("edit", {
      path: "/a.ts",
      replaceAll: true,
      edits: [{ oldText: "a", newText: "b" }],
    });
    assert.match(summary, /ALL occurrences/);
  });

  test("describes a read with its window", () => {
    assert.equal(
      buildToolSummary("read", { path: "/a.ts", offset: 10, limit: 20 }),
      "Read /a.ts offset 10 limit 20",
    );
    assert.equal(buildToolSummary("read", { path: "/a.ts" }), "Read /a.ts");
  });

  test("falls back to clipped JSON for an unknown tool", () => {
    const summary = buildToolSummary("mystery", { a: "x".repeat(400) });
    assert.match(summary, /^mystery: /);
    assert.ok(summary.length < 200);
  });
});
