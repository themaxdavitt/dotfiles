/**
 * Session Planner Extension
 *
 * Splits planning from implementation across two Pi runs. A read-only planning
 * Pi (launched by `bin/session-plan.js` under its own nono profile) submits a
 * markdown plan for Plannotator review; once approved, the implementing Pi
 * loads it with `--approved-session-plan <id>` and carries it in its system
 * prompt for the whole session.
 *
 * Split out of the Gatekeeper extension on 2026-07-29. It shares no code with
 * Gatekeeper: the one thing Gatekeeper still wants — the approved plan text, so
 * its Bash auditor can judge commands against it — travels over Pi's shared
 * extension event bus. Deleting this directory is therefore a complete removal
 * of the workflow; nothing in Gatekeeper breaks.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
// .js, not .ts: `bin/session-plan.js` imports the same module under bare node
// from the deployed target, where no tsx exists. See src/store.js.
import {
  formatApprovedSessionPlan,
  resolveApprovedSessionPlan,
  saveSessionPlanDraft,
  updateSessionPlanStatus,
} from "./src/store.js";
import { reviewPlanWithPlannotator } from "./src/plannotator";

/** Mirrors the JSDoc typedef in src/store.js; there is no tsc step here, so
 *  this is documentation the editor can use rather than a checked contract. */
interface ApprovedSessionPlan {
  id: string;
  title?: string;
  cwd?: string;
  planPath?: string;
  content: string;
  approvedAt?: string;
}

export const SESSION_PLAN_TOOL = "submit_session_plan";

/**
 * Event-bus contract with the Gatekeeper extension. Gatekeeper subscribes and
 * feeds the text to its Bash auditor; it never reads plan files itself. Keep
 * the channel name and payload in sync with Gatekeeper's `src/gate.ts`.
 */
export const APPROVED_PLAN_CHANNEL = "session-planner:approved-plan";
export interface ApprovedPlanEvent {
  text: string | undefined;
}

const SubmitSessionPlanParams = Type.Object({
  title: Type.Optional(
    Type.String({
      description: "Short human-readable title for this session-level plan.",
    }),
  ),
  plan: Type.String({
    description:
      "Complete markdown session-level plan to review. Include context, approach, steps, and verification.",
  }),
});

