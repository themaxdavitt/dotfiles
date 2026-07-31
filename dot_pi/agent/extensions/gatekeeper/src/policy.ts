import type { AuditResult } from "./auditor";

/**
 * Tool names the policy layer reasons about.
 *
 * They live here, not beside their tool definitions, because those definitions
 * import `@earendil-works/pi-tui` — which resolves only when the extension runs
 * inside Pi. Anything the gate imports has to stay installable-free so the
 * decision logic remains testable; see AGENTS.md.
 */
export const PLAN_TOOL = "set_turn_plan";
export const ELEVATED_BASH_TOOL = "elevated_bash";

/**
 * Who clears a gated call: a human (`manual`), the auditor model (`auto`), or
 * nobody (`danger`).
 *
 * `manual` rather than `default`, because every mode is somebody's default.
 * `danger` rather than Claude Code's `bypassPermissions`, because that name is
 * wrong here — the turn-plan requirement, the hidden-builtin blocks, and the
 * nono sandbox around Bash all survive it. See the README.
 */
export type PermissionMode = "manual" | "auto" | "danger";
export type AskMode = "headful" | "never";

export interface GatekeeperConfig {
  mode: PermissionMode;
  askMode: AskMode;
  /**
   * Tools allowed to run before `set_turn_plan` has been called.
   *
   * A tool whose whole purpose is to ask the user something has to be reachable
   * before the agent can commit to a plan, or clarifying a vague request
   * deadlocks against the plan gate. Exempt tools are still fully subject to
   * every other gate (bash analysis, the file-tool profile check, the
   * file-mutation gate).
   */
  planExemptTools: string[];
}

export type GateAction = "allow" | "audit" | "ask" | "block";

export interface GateDecision {
  action: GateAction;
  reason?: string;
}

export function canAskUser(askMode: AskMode, hasUI: boolean): boolean {
  return askMode === "headful" && hasUI;
}

export function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "manual" || value === "auto" || value === "danger";
}

export function isAskMode(value: unknown): value is AskMode {
  return value === "headful" || value === "never";
}

export function isPermissionGatedTool(toolName: string): boolean {
  return toolName === "bash";
}

/**
 * Whether a user-typed `!` command runs inside the nono sandbox.
 *
 * These commands never reach the gate: pi routes them straight to the shell
 * without a tool call, so there is no allowlist check, no auditor, and no
 * dialog — the typing *is* the consent. What was missing was OS confinement,
 * which the `!` path skipped for the structural reason that `spawnHook` hangs
 * off the bash tool. So `!` is confined like the agent's own bash, and `!!` is
 * the deliberate way out.
 *
 * That overloads `!!`, whose only prior job was keeping output out of the
 * model's context. The pairing is deliberate rather than convenient: the
 * unconfined path is the one whose output cannot reach the model, so a command
 * run with real credentials in its environment does not then narrate them into
 * the transcript. It is still worth knowing in the other direction — reaching
 * for `!!` to keep noise out of context now also drops the sandbox. (Excluded
 * output is kept out of the model's context, not off disk: the session log
 * records it either way.)
 */
export function shouldSandboxUserBash(excludeFromContext: boolean): boolean {
  return !excludeFromContext;
}

// Tools that write to the filesystem from inside the Pi process. Bash gets OS
// confinement from the nono spawn hook; these do not, so the only thing between
// them and the disk is this gate plus the file-tool profile query.
const FILE_MUTATING_TOOLS = new Set(["edit", "write"]);

export function isFileMutatingTool(toolName: string): boolean {
  return FILE_MUTATING_TOOLS.has(toolName);
}

/**
 * Whether a file write needs a human.
 *
 * `manual` means a human clears every gated call, and writing a file is the
 * most consequential thing the agent does without ever touching Bash. `auto`
 * delegates that judgment to the model by definition, and `danger` never
 * reaches here — the gate returns before this point.
 */
export function resolveFileMutationDecision(
  mode: PermissionMode,
  askAvailable: boolean,
): GateDecision {
  if (mode !== "manual") return { action: "allow" };
  return askAvailable
    ? { action: "ask" }
    : {
        action: "block",
        reason:
          "Gatekeeper: manual mode needs approval for file writes and no interactive UI is " +
          "available. Pass --gatekeeper-mode auto for an unattended run.",
      };
}

export function resolveGatedBashDecision(
  mode: PermissionMode,
  askAvailable: boolean,
  audit?: AuditResult,
): GateDecision {
  if (mode === "danger") return { action: "allow" };
  if (mode === "manual") {
    return askAvailable
      ? { action: "ask" }
      : {
          action: "block",
          reason: "Gatekeeper: approval required but asking is disabled or unavailable",
        };
  }

  if (!audit) return { action: "audit" };
  if (audit.verdict === "allow") return { action: "allow" };
  if (askAvailable)
    return { action: "ask", reason: `Auditor verdict: ${audit.verdict} - ${audit.reason}` };
  return { action: "block", reason: `Gatekeeper auditor ${audit.verdict}: ${audit.reason}` };
}
