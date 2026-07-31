/**
 * Gatekeeper Extension — wiring only.
 *
 * Adds a permission layer to Pi:
 *   1. Planning — the agent must declare a turn plan (`set_turn_plan`) before
 *      any other tool call.
 *   2. Bash gating — commands not proven safe by the AST allowlist and the
 *      PATH-aware bin-trust check are gated by mode.
 *   3. Auditing — in `auto`, a cheap model judges gated Bash commands against
 *      the declared plan before falling back to a human prompt when configured.
 *
 * OS-level containment is per tool call, not per session: Pi itself runs
 * unsandboxed, every unprivileged bash command is wrapped in `nono run` against
 * the tools profile (src/sandbox/wrap.ts), and the in-process file tools are
 * blocked when a `nono why` query says the same profile would deny the path
 * (src/sandbox/nono.ts). `elevated_bash` escapes all of it behind a per-command
 * dialog. User-typed `!` bash bypasses the tool layer entirely, so it is
 * confined through `user_bash` instead; `!!` is the way out.
 *
 * The decision logic itself lives in src/gate.ts; everything here is
 * registration, live session state, and translation to Pi's event shapes.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { createLocalBashOperations, getAgentDir } from "@earendil-works/pi-coding-agent";
import { type AuditResult, type AuditorModelRef, auditToolCall } from "./src/auditor";
import {
  DEFAULT_AUDITOR,
  DEFAULT_CONFIG,
  gatekeeperConfigPath,
  loadFileConfig,
} from "./src/config";
import { type GateToolCall, decideToolCall } from "./src/gate";
import { type BinTrustConfig, DEFAULT_BIN_TRUST, resolveTrustEnv } from "./src/hazmat/bin-trust";
import { analyzeCommand } from "./src/hazmat/analyze";
import {
  type GatekeeperConfig,
  PLAN_TOOL,
  canAskUser,
  isAskMode,
  isPermissionMode,
  shouldSandboxUserBash,
} from "./src/policy";
import { NONO_SYSTEM_CONTEXT, appendNonoDenialGuidance, gateFileTool } from "./src/sandbox/nono";
import { warmProxyCa } from "./src/sandbox/warmup";
import { configureToolsPath, sandboxBashOperations, toolsProfile } from "./src/sandbox/wrap";
import { showSettings } from "./src/settings";
import { buildStatusEntries, planStatusText } from "./src/status";
import { normalizeGatekeeperTools } from "./src/tool-policy";
import { createGatekeeperBashTool } from "./src/tools/bash";
import { createEditTool, createReadTool, createWriteTool } from "./src/tools/builtins";
import { createElevatedBashTool } from "./src/tools/elevated";
import { createTurnPlanTool } from "./src/tools/turn-plan";
import { showGatekeeperDialog } from "./src/ui/dialog";
import { buildToolSummary } from "./src/ui/summary";

/**
 * Published by the session-planner extension when it has an approved plan.
 * Gatekeeper never reads plan files itself — it only relays this text to the
 * auditor — so deleting that extension leaves nothing here to clean up.
 * Keep in sync with session-planner/index.ts.
 */
const APPROVED_PLAN_CHANNEL = "session-planner:approved-plan";

