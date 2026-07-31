import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildAuditSystemPrompt,
  buildAuditUserPrompt,
  parseVerdict,
  summarizePlanFallback,
} from "../src/auditor";
import type { TurnPlan } from "../src/tools/turn-plan";

const plan: TurnPlan = {
  goal: "Inspect the auth module and update the failing login tests",
  anticipated: ["read src/auth.ts", "edit tests/auth.test.ts"],
  revisedAt: 0,
  revision: 1,
};

describe("the audit prompt, split into a cacheable system half and a varying user half", () => {
  test("keeps everything per-call out of the system half", () => {
    // The whole point of the split: the system prompt is what both cache
    // conventions key on, so a plan or a command leaking into it would
    // invalidate the prefix on every single call.
    const system = buildAuditSystemPrompt(true);
    assert.doesNotMatch(system, /AGENT'S DECLARED PLAN/);
    assert.doesNotMatch(system, /TOOL CALL TO JUDGE/);
    assert.doesNotMatch(system, /APPROVED SESSION PLAN/);
  });

  test("stays small enough that re-billing it on every audit stays cheap", () => {
    // This asserted a >1024-token FLOOR until 2026-07-30, on the theory that a
    // longer system half would start earning prefix-cache hits. Measured
    // against the real auditor model, it earns none at any size worth paying
    // for, so the pressure runs the other way: every token here is billed
    // again on every audited command, and a session issues many. Approximated
    // at 4 chars/token, which understates a prompt this dense in JSON and
    // shell — the real count runs about 15% higher.
    for (const canAsk of [true, false]) {
      const tokens = buildAuditSystemPrompt(canAsk).length / 4;
      assert.ok(tokens < 600, `system prompt grew to ~${Math.round(tokens)} tokens`);
    }
  });

  test("offers the ask verdict only when a human can be reached", () => {
    const askPrompt = buildAuditSystemPrompt(true);
    assert.match(askPrompt, /\{"verdict": "allow" \| "ask" \| "block"/);

    const noAskPrompt = buildAuditSystemPrompt(false);
    assert.match(noAskPrompt, /\{"verdict": "allow" \| "block"/);
    assert.doesNotMatch(noAskPrompt, /\{"verdict": "allow" \| "ask" \| "block"/);
  });

  test("tells the headless auditor not to return ask", () => {
    assert.match(buildAuditSystemPrompt(false), /do not return ask/);
  });

  test("carries the declared plan and the command under judgement", () => {
    const prompt = buildAuditUserPrompt(plan, "bash", "npm test");
    assert.match(prompt, /AGENT'S DECLARED PLAN/);
    assert.match(prompt, /Inspect the auth module/);
    assert.match(prompt, /read src\/auth\.ts/);
    assert.match(prompt, /TOOL CALL TO JUDGE \(tool: bash\)/);
    assert.match(prompt, /npm test/);
  });

  test("includes approved-plan context when the event bus published some", () => {
    // Opaque text, not a parsed record: since the 2026-07-29 split Gatekeeper
    // never reads plan files, it only relays what session-planner emitted.
    const prompt = buildAuditUserPrompt(
      plan,
      "bash",
      "npm test",
      "Title: Auth fix\n\n1. Inspect auth.",
    );
    assert.match(prompt, /APPROVED SESSION PLAN/);
    assert.match(prompt, /Inspect auth/);
    assert.match(prompt, /AGENT'S DECLARED PLAN/);
  });

  test("omits the approved-plan section when there is none", () => {
    assert.doesNotMatch(buildAuditUserPrompt(plan, "bash", "npm test"), /APPROVED SESSION PLAN/);
  });

  test("tells the auditor the command runs sandboxed", () => {
    // Pre-inversion this section claimed Gatekeeper could not see the sandbox
    // policy, which stopped being true on 2026-07-18. It belongs in the system
    // half: it is identical for every call in the session.
    const system = buildAuditSystemPrompt(true);
    assert.match(system, /SANDBOX CONTEXT/);
    assert.match(system, /nono sandbox/);
    assert.doesNotMatch(system, /cannot inspect that sandbox policy/);
  });
});

describe("parseVerdict", () => {
  test("accepts a bare JSON verdict", () => {
    assert.deepEqual(parseVerdict('{"verdict":"allow","reason":"in scope"}', true), {
      verdict: "allow",
      reason: "in scope",
    });
  });

  test("accepts a verdict wrapped in a markdown fence", () => {
    assert.deepEqual(parseVerdict('```json\n{"verdict":"block","reason":"rm -rf /"}\n```', true), {
      verdict: "block",
      reason: "rm -rf /",
    });
  });

  test("downgrades ask to block when asking is unavailable", () => {
    assert.deepEqual(parseVerdict('{"verdict":"ask","reason":"needs user"}', false), {
      verdict: "block",
      reason: "Auditor returned ask when asking is unavailable",
    });
  });

  test("falls back conservatively on unparseable output", () => {
    assert.equal(parseVerdict("not json", true).verdict, "ask");
    assert.equal(parseVerdict("not json", false).verdict, "block");
  });

  test("falls back conservatively on an unknown verdict", () => {
    assert.equal(parseVerdict('{"verdict":"maybe"}', true).verdict, "ask");
    assert.equal(parseVerdict('{"verdict":"maybe"}', false).verdict, "block");
  });

  test("substitutes a placeholder for a missing or blank reason", () => {
    assert.equal(parseVerdict('{"verdict":"allow"}', true).reason, "(no reason given)");
    assert.equal(
      parseVerdict('{"verdict":"allow","reason":"   "}', true).reason,
      "(no reason given)",
    );
  });
});

// The only footer path since the model-written summarizer was dropped on
// 2026-07-30, so these now cover what the status bar actually renders.
describe("summarizePlanFallback", () => {
  test("stays within the footer's word budget", () => {
    assert.ok(summarizePlanFallback(plan).split(/\s+/).length <= 9);
  });

  test("never returns empty, even for a goal of pure punctuation", () => {
    assert.equal(summarizePlanFallback({ ...plan, goal: "!!! ???" }), "Current turn plan");
  });

  test("passes a commit-style title through unchanged", () => {
    // What `goal`'s description now asks the model for: under 10 words,
    // imperative, no trailing period. Clipping must be a no-op on that shape.
    const title = "Fix the failing auth test";
    assert.equal(summarizePlanFallback({ ...plan, goal: title }), title);
  });
});
