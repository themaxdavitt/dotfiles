/**
 * LLM-based tool-call auditor.
 *
 * Given the agent's declared turn plan and a bash command that the static analyzer
 * could not prove safe,
 * a cheap model judges whether the call is within the plan's scope and safe.
 *
 * This is the middle layer of a defense-in-depth stack:
 *   AST allowlist (free) → LLM auditor (cheap) → human dialog (expensive).
 * Only AST-gated bash calls reach the auditor. Any failure to reach a clear
 * verdict resolves to "ask" when a human prompt is available, otherwise "block".
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NONO_SYSTEM_CONTEXT } from "./sandbox/nono";
import type { TurnPlan } from "./tools/turn-plan";

export type AuditVerdict = "allow" | "ask" | "block";

export interface AuditResult {
  verdict: AuditVerdict;
  reason: string;
}

export interface AuditorModelRef {
  provider: string;
  modelId: string;
}

function buildPlanSummary(plan: TurnPlan): string {
  const lines = [`Goal: ${plan.goal}`];
  if (plan.anticipated.length > 0) {
    lines.push("", "Anticipated:");
    for (const action of plan.anticipated) lines.push(`  - ${action}`);
  }
  return lines.join("\n");
}

function auditInstructions(canAsk: boolean): string {
  const verdicts = canAsk ? '"allow" | "ask" | "block"' : '"allow" | "block"';
  const askGuidance = canAsk
    ? [
        '  "ask"   — anything uncertain: ambiguous scope, unclear blast radius, or it needs human',
        "            judgement. When in doubt, choose ask — a human will be prompted.",
      ]
    : [
        '  "block" — anything uncertain, ambiguous, or requiring human judgement. A human',
        "            prompt is not available for this action, so do not return ask.",
      ];
  return [
    "You are a security gate for an autonomous coding agent. The agent declared a plan for its",
    "current turn. It now wants to run a tool call that a static analyzer flagged as effectful",
    "(a bash command that is not on a read-only allowlist).",
    "",
    `Decide one of these verdicts: ${verdicts}`,
    '  "allow" — the call is clearly consistent with the declared plan AND not dangerous.',
    '  "block" — the call is clearly destructive, dangerous, or plainly outside the plan',
    "            (e.g. exfiltrating secrets, deleting unrelated data, disabling safety, rm -rf /).",
    ...askGuidance,
    "",
    "Be conservative: it is fine to allow routine, in-scope work, but do not guess.",
    "",
    "Respond with ONLY a JSON object, no prose, no markdown fences:",
    `{"verdict": ${verdicts}, "reason": "one short sentence"}`,
  ].join("\n");
}

/**
 * The invariant half of the request: rubric and sandbox context, varying only
 * with `canAsk`. Kept a *system* prompt rather than the head of the user
 * message because that is the field both cache conventions key on — though
 * nothing here currently caches, for the reasons measured above the `complete`
 * call, so the split earns clarity rather than money today.
 *
 * Deliberately short. Every token is re-billed on every audited command, and a
 * working session issues many; twenty-one worked examples lived here from
 * 2026-07-29 to 2026-07-30 on the theory that a longer prefix would start
 * earning cache hits, which measurement disproved. Anything added here should
 * be justified by better verdicts, not by prompt length.
 */
export function buildAuditSystemPrompt(canAsk: boolean): string {
  return [
    auditInstructions(canAsk),
    "",
    // Until the 2026-07-18 sandbox inversion this section told the auditor that
    // Gatekeeper could not inspect the sandbox policy. It now can: the command
    // being judged runs under the same profile described here.
    "=== SANDBOX CONTEXT ===",
    NONO_SYSTEM_CONTEXT,
    "Judge intent and scope against the plan; the sandbox already decides what the",
    "operating system will permit, so do not re-litigate that here.",
  ].join("\n");
}

/**
 * The varying half: the plans in force and the one call being judged.
 *
 * @param approvedPlanContext Pre-formatted session-plan text, when the
 *   session-planner extension published one over the event bus. Gatekeeper
 *   never reads plan files itself, so this arrives as opaque text.
 */
export function buildAuditUserPrompt(
  plan: TurnPlan,
  toolName: string,
  summary: string,
  approvedPlanContext?: string,
): string {
  return [
    ...(approvedPlanContext ? ["=== APPROVED SESSION PLAN ===", approvedPlanContext, ""] : []),
    "=== AGENT'S DECLARED PLAN ===",
    buildPlanSummary(plan),
    "",
    `=== TOOL CALL TO JUDGE (tool: ${toolName}) ===`,
    summary,
    "",
    "Respond with the JSON verdict object now.",
  ].join("\n");
}

/*
 * No `sessionId` / `cacheRetention` here, deliberately. Measured against
 * openai-codex/gpt-5.6-luna on 2026-07-30, over fourteen real audits:
 *
 *   prompt size    input   cacheRead   cost/call (output 25)
 *   ~1.3k (real)    1364           0   $0.00151
 *   ~5.0k (probe)   1146        3840   $0.00168
 *
 * At the real size nothing qualified and every audit billed in full. Even at
 * 5k, where caching did engage, ~1.1k tokens still billed uncached — about the
 * size of this whole prompt — so the cache read lands on top of a full-price
 * remainder rather than replacing it, and padding the prompt up to that size
 * costs MORE than staying small. Whether that ~1.1k floor is fixed or scales
 * with the prefix was not measured; either way it sinks the trade here.
 * Derived rates: $1.00/1M input, $6.00/1M output, $0.10/1M cache read.
 *
 * `sessionId` was not merely inert but harmful — it is what makes pi-ai pool
 * the codex websocket (`acquireWebSocket` keeps a socket per session id, on a
 * 5-minute `SESSION_WEBSOCKET_CACHE_TTL_MS` idle timer), and nothing in pi
 * calls `closeOpenAICodexWebSocketSessions`, so the open handle held the event
 * loop and delayed `pi -p` exit by up to five minutes.
 *
 * Re-measure with `GATEKEEPER_AUDIT_USAGE=1` before reinstating either, and
 * only if the auditor moves to a provider with a lower effective floor.
 */

