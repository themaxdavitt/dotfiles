/**
 * Persistence for session-level plans.
 *
 * Plain ESM JavaScript, not TypeScript, on purpose: this module has two
 * consumers with different runtimes. `index.ts` runs inside Pi (jiti, TS fine),
 * but `bin/session-plan.js` is launched by bare `node` from the DEPLOYED
 * target, where there is no node_modules and therefore no tsx to strip types.
 * Before the 2026-07-29 split the CLI carried its own copy of these functions,
 * so the tested code and the running code were different code. One file now.
 * Types are carried in JSDoc; there is no tsc step for this extension.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

/** @typedef {"draft" | "approved" | "rejected" | "dismissed"} SessionPlanStatus */

/**
 * @typedef {object} SessionPlanRecord
 * @property {string} id
 * @property {string} [title]
 * @property {string} cwd
 * @property {SessionPlanStatus} status
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string} planPath
 * @property {string} [feedback]
 * @property {string} [runId]
 * @property {string} [plannotatorDataDir]
 */

/**
 * @typedef {object} ApprovedSessionPlan
 * @property {string} id
 * @property {string} [title]
 * @property {string} [cwd]
 * @property {string} [planPath]
 * @property {string} content
 * @property {string} [approvedAt]
 */

/**
 * Pi's agent dir. The CLI cannot import `getAgentDir` from the Pi package
 * (which resolves only inside Pi), so it reads the same env var Pi honors.
 * @returns {string}
 */
export function defaultAgentDir() {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/** @param {string} agentDir @returns {string} */
export function getSessionPlanDir(agentDir) {
  return join(agentDir, "session-planner", "plans");
}

/**
 * Per-run Plannotator state, isolated so concurrent planner runs cannot collide
 * on Plannotator's shared slug-based archive and history files.
 * @param {string} agentDir @param {string} runId @returns {string}
 */
export function getPlannotatorDataDir(agentDir, runId) {
  return join(agentDir, "session-planner", "plannotator", runId);
}

/** @param {string} agentDir @returns {string} */
function latestApprovedPath(agentDir) {
  return join(getSessionPlanDir(agentDir), "latest-approved.json");
}

/** @param {string} agentDir @param {string} id @returns {string} */
function metadataPath(agentDir, id) {
  return join(getSessionPlanDir(agentDir), `${id}.json`);
}

/** @param {string} agentDir @param {string} id @returns {string} */
function markdownPath(agentDir, id) {
  return join(getSessionPlanDir(agentDir), `${id}.md`);
}

/** @param {string | undefined} title @returns {string | undefined} */
function sanitizeTitle(title) {
  const trimmed = title?.trim();
  return trimmed ? trimmed.slice(0, 120) : undefined;
}

/** Sortable timestamp plus enough randomness to survive same-second runs.
 *  @returns {string} */
export function makePlanId() {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

/** @param {string} agentDir @param {SessionPlanRecord} record */
function writeRecord(agentDir, record) {
  mkdirSync(getSessionPlanDir(agentDir), { recursive: true });
  writeFileSync(metadataPath(agentDir, record.id), `${JSON.stringify(record, null, 2)}\n`);
}

/** @param {string} path @returns {SessionPlanRecord | undefined} */
function readRecord(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!parsed?.id || !parsed.planPath) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * @param {string} agentDir
 * @param {string} cwd
 * @param {{ title?: string, plan: string, runId?: string, plannotatorDataDir?: string }} params
 * @returns {SessionPlanRecord}
 */
export function saveSessionPlanDraft(agentDir, cwd, params) {
  const id = makePlanId();
  const now = new Date().toISOString();
  mkdirSync(getSessionPlanDir(agentDir), { recursive: true });
  const planPath = markdownPath(agentDir, id);
  writeFileSync(planPath, params.plan);
  /** @type {SessionPlanRecord} */
  const record = {
    id,
    title: sanitizeTitle(params.title),
    cwd,
    status: "draft",
    createdAt: now,
    updatedAt: now,
    planPath,
    ...(params.runId ? { runId: params.runId } : {}),
    ...(params.plannotatorDataDir ? { plannotatorDataDir: params.plannotatorDataDir } : {}),
  };
  writeRecord(agentDir, record);
  return record;
}

/**
 * Resolve the approval belonging to one planner run.
 *
 * The run id is what keeps concurrent planner runs from claiming each other's
 * approvals — `latest-approved.json` alone would race.
 * @param {string} agentDir @param {string} runId
 * @returns {SessionPlanRecord | undefined}
 */
export function findApprovedSessionPlanByRunId(agentDir, runId) {
  const dir = getSessionPlanDir(agentDir);
  if (!existsSync(dir)) return undefined;
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".json") && entry !== "latest-approved.json")
    .map((entry) => readRecord(join(dir, entry)))
    .filter((record) => record?.status === "approved" && record.runId === runId)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
}

/**
 * @param {string} agentDir
 * @param {SessionPlanRecord} record
 * @param {SessionPlanStatus} status
 * @param {string} [feedback]
 * @returns {SessionPlanRecord}
 */
export function updateSessionPlanStatus(agentDir, record, status, feedback) {
  /** @type {SessionPlanRecord} */
  const next = {
    ...record,
    status,
    updatedAt: new Date().toISOString(),
    ...(feedback ? { feedback } : {}),
  };
  writeRecord(agentDir, next);
  if (status === "approved") {
    writeFileSync(latestApprovedPath(agentDir), `${JSON.stringify(next, null, 2)}\n`);
  }
  return next;
}

/**
 * Accepts a plan id, a metadata path, a bare markdown path, or "latest".
 * @param {string} agentDir @param {string} ref
 * @returns {ApprovedSessionPlan | undefined}
 */
export function resolveApprovedSessionPlan(agentDir, ref) {
  const trimmed = ref.trim();
  if (!trimmed) return undefined;

  /** @type {SessionPlanRecord | undefined} */
  let record;
  if (trimmed === "latest") {
    record = readRecord(latestApprovedPath(agentDir));
  } else if (existsSync(trimmed)) {
    const abs = resolve(trimmed);
    if (abs.endsWith(".json")) {
      record = readRecord(abs);
    } else {
      return {
        id: basename(abs).replace(/\.[^.]+$/, ""),
        planPath: abs,
        content: readFileSync(abs, "utf-8"),
      };
    }
  } else {
    record = readRecord(metadataPath(agentDir, trimmed));
  }

  if (!record) return undefined;
  const planPath = isAbsolute(record.planPath) ? record.planPath : resolve(record.planPath);
  if (!existsSync(planPath)) return undefined;
  return {
    id: record.id,
    title: record.title,
    cwd: record.cwd,
    planPath,
    content: readFileSync(planPath, "utf-8"),
    approvedAt: record.updatedAt,
  };
}

/** @param {ApprovedSessionPlan} plan @returns {string} */
export function formatApprovedSessionPlan(plan) {
  const title = plan.title ? `Title: ${plan.title}\n` : "";
  const source = plan.planPath ? `Source: ${plan.planPath}\n` : "";
  return `${title}${source}Plan ID: ${plan.id}\n\n${plan.content.trim()}`;
}