export default function gatekeeper(pi: ExtensionAPI) {
  pi.registerFlag("gatekeeper-mode", {
    description: "Gatekeeper permission mode: manual, auto, or danger",
    type: "string",
  });
  pi.registerFlag("gatekeeper-ask", {
    description: "Gatekeeper ask mode: headful or never",
    type: "string",
  });

  let config: GatekeeperConfig = { ...DEFAULT_CONFIG };
  let auditorModel: AuditorModelRef = DEFAULT_AUDITOR;
  let binTrust: BinTrustConfig = DEFAULT_BIN_TRUST;
  let approvedPlanContext: string | undefined;
  let proxyCaWarmed = false;

  // `mise which` failures and bad roots are reported once per session, not on
  // every gated command.
  const reportedTrustWarnings = new Set<string>();
  function reportTrustWarnings(warnings: string[]) {
    for (const warning of warnings) {
      if (reportedTrustWarnings.has(warning)) continue;
      reportedTrustWarnings.add(warning);
      console.error(`Gatekeeper: ${warning}`);
    }
  }

  // Notes the user typed while approving a dialog, delivered by prepending them
  // to that call's tool result. pi.sendMessage from inside a tool_call hook
  // lands AFTER the in-flight call settles, so the model would otherwise read
  // the note one step too late (and answer things like "already did").
  const approvalNotes = new Map<string, string>();

  const bash = createGatekeeperBashTool(process.cwd());
  const turnPlan = createTurnPlanTool({
    onChange: (ctx) => updatePlanStatus(ctx),
  });

  pi.registerTool(bash.tool);
  pi.registerTool(turnPlan.tool);
  pi.registerTool(createElevatedBashTool());
  // Registered here, not in claude-tools: overriding a built-in name is
  // last-writer-wins, and bash's override carries the sandbox spawn hook.
  pi.registerTool(createReadTool(process.cwd()));
  pi.registerTool(createWriteTool(process.cwd()));
  pi.registerTool(createEditTool(process.cwd()));

  pi.events.on(APPROVED_PLAN_CHANNEL, (data) => {
    const text = (data as { text?: unknown } | undefined)?.text;
    approvedPlanContext = typeof text === "string" && text.trim() ? text : undefined;
  });

  function updateStatus(ctx: ExtensionContext) {
    const theme = ctx.ui.theme;
    for (const entry of buildStatusEntries(config, toolsProfile())) {
      ctx.ui.setStatus(entry.key, theme.fg(entry.tone, entry.text));
    }
  }

  function updatePlanStatus(ctx: ExtensionContext) {
    const text = planStatusText(turnPlan.store.current() ? turnPlan.store.statusText() : undefined);
    // Not "gatekeeper-plan": this is the per-TURN plan, and session-planner
    // owns a neighboring status key for the session plan.
    ctx.ui.setStatus("gatekeeper-turn-plan", text ? ctx.ui.theme.fg("dim", text) : "");
  }

  function enforceToolPolicy() {
    const activeTools = pi.getActiveTools();
    const nextTools = normalizeGatekeeperTools(activeTools, { planTool: PLAN_TOOL });
    if (
      activeTools.length !== nextTools.length ||
      activeTools.some((name, index) => name !== nextTools[index])
    ) {
      pi.setActiveTools(nextTools);
    }
  }

  async function applySessionConfig(ctx: ExtensionContext) {
    const loaded = loadFileConfig(gatekeeperConfigPath(getAgentDir()));
    config = loaded.config;
    auditorModel = loaded.auditor;
    binTrust = loaded.binTrust;

    // One resolution feeds both sides: the PATH pinned onto every wrapped
    // command and the PATH the analyzer resolves against. Two lists here would
    // mean gating a lookup that never happens.
    const trustEnv = await resolveTrustEnv({ cwd: ctx.cwd, config: binTrust });
    configureToolsPath(trustEnv.searchDirs);
    reportTrustWarnings(trustEnv.warnings);

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== "gatekeeper-config") continue;
      const data = entry.data as Partial<GatekeeperConfig> | undefined;
      if (isPermissionMode(data?.mode)) config.mode = data.mode;
      if (isAskMode(data?.askMode)) config.askMode = data.askMode;
    }

    const flagMode = pi.getFlag("gatekeeper-mode");
    const flagAsk = pi.getFlag("gatekeeper-ask");
    if (isPermissionMode(flagMode)) config.mode = flagMode;
    if (isAskMode(flagAsk)) config.askMode = flagAsk;

    enforceToolPolicy();
    updateStatus(ctx);
    updatePlanStatus(ctx);
  }

  pi.on("session_start", async (_event, ctx) => {
    await applySessionConfig(ctx);

    // Awaited on purpose: when the CA is current this returns immediately, and
    // when it is stale the whole point is to settle the keychain prompt before
    // the agent runs anything. Once per process — `session_tree` re-runs the
    // config, not this. `~/bin/pi` normally gets here first, in which case this
    // is the fast path.
    if (!proxyCaWarmed) {
      proxyCaWarmed = true;
      const warmup = await warmProxyCa();
      if (!warmup.ok) console.error(`Gatekeeper: ${warmup.detail}`);
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    await applySessionConfig(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    enforceToolPolicy();
    updateStatus(ctx);
    return { systemPrompt: [event.systemPrompt, "", NONO_SYSTEM_CONTEXT].join("\n") };
  });

  pi.on("agent_end", async (_event, ctx) => {
    turnPlan.store.clear();
    updatePlanStatus(ctx);
    approvalNotes.clear();
  });

  // A `!` command never reaches `tool_call` — pi runs user-typed bash through
  // `AgentSession.executeBash`, outside the tool layer, so the bash tool's
  // spawn hook cannot see it. Replacing the operations is the only seam pi
  // offers, and `user_bash` fires on both the TUI and the RPC/ACP front end.
  //
  // Pi's own local operations are the delegate, so `!` keeps its normal shell
  // behavior; only the command string and the env change. No `shellPath` is
  // threaded through because the wrapper pins `bash --noprofile --norc` inside
  // nono anyway — the outer shell exists only to exec `nono`.
  pi.on("user_bash", async (event) => {
    if (!shouldSandboxUserBash(event.excludeFromContext)) return undefined;
    return { operations: sandboxBashOperations(createLocalBashOperations()) };
  });

  pi.registerCommand("gatekeeper", {
    description: "Gatekeeper settings",
    handler: async (_args, ctx) => {
      await showSettings(ctx, {
        config: () => config,
        auditorModel: () => auditorModel,
        onChange: (apply, changedCtx) => {
          apply(config);
          updateStatus(changedCtx);
          pi.appendEntry("gatekeeper-config", config);
        },
      });
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    enforceToolPolicy();
    const plan = turnPlan.store.current();
    const askAvailable = canAskUser(config.askMode, ctx.hasUI);

    const outcome = await decideToolCall(event as GateToolCall, {
      config,
      hasPlan: plan !== undefined,
      askAvailable,
      nonoProfile: toolsProfile(),
      analyze: (command) => analyzeCommand(command, { cwd: ctx.cwd, config: binTrust }),
      gateFile: (call) => gateFileTool(call, ctx.cwd),
      audit: (summary) =>
        // Non-null: the gate only audits bash, which is unreachable without a plan.
        auditToolCall(
          ctx,
          plan!,
          event.toolName,
          summary,
          auditorModel,
          askAvailable,
          approvedPlanContext,
        ) as Promise<AuditResult>,
      ask: (toolName, input, reasons) => showGatekeeperDialog(ctx, toolName, input, reasons),
      summarize: buildToolSummary,
      reportWarnings: reportTrustWarnings,
    });

    if (outcome.kind === "block") return { block: true, reason: outcome.reason };
    if (outcome.startsBash) bash.markExecutionStart(event.toolCallId);
    if (outcome.note) approvalNotes.set(event.toolCallId, outcome.note);
    return undefined;
  });

  pi.on("tool_result", async (event) => {
    const patch: ToolResultEventResult = {};
    if (event.toolName === "bash") {
      const details = bash.takeExecutionTime(event);
      if (details) patch.details = details;
    }

    let content = event.content;
    const approvalNote = approvalNotes.get(event.toolCallId);
    if (approvalNote !== undefined) {
      approvalNotes.delete(event.toolCallId);
      content = [
        { type: "text", text: `[User note sent with this approval] ${approvalNote}` },
        ...content,
      ];
      patch.content = content;
    }

    const nonoPatch = appendNonoDenialGuidance({ ...event, content });
    if (nonoPatch?.content) patch.content = nonoPatch.content;
    if (nonoPatch?.isError !== undefined) patch.isError = nonoPatch.isError;

    return Object.keys(patch).length > 0 ? patch : undefined;
  });
}