/**
 * A runaway guard, not a tight budget: the verdict is one short JSON object,
 * but a reasoning model may spend tokens before emitting it. Truncation makes
 * `parseVerdict` fail, which falls back to "ask" (or "block" when nobody can be
 * asked) — safe, but noisy, so leave headroom.
 */
const AUDITOR_MAX_TOKENS = 1024;

function fallbackVerdict(canAsk: boolean, reason: string): AuditResult {
  return { verdict: canAsk ? "ask" : "block", reason };
}

/**
 * Per-call token accounting, printed to stderr when `GATEKEEPER_AUDIT_USAGE` is
 * set. Off by default because the auditor fires on most bash calls and the TUI
 * has nowhere good to put the line.
 *
 * This is the only way to tell whether the prompt-cache split is actually
 * paying: the whole design rests on `cacheRead` covering the system half from
 * the second audited command onward, and nothing else in the session surfaces
 * that — the auditor's spend never reaches pi's own usage display. Re-check it
 * after any edit to the system prompt, which is also when `AUDITOR_CACHE_KEY`
 * needs its bump.
 */
function reportAuditUsage(usage: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { total: number };
}): void {
  if (!process.env.GATEKEEPER_AUDIT_USAGE) return;
  console.error(
    `Gatekeeper audit usage: input=${usage.input} cacheRead=${usage.cacheRead} ` +
      `cacheWrite=${usage.cacheWrite} output=${usage.output} cost=$${usage.cost.total.toFixed(6)}`,
  );
}

export function parseVerdict(text: string, canAsk: boolean): AuditResult {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ?? text.match(/(\{[\s\S]*\})/);
  const jsonStr = match?.[1] ?? text.trim();
  try {
    const parsed = JSON.parse(jsonStr) as { verdict?: unknown; reason?: unknown };
    const verdict = parsed.verdict;
    if (verdict !== "allow" && verdict !== "ask" && verdict !== "block") {
      return fallbackVerdict(canAsk, "Auditor returned an invalid verdict");
    }
    if (!canAsk && verdict === "ask") {
      return { verdict: "block", reason: "Auditor returned ask when asking is unavailable" };
    }
    const reason =
      typeof parsed.reason === "string" && parsed.reason.trim()
        ? parsed.reason.trim()
        : "(no reason given)";
    return { verdict, reason };
  } catch {
    return fallbackVerdict(canAsk, "Could not parse auditor response");
  }
}

function getAuditorModel(ctx: ExtensionContext, auditor: AuditorModelRef) {
  return ctx.modelRegistry.find(auditor.provider, auditor.modelId) ?? ctx.model;
}

/**
 * Audit a single tool call against the plan. Resolves the configured auditor
 * model, falling back to the session's active model. Never throws — failures
 * become "ask" when possible, otherwise "block".
 */
export async function auditToolCall(
  ctx: ExtensionContext,
  plan: TurnPlan,
  toolName: string,
  summary: string,
  auditor: AuditorModelRef,
  canAsk: boolean,
  approvedPlanContext?: string,
): Promise<AuditResult> {
  const model = getAuditorModel(ctx, auditor);
  if (!model) {
    return fallbackVerdict(canAsk, "No auditor model available");
  }

  let auth: Awaited<ReturnType<typeof ctx.modelRegistry.getApiKeyAndHeaders>>;
  try {
    auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  } catch (err) {
    return fallbackVerdict(
      canAsk,
      `Auditor auth failed: ${err instanceof Error ? err.message : err}`,
    );
  }
  if (!auth.ok || !auth.apiKey) {
    return fallbackVerdict(canAsk, "Auditor model has no usable API key");
  }

  const prompt = buildAuditUserPrompt(plan, toolName, summary, approvedPlanContext);
  try {
    const { complete } = await import("@earendil-works/pi-ai");
    const response = await complete(
      model,
      {
        systemPrompt: buildAuditSystemPrompt(canAsk),
        messages: [
          { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() },
        ],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        signal: ctx.signal,
        // No `temperature: 0` here, however much a security gate wants to be
        // reproducible. The default auditor is an openai-codex model, and
        // pi-ai forwards temperature straight into that Responses request,
        // which answers "Unsupported parameter: temperature" — its Anthropic
        // path guards on a `supportsTemperature` capability flag, its codex
        // path does not. Verified against pi 0.83.0 on 2026-07-30, where it
        // failed every audited command closed. Reinstate it only behind an
        // api check if the auditor ever moves to a provider that takes it.
        maxTokens: AUDITOR_MAX_TOKENS,
      },
    );
    reportAuditUsage(response.usage);
    // A provider-side failure comes back as a normal message with an empty
    // body, not a thrown error. Without this it reached parseVerdict as "" and
    // became "Could not parse auditor response" — a block whose reason blamed
    // the model's output for what was actually a rejected request.
    if (response.stopReason === "error") {
      return fallbackVerdict(
        canAsk,
        `Auditor request failed: ${response.errorMessage ?? "unknown"}`,
      );
    }
    const text = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    return parseVerdict(text, canAsk);
  } catch (err) {
    return fallbackVerdict(
      canAsk,
      `Auditor call failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}

export function summarizePlanFallback(plan: TurnPlan): string {
  const words = plan.goal
    .replace(/[^\w\s./-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 9);
  return words.length > 0 ? words.join(" ") : "Current turn plan";
}
