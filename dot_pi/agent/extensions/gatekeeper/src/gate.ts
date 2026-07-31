/**
 * The tool-call gate: Gatekeeper's decision pipeline, in one place.
 *
 * Everything that touches the outside world — the AST analyzer, the nono
 * profile query, the auditor model, the approval dialog — arrives as an
 * injected collaborator, so the ordering of the checks (which is the actual
 * security property) can be tested without a live Pi. index.ts owns the
 * collaborators and the translation to Pi's `{ block, reason }` shape.
 *
 * Order matters and is deliberate:
 *   1. hidden built-ins        — never available, whatever the mode
 *   2. the turn plan           — nothing runs before the agent declares one
 *   3. danger mode             — the documented escape hatch, checked early
 *   4. the file-tool profile   — in-process tools that the OS cannot confine
 *   5. file writes             — manual mode puts a human in front of each one
 *   6. elevated_bash           — always a human decision
 *   7. bash analysis + audit   — the allowlist → auditor → human stack
 *
 * 4 before 5 matters: a profile denial carries richer reasons and prompts on
 * its own, so running it first is also what keeps manual mode from asking twice
 * about the same write.
 */

import type { AuditResult } from "./auditor";
import type { FileGateDenial } from "./sandbox/nono";
import type { AnalysisResult } from "./hazmat/analyze";
import {
  ELEVATED_BASH_TOOL,
  type GatekeeperConfig,
  PLAN_TOOL,
  isFileMutatingTool,
  isPermissionGatedTool,
  resolveFileMutationDecision,
  resolveGatedBashDecision,
} from "./policy";
import { hiddenBuiltinToolBlockReason, isHiddenBuiltinTool } from "./tool-policy";
import type { ConsentResult } from "./ui/summary";

/** The event fields the gate reads. Narrower than Pi's ToolCallEvent so tests
 *  can hand over a literal. */
export interface GateToolCall {
  toolName: string;
  input: { command?: string; path?: string; [key: string]: unknown };
}

export interface GateDeps {
  config: GatekeeperConfig;
  /** Undefined until the agent calls `set_turn_plan` this turn. */
  hasPlan: boolean;
  /** Whether a human can actually be prompted right now. */
  askAvailable: boolean;
  /** Name of the active nono profile, for denial wording. */
  nonoProfile: string;
  analyze(command: string): Promise<AnalysisResult>;
  gateFile(event: GateToolCall): Promise<FileGateDenial | undefined>;
  audit(summary: string): Promise<AuditResult>;
  ask(toolName: string, input: unknown, reasons?: string[]): Promise<ConsentResult>;
  /** Rendered lazily: only the paths that actually audit or prompt need it. */
  summarize(toolName: string, input: unknown): string;
  /** Surfaces analyzer warnings once per session. */
  reportWarnings(warnings: string[]): void;
}

export type GateOutcome =
  | { kind: "allow"; note?: string; startsBash: boolean }
  | { kind: "block"; reason: string };

/** Turn a dialog answer into an outcome. The decline reason IS the tool result
 *  the model reads, so the user's message has to reach it. */
function consent(result: ConsentResult, startsBash: boolean): GateOutcome {
  if (result.allowed) {
    return { kind: "allow", note: result.message, startsBash };
  }
  return {
    kind: "block",
    reason: result.message ? `Declined by user: ${result.message}` : "Declined by user",
  };
}

export async function decideToolCall(event: GateToolCall, deps: GateDeps): Promise<GateOutcome> {
  const { config } = deps;

  if (isHiddenBuiltinTool(event.toolName)) {
    return { kind: "block", reason: hiddenBuiltinToolBlockReason(event.toolName) };
  }

  // Declaring the plan is what satisfies the plan gate, so it can never be
  // subject to it.
  if (event.toolName === PLAN_TOOL) return { kind: "allow", startsBash: false };

  if (!deps.hasPlan && !config.planExemptTools.includes(event.toolName)) {
    return {
      kind: "block",
      reason: `Gatekeeper: call ${PLAN_TOOL} to declare your plan for this turn before running any tool.`,
    };
  }

  if (config.mode === "danger") {
    return { kind: "allow", startsBash: event.toolName === "bash" };
  }

  // Pseudo-sandbox the in-process file tools against the tools profile. (danger
  // returned above; bash stays OS-sandboxed via the spawn hook in every mode.)
  // On denial, elevation is a human decision — the file tools are already
  // unsandboxed, so an approval simply lets the normal in-process tool run with
  // full edit/diff semantics.
  const fileDenial = await deps.gateFile(event);
  if (fileDenial) {
    if (!deps.askAvailable) return { kind: "block", reason: fileDenial.blockReason };
    return consent(
      await deps.ask(event.toolName, event.input, [
        `'${deps.nonoProfile}' profile denies ${fileDenial.op} on ${fileDenial.path} (${fileDenial.detail})`,
        "Approving runs the tool anyway, from the unsandboxed Pi process",
      ]),
      false,
    );
  }

  // The profile allowed the write; manual mode still wants a human to see it.
  // No `reasons` here on purpose — the dialog renders the path and the diff,
  // and "because the mode says so" is not evidence.
  if (isFileMutatingTool(event.toolName)) {
    const decision = resolveFileMutationDecision(config.mode, deps.askAvailable);
    if (decision.action === "block") {
      return { kind: "block", reason: decision.reason ?? "Gatekeeper: blocked" };
    }
    if (decision.action === "ask") {
      return consent(await deps.ask(event.toolName, event.input), false);
    }
  }

  if (event.toolName === ELEVATED_BASH_TOOL) {
    // Elevation is always a human decision: the auditor never approves it, and
    // headless sessions cannot. (danger returned earlier.)
    if (!deps.askAvailable) {
      return {
        kind: "block",
        reason: "Gatekeeper: elevated_bash requires interactive user approval",
      };
    }
    return consent(
      await deps.ask(event.toolName, event.input, [
        "Runs OUTSIDE the per-call nono sandbox, directly from the unsandboxed Pi process",
      ]),
      false,
    );
  }

  if (!isPermissionGatedTool(event.toolName)) return { kind: "allow", startsBash: false };

  const analysis = await deps.analyze(String(event.input.command ?? ""));
  deps.reportWarnings(analysis.warnings);
  if (!analysis.gated) return { kind: "allow", startsBash: true };

  let decision = resolveGatedBashDecision(config.mode, deps.askAvailable);
  if (decision.action === "audit") {
    const audit = await deps.audit(deps.summarize(event.toolName, event.input));
    decision = resolveGatedBashDecision(config.mode, deps.askAvailable, audit);
  }

  if (decision.action === "allow") return { kind: "allow", startsBash: true };
  if (decision.action === "block") {
    return { kind: "block", reason: decision.reason ?? "Gatekeeper: blocked" };
  }

  // The analyzer's reasons are always shown. They are the entire basis for
  // interrupting the user, so a dialog without them asks for a decision while
  // withholding the evidence for it.
  const reasons = [...(decision.reason ? [decision.reason] : []), ...analysis.reasons];
  return consent(
    await deps.ask(event.toolName, event.input, reasons.length ? reasons : undefined),
    true,
  );
}