export default function sessionPlanner(pi: ExtensionAPI) {
  pi.registerFlag("session-planner", {
    description: "Run as the read-only planning Pi (submits a plan for Plannotator review)",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("approved-session-plan", {
    description: "Approved session plan id, metadata path, markdown path, or 'latest'",
    type: "string",
  });

  let plannerMode = false;
  let approvedSessionPlan: ApprovedSessionPlan | undefined;

  function publishApprovedPlan() {
    const event: ApprovedPlanEvent = {
      text: approvedSessionPlan ? formatApprovedSessionPlan(approvedSessionPlan) : undefined,
    };
    pi.events.emit(APPROVED_PLAN_CHANNEL, event);
  }

  function updateStatus(ctx: ExtensionContext) {
    const theme = ctx.ui.theme;
    ctx.ui.setStatus("session-planner", plannerMode ? theme.fg("accent", "planner") : "");
    ctx.ui.setStatus(
      "session-planner-plan",
      approvedSessionPlan ? theme.fg("dim", `plan ${truncate(approvedSessionPlan.id, 24)}`) : "",
    );
  }

  /** The submit tool exists only in planner mode; an implementing Pi must not
   *  be able to mint its own approvals. */
  function enforceToolPolicy() {
    const active = pi.getActiveTools();
    const has = active.includes(SESSION_PLAN_TOOL);
    if (plannerMode && !has) pi.setActiveTools([...active, SESSION_PLAN_TOOL]);
    else if (!plannerMode && has) {
      pi.setActiveTools(active.filter((tool) => tool !== SESSION_PLAN_TOOL));
    }
  }

  function applySessionConfig(ctx: ExtensionContext) {
    plannerMode = pi.getFlag("session-planner") === true;

    const ref = pi.getFlag("approved-session-plan");
    if (typeof ref === "string" && ref.trim()) {
      const loaded = resolveApprovedSessionPlan(getAgentDir(), ref);
      if (loaded) approvedSessionPlan = loaded;
      else console.error(`Session planner: could not load approved session plan ${ref}`);
    } else if (!plannerMode) {
      approvedSessionPlan = undefined;
    }

    enforceToolPolicy();
    publishApprovedPlan();
    updateStatus(ctx);
  }

  pi.registerTool({
    name: SESSION_PLAN_TOOL,
    label: "Session Plan",
    description:
      "Submit the complete markdown session-level plan for Plannotator review. " +
      "Only available in planner mode.",
    promptSnippet: `${SESSION_PLAN_TOOL}: submit the full markdown session plan for approval before implementation.`,
    promptGuidelines: [
      `Use \`${SESSION_PLAN_TOOL}\` only after you have enough read-only context to propose a concrete session plan.`,
      `Submit markdown to \`${SESSION_PLAN_TOOL}\` that includes the goal, relevant context, steps, risks, and verification.`,
      `If \`${SESSION_PLAN_TOOL}\` returns annotations or feedback, revise the plan and submit it again.`,
    ],
    parameters: SubmitSessionPlanParams,
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (!plannerMode) {
        return {
          content: [
            { type: "text", text: "Session-plan submission is only available in planner mode." },
          ],
          details: { approved: false, status: "unavailable" },
        };
      }
      const markdown = params.plan.trim();
      if (!markdown) {
        return {
          content: [
            {
              type: "text",
              text: "Session plan was empty. Revise and submit a complete markdown plan.",
            },
          ],
          details: { approved: false, status: "empty" },
        };
      }

      const draft = saveSessionPlanDraft(getAgentDir(), ctx.cwd, {
        title: params.title,
        plan: markdown,
        runId: process.env.SESSION_PLANNER_RUN_ID,
        plannotatorDataDir: process.env.PLANNOTATOR_DATA_DIR,
      });
      const review = await reviewPlanWithPlannotator(draft.planPath, { signal });

      if (review.status === "approved") {
        const record = updateSessionPlanStatus(getAgentDir(), draft, "approved");
        approvedSessionPlan = resolveApprovedSessionPlan(getAgentDir(), record.id);
        publishApprovedPlan();
        updateStatus(ctx);
        return {
          content: [
            {
              type: "text",
              text:
                `Session plan approved. Plan ID: ${record.id}\n\n` +
                `The implementing Pi can load it with --approved-session-plan ${record.id}.`,
            },
          ],
          details: {
            approved: true,
            status: "approved",
            planId: record.id,
            planPath: record.planPath,
          },
          terminate: true,
        };
      }

      // "unavailable" and "error" both mean the reviewer never rendered a
      // verdict, so neither may be recorded as a rejection by the human.
      const status = review.status === "dismissed" ? "dismissed" : "rejected";
      const record = updateSessionPlanStatus(getAgentDir(), draft, status, review.feedback);
      const intro =
        review.status === "annotated"
          ? "Plannotator requested plan revisions."
          : review.status === "dismissed"
            ? "Plannotator dismissed the review without approval."
            : review.status === "unavailable"
              ? "Plannotator is not installed, so the plan could not be reviewed."
              : "Plannotator review failed.";
      return {
        content: [
          {
            type: "text",
            text: `${intro}\n\n${review.feedback}\n\nPlan saved at ${record.planPath}. Revise and submit again.`,
          },
        ],
        details: {
          approved: false,
          status: review.status,
          planId: record.id,
          planPath: record.planPath,
          feedback: review.feedback,
        },
      };
    },
    renderCall(args, theme) {
      const title =
        typeof args.title === "string" && args.title.trim() ? args.title.trim() : "session plan";
      return new Text(
        theme.fg("toolTitle", theme.bold("session plan ")) + theme.fg("muted", title),
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const text = result.content.find((item) => item.type === "text");
      return new Text(theme.fg("dim", text?.type === "text" ? text.text : ""), 0, 0);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    applySessionConfig(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    applySessionConfig(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    enforceToolPolicy();
    updateStatus(ctx);
    if (!approvedSessionPlan) return undefined;
    // Pi chains systemPrompt across handlers, so appending here composes with
    // whatever Gatekeeper adds.
    return {
      systemPrompt: [
        event.systemPrompt,
        "",
        "=== APPROVED SESSION PLAN ===",
        formatApprovedSessionPlan(approvedSessionPlan),
        "",
        "Keep work aligned with this approved session plan. Use set_turn_plan for the current turn before any tool call.",
      ].join("\n"),
    };
  });

  pi.on("tool_call", async (event) => {
    if (event.toolName !== SESSION_PLAN_TOOL || plannerMode) return undefined;
    return { block: true, reason: "Session-plan submission is only available in planner mode." };
  });
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
