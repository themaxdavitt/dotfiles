import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  canAskUser,
  isFileMutatingTool,
  isPermissionGatedTool,
  isPermissionMode,
  resolveFileMutationDecision,
  resolveGatedBashDecision,
} from "../src/policy";

describe("canAskUser", () => {
  test("requires both headful ask mode and a UI", () => {
    assert.equal(canAskUser("headful", true), true);
    assert.equal(canAskUser("headful", false), false);
    assert.equal(canAskUser("never", true), false);
    assert.equal(canAskUser("never", false), false);
  });
});

describe("isPermissionMode", () => {
  test("accepts the three modes", () => {
    assert.equal(isPermissionMode("manual"), true);
    assert.equal(isPermissionMode("auto"), true);
    assert.equal(isPermissionMode("danger"), true);
  });

  test("rejects anything else", () => {
    assert.equal(isPermissionMode("acceptEdits"), false);
    // Retired names, all on 2026-07-29. Rejecting them falls back to
    // DEFAULT_CONFIG.mode (manual), which is the safe direction for every one:
    // "default" WAS manual, and "plan" was stricter than manual, never looser.
    assert.equal(isPermissionMode("default"), false);
    assert.equal(isPermissionMode("plan"), false);
    assert.equal(isPermissionMode("bypassPermissions"), false);
    assert.equal(isPermissionMode(""), false);
    assert.equal(isPermissionMode(undefined), false);
    assert.equal(isPermissionMode(null), false);
    assert.equal(isPermissionMode(1), false);
  });
});

describe("isPermissionGatedTool", () => {
  test("gates bash and nothing else", () => {
    assert.equal(isPermissionGatedTool("bash"), true);
    assert.equal(isPermissionGatedTool("edit"), false);
    assert.equal(isPermissionGatedTool("write"), false);
    assert.equal(isPermissionGatedTool("read"), false);
    assert.equal(isPermissionGatedTool("elevated_bash"), false);
  });
});

describe("isFileMutatingTool", () => {
  test("covers the in-process writers", () => {
    assert.equal(isFileMutatingTool("edit"), true);
    assert.equal(isFileMutatingTool("write"), true);
  });

  test("excludes the tools with their own gate", () => {
    // bash is OS-confined and goes through the AST analyzer; elevated_bash
    // always reaches a human. Listing either here would double-gate it.
    assert.equal(isFileMutatingTool("bash"), false);
    assert.equal(isFileMutatingTool("elevated_bash"), false);
    assert.equal(isFileMutatingTool("read"), false);
  });
});

describe("resolveFileMutationDecision", () => {
  test("manual asks before every write", () => {
    assert.deepEqual(resolveFileMutationDecision("manual", true), { action: "ask" });
  });

  test("manual blocks rather than writing unattended", () => {
    // A `manual` mode that silently allows writes when nobody can be asked
    // would be the worse surprise, so this matches what gated bash does.
    const decision = resolveFileMutationDecision("manual", false);
    assert.equal(decision.action, "block");
    assert.match(decision.reason ?? "", /--gatekeeper-mode auto/);
  });

  test("auto allows: delegating that judgment is what auto means", () => {
    assert.deepEqual(resolveFileMutationDecision("auto", true), { action: "allow" });
    assert.deepEqual(resolveFileMutationDecision("auto", false), { action: "allow" });
  });
});

describe("resolveGatedBashDecision", () => {
  test("danger allows without asking", () => {
    assert.deepEqual(resolveGatedBashDecision("danger", false), { action: "allow" });
    assert.deepEqual(resolveGatedBashDecision("danger", true), { action: "allow" });
  });

  test("manual asks when it can, blocks when it cannot", () => {
    assert.deepEqual(resolveGatedBashDecision("manual", true), { action: "ask" });
    assert.equal(resolveGatedBashDecision("manual", false).action, "block");
  });

  test("auto requests an audit before deciding", () => {
    assert.deepEqual(resolveGatedBashDecision("auto", true), { action: "audit" });
    assert.deepEqual(resolveGatedBashDecision("auto", false), { action: "audit" });
  });

  test("auto honors an allow verdict", () => {
    assert.deepEqual(resolveGatedBashDecision("auto", false, { verdict: "allow", reason: "ok" }), {
      action: "allow",
    });
  });

  test("auto escalates ask and block verdicts to the human when one is available", () => {
    assert.equal(
      resolveGatedBashDecision("auto", true, { verdict: "ask", reason: "unclear" }).action,
      "ask",
    );
    // A block verdict still reaches the user: the auditor advises, it does not
    // get the final word while someone is there to overrule it.
    assert.equal(
      resolveGatedBashDecision("auto", true, { verdict: "block", reason: "danger" }).action,
      "ask",
    );
  });

  test("auto blocks when the verdict needs a human and there is none", () => {
    assert.equal(
      resolveGatedBashDecision("auto", false, { verdict: "block", reason: "danger" }).action,
      "block",
    );
    assert.equal(
      resolveGatedBashDecision("auto", false, { verdict: "ask", reason: "unclear" }).action,
      "block",
    );
  });

  test("carries the auditor's reasoning into the decision", () => {
    const decision = resolveGatedBashDecision("auto", true, {
      verdict: "block",
      reason: "rm -rf outside the workspace",
    });
    assert.match(decision.reason ?? "", /rm -rf outside the workspace/);
  });
});
