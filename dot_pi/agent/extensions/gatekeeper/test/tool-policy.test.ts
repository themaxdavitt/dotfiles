import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  hiddenBuiltinToolBlockReason,
  isHiddenBuiltinTool,
  normalizeGatekeeperTools,
} from "../src/tool-policy";

const OPTIONS = { planTool: "set_turn_plan" };

describe("isHiddenBuiltinTool", () => {
  test("hides the built-ins that duplicate Bash CLI commands", () => {
    assert.equal(isHiddenBuiltinTool("ls"), true);
    assert.equal(isHiddenBuiltinTool("find"), true);
    assert.equal(isHiddenBuiltinTool("grep"), true);
  });

  test("leaves the gated and in-process tools alone", () => {
    assert.equal(isHiddenBuiltinTool("bash"), false);
    assert.equal(isHiddenBuiltinTool("read"), false);
    assert.equal(isHiddenBuiltinTool("edit"), false);
  });
});

describe("hiddenBuiltinToolBlockReason", () => {
  test("names the tool and points at the replacement", () => {
    assert.match(hiddenBuiltinToolBlockReason("grep"), /Bash CLI commands/);
    assert.match(hiddenBuiltinToolBlockReason("grep"), /grep/);
  });
});

describe("normalizeGatekeeperTools", () => {
  test("strips hidden built-ins and forces the plan tool in", () => {
    assert.deepEqual(normalizeGatekeeperTools(["read", "ls", "grep", "bash"], OPTIONS), [
      "read",
      "bash",
      "set_turn_plan",
    ]);
  });

  test("leaves other extensions' tools alone", () => {
    // Gatekeeper used to add and remove session-planner's tool here. Since the
    // 2026-07-29 split that extension owns its own activation, and stripping a
    // tool Gatekeeper does not know about would silently break it.
    assert.deepEqual(
      normalizeGatekeeperTools(["read", "submit_session_plan", "AskUserQuestion"], OPTIONS),
      ["read", "submit_session_plan", "AskUserQuestion", "set_turn_plan"],
    );
  });

  test("is idempotent", () => {
    const once = normalizeGatekeeperTools(["read", "ls", "bash"], OPTIONS);
    assert.deepEqual(normalizeGatekeeperTools(once, OPTIONS), once);
  });

  test("does not duplicate the plan tool when it is already active", () => {
    assert.deepEqual(normalizeGatekeeperTools(["set_turn_plan", "read"], OPTIONS), [
      "set_turn_plan",
      "read",
    ]);
  });
});
