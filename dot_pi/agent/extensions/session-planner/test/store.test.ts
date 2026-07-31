import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  findApprovedSessionPlanByRunId,
  formatApprovedSessionPlan,
  getPlannotatorDataDir,
  getSessionPlanDir,
  makePlanId,
  resolveApprovedSessionPlan,
  saveSessionPlanDraft,
  updateSessionPlanStatus,
} from "../src/store.js";

let agentDir: string;

before(() => {
  agentDir = mkdtempSync(join(tmpdir(), "session-planner-store-"));
});

after(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

describe("paths", () => {
  test("keeps the pre-split on-disk layout", () => {
    // Real approved plans predate the 2026-07-29 extension split and live at
    // these paths; moving them would orphan the archive.
    assert.equal(getSessionPlanDir("/agent"), "/agent/session-planner/plans");
    assert.equal(
      getPlannotatorDataDir("/agent", "run-1"),
      "/agent/session-planner/plannotator/run-1",
    );
  });
});

describe("makePlanId", () => {
  test("is sortable by time and unique within the same second", () => {
    const a = makePlanId();
    const b = makePlanId();
    assert.match(a, /^\d{14}-[0-9a-f]{8}$/);
    assert.notEqual(a, b);
  });
});

describe("saveSessionPlanDraft", () => {
  test("writes the markdown and a draft record", () => {
    const draft = saveSessionPlanDraft(agentDir, "/repo", {
      title: "Auth fix",
      plan: "# Session Plan\n\n1. Inspect auth.\n2. Patch tests.",
      runId: "run-1",
      plannotatorDataDir: getPlannotatorDataDir(agentDir, "run-1"),
    });
    assert.equal(draft.status, "draft");
    assert.equal(draft.runId, "run-1");
    assert.equal(draft.cwd, "/repo");
    assert.match(draft.planPath, /\.md$/);
  });

  test("truncates an overlong title rather than rejecting it", () => {
    const draft = saveSessionPlanDraft(agentDir, "/repo", { title: "x".repeat(200), plan: "# P" });
    assert.equal(draft.title?.length, 120);
  });

  test("omits a blank title entirely", () => {
    const draft = saveSessionPlanDraft(agentDir, "/repo", { title: "   ", plan: "# P" });
    assert.equal(draft.title, undefined);
  });
});

describe("updateSessionPlanStatus", () => {
  test("promotes a draft to approved and keeps its id", () => {
    const draft = saveSessionPlanDraft(agentDir, "/repo", { title: "Approve me", plan: "# P" });
    const approved = updateSessionPlanStatus(agentDir, draft, "approved");
    assert.equal(approved.status, "approved");
    assert.equal(approved.id, draft.id);
  });

  test("records rejection feedback", () => {
    const draft = saveSessionPlanDraft(agentDir, "/repo", { plan: "# P" });
    const rejected = updateSessionPlanStatus(agentDir, draft, "rejected", "tighten scope");
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.feedback, "tighten scope");
  });
});

describe("findApprovedSessionPlanByRunId", () => {
  test("resolves the approval belonging to one planner run", () => {
    // Plannotator's own archive is slug-based and shared across runs, so the
    // run id is what keeps concurrent planner runs from claiming each other's
    // approvals.
    const draft = saveSessionPlanDraft(agentDir, "/repo", { plan: "# P", runId: "run-2" });
    const approved = updateSessionPlanStatus(agentDir, draft, "approved");
    assert.equal(findApprovedSessionPlanByRunId(agentDir, "run-2")?.id, approved.id);
  });

  test("ignores an unknown run", () => {
    assert.equal(findApprovedSessionPlanByRunId(agentDir, "missing"), undefined);
  });

  test("ignores a run whose plan was never approved", () => {
    saveSessionPlanDraft(agentDir, "/repo", { plan: "# P", runId: "run-unapproved" });
    assert.equal(findApprovedSessionPlanByRunId(agentDir, "run-unapproved"), undefined);
  });

  test("returns the newest approval when a run produced several", () => {
    const first = saveSessionPlanDraft(agentDir, "/repo", {
      title: "old",
      plan: "# P",
      runId: "run-3",
    });
    updateSessionPlanStatus(agentDir, first, "approved");
    const second = saveSessionPlanDraft(agentDir, "/repo", {
      title: "new",
      plan: "# P",
      runId: "run-3",
    });
    const newest = updateSessionPlanStatus(agentDir, second, "approved");
    assert.equal(findApprovedSessionPlanByRunId(agentDir, "run-3")?.id, newest.id);
  });

  test("returns nothing when no plan has ever been written", () => {
    const empty = mkdtempSync(join(tmpdir(), "session-planner-empty-"));
    try {
      assert.equal(findApprovedSessionPlanByRunId(empty, "run-1"), undefined);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("resolveApprovedSessionPlan", () => {
  test("resolves by plan id", () => {
    const draft = saveSessionPlanDraft(agentDir, "/repo", { title: "By id", plan: "# By id" });
    const approved = updateSessionPlanStatus(agentDir, draft, "approved");
    assert.equal(resolveApprovedSessionPlan(agentDir, approved.id)?.title, "By id");
  });

  test("resolves 'latest' to the most recent approval", () => {
    const draft = saveSessionPlanDraft(agentDir, "/repo", { title: "Newest", plan: "# Newest" });
    updateSessionPlanStatus(agentDir, draft, "approved");
    assert.equal(resolveApprovedSessionPlan(agentDir, "latest")?.title, "Newest");
  });

  test("resolves a bare markdown path", () => {
    const path = join(agentDir, "loose-plan.md");
    writeFileSync(path, "# Loose\n");
    const resolved = resolveApprovedSessionPlan(agentDir, path);
    assert.equal(resolved?.id, "loose-plan");
    assert.match(resolved?.content ?? "", /Loose/);
  });

  test("returns nothing for an unknown or empty reference", () => {
    assert.equal(resolveApprovedSessionPlan(agentDir, "no-such-id"), undefined);
    assert.equal(resolveApprovedSessionPlan(agentDir, "   "), undefined);
  });

  test("returns nothing when the record survives but its markdown does not", () => {
    const draft = saveSessionPlanDraft(agentDir, "/repo", { plan: "# Gone" });
    const approved = updateSessionPlanStatus(agentDir, draft, "approved");
    rmSync(approved.planPath);
    assert.equal(resolveApprovedSessionPlan(agentDir, approved.id), undefined);
  });
});

describe("formatApprovedSessionPlan", () => {
  test("leads with the title, source, and id so the model can cite it", () => {
    const draft = saveSessionPlanDraft(agentDir, "/repo", {
      title: "Auth fix",
      plan: "# Session Plan\n\n1. Inspect auth.",
    });
    const approved = updateSessionPlanStatus(agentDir, draft, "approved");
    const resolved = resolveApprovedSessionPlan(agentDir, approved.id);
    assert.ok(resolved);
    const formatted = formatApprovedSessionPlan(resolved);
    assert.match(formatted, /Title: Auth fix/);
    assert.match(formatted, /Plan ID: /);
    assert.match(formatted, /Inspect auth/);
  });
});
