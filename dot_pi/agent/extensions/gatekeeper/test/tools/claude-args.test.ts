/**
 * Claude-shaped argument compatibility.
 *
 * Only the pure translation is exercised here: the tool factories themselves
 * import `@earendil-works/pi-coding-agent`, which resolves only inside Pi.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BACKGROUND_BASH_REFUSAL,
  countOccurrences,
  translateClaudeArgs,
} from "../../src/tools/claude-args";

describe("translateClaudeArgs", () => {
  test("accepts Claude's file_path as well as Pi's path", () => {
    assert.equal(translateClaudeArgs({ file_path: "/a.ts" }).path, "/a.ts");
    assert.equal(translateClaudeArgs({ path: "/a.ts" }).path, "/a.ts");
  });

  test("drops the alias once translated so the schema sees one spelling", () => {
    const args = translateClaudeArgs({ file_path: "/a.ts" });
    assert.equal("file_path" in args, false);
  });

  test("prefers Pi's spelling when a model sends both", () => {
    assert.equal(translateClaudeArgs({ path: "/pi.ts", file_path: "/claude.ts" }).path, "/pi.ts");
  });

  test("folds Claude's single-edit form into Pi's edits array", () => {
    const args = translateClaudeArgs({
      file_path: "/a.ts",
      old_string: "before",
      new_string: "after",
    });
    assert.deepEqual(args.edits, [{ oldText: "before", newText: "after" }]);
    assert.equal("old_string" in args, false);
    assert.equal("new_string" in args, false);
  });

  test("leaves an explicit edits array alone", () => {
    const edits = [{ oldText: "a", newText: "b" }];
    assert.deepEqual(translateClaudeArgs({ path: "/a.ts", edits }).edits, edits);
  });

  test("translates the two boolean parameters Pi's schemas cannot express", () => {
    assert.equal(translateClaudeArgs({ replace_all: true }).replaceAll, true);
    assert.equal(translateClaudeArgs({ run_in_background: true }).runInBackground, true);
    // false is a real value, not a missing one.
    assert.equal(translateClaudeArgs({ replace_all: false }).replaceAll, false);
  });

  test("passes unrelated arguments through untouched", () => {
    assert.deepEqual(translateClaudeArgs({ command: "ls", timeout: 5 }), {
      command: "ls",
      timeout: 5,
    });
  });

  test("does not mutate the caller's object", () => {
    const original = { file_path: "/a.ts" };
    translateClaudeArgs(original);
    assert.deepEqual(original, { file_path: "/a.ts" });
  });

  test("survives a non-object payload", () => {
    assert.equal(translateClaudeArgs(null as never), null);
    assert.equal(translateClaudeArgs("nope" as never), "nope");
  });
});

describe("countOccurrences", () => {
  test("counts non-overlapping matches", () => {
    assert.equal(countOccurrences("a-a-a", "a"), 3);
    assert.equal(countOccurrences("aaaa", "aa"), 2);
    assert.equal(countOccurrences("abc", "z"), 0);
  });

  test("reports an empty needle as absent instead of looping forever", () => {
    assert.equal(countOccurrences("abc", ""), 0);
  });

  test("distinguishes unique from repeated, which is what picks the code path", () => {
    assert.equal(countOccurrences("one two", "two"), 1);
    assert.equal(countOccurrences("two two", "two"), 2);
  });
});

describe("BACKGROUND_BASH_REFUSAL", () => {
  test("states plainly that nothing was started", () => {
    // The failure mode this exists to prevent is the model believing it left a
    // process running, then polling for output that will never arrive.
    assert.match(BACKGROUND_BASH_REFUSAL, /NOT\b.*started|was NOT started/);
    assert.match(BACKGROUND_BASH_REFUSAL, /foreground/);
  });
});
