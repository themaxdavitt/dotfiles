/**
 * Turn planning for Gatekeeper.
 *
 * The agent must declare a plan (via the `set_turn_plan` tool) before it is
 * allowed to run any other tool call. The plan is scoped to a single working
 * turn and is cleared when control returns to the user (`agent_end`). It lives
 * only in memory — it is the live answer to "what is this agent doing right
 * now?", so there is nothing meaningful to restore across a session reload.
 */

import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { summarizePlanFallback } from "../auditor";
import { PLAN_TOOL } from "../policy";

export interface TurnPlan {
  /** Commit-subject-style title for the turn; rendered verbatim in the footer. */
  goal: string;
  /** Concrete actions/files/commands the agent expects to need. */
  anticipated: string[];
  /** Epoch ms when the plan was last set or revised. */
  revisedAt: number;
  /** 1 for the initial plan of a turn, incremented on each revision. */
  revision: number;
}

export const SetTurnPlanParams = Type.Object({
  goal: Type.String({
    description:
      "A title for this turn in the imperative mood and present tense, like a Git commit " +
      'subject: "Fix the failing auth test" — not "I will fix the auth test" or "Fixing ' +
      'the auth test". Keep it under 10 words with no trailing period; it is rendered ' +
      "verbatim in the status bar. When one user message carries several requests, title " +
      "the overall aim here and list the individual tasks in `anticipated`.",
  }),
  anticipated: Type.Array(Type.String(), {
    description:
      "Short list of the concrete actions, files, or commands you expect to need " +
      '(e.g. "edit src/auth.ts", "run the test suite", "maybe touch a fixture"). ' +
      "Best-effort — revise by calling set_turn_plan again as you learn more.",
  }),
});

export const PLAN_PROMPT_SNIPPET =
  "set_turn_plan: declare your plan for the current turn before using any other tool.";

/**
 * Only what the tool schema cannot carry. The schema (`SetTurnPlanParams`) says
 * how to fill the fields; this says when to call the tool and how long a plan
 * lives. Both are sent on every request, so anything stated in both is paid for
 * twice and drifts apart on the first edit that touches one of them.
 */
export const PLAN_PROMPT_GUIDELINES = [
  "Before calling ANY other tool, including read-only tools, call `set_turn_plan`.",
  "Revise by calling `set_turn_plan` again whenever your intended approach changes as you learn more.",
  "The plan is scoped to the current turn and is automatically cleared when control returns to the user.",
];

/** The live plan for the current turn, owned here rather than in index.ts. */
export interface TurnPlanStore {
  current(): TurnPlan | undefined;
  /** Short footer summary: the goal, clipped locally to nine words. Empty when
   *  there is no plan. */
  statusText(): string;
  clear(): void;
}

export function createTurnPlanTool(deps: {
  /** Repaint the status bar; called on every plan change. */
  onChange(ctx: ExtensionContext): void;
}): { tool: ToolDefinition; store: TurnPlanStore } {
  let plan: TurnPlan | undefined;
  let statusText = "";

  const store: TurnPlanStore = {
    current: () => plan,
    statusText: () => statusText,
    clear: () => {
      plan = undefined;
      statusText = "";
    },
  };

  const tool: ToolDefinition = {
    name: PLAN_TOOL,
    label: "Plan",
    // The lifecycle and revision rules live in PLAN_PROMPT_GUIDELINES, not here.
    description:
      "Declare your plan for the current turn. You MUST call this before any other tool.",
    promptSnippet: PLAN_PROMPT_SNIPPET,
    promptGuidelines: PLAN_PROMPT_GUIDELINES,
    parameters: SetTurnPlanParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const revision = (plan?.revision ?? 0) + 1;
      plan = {
        goal: params.goal,
        anticipated: params.anticipated ?? [],
        revisedAt: Date.now(),
        revision,
      };
      // Clipped locally rather than model-summarized: `goal` is specified as a
      // Git-commit-style title under 10 words, so a round-trip per turn would
      // only be re-summarizing something already written as a summary. Removed
      // 2026-07-30 along with summarizePlanForFooter.
      statusText = summarizePlanFallback(plan);
      deps.onChange(ctx);

      return { content: [{ type: "text", text: "Plan recorded. Proceed." }] };
    },
    renderCall(args, theme) {
      const goal = typeof args.goal === "string" ? args.goal : "";
      return new Text(theme.fg("toolTitle", theme.bold("plan ")) + theme.fg("muted", goal), 0, 0);
    },
    renderResult(result, _options, theme) {
      const text = result.content[0];
      return new Text(theme.fg("dim", text?.type === "text" ? text.text : ""), 0, 0);
    },
  };

  return { tool, store };
}
