/**
 * Gatekeeper's bash registration.
 *
 * Two jobs stacked on Pi's built-in definition:
 *   1. OS confinement — `sandboxSpawnHook` rewrites every spawned command into
 *      `nono run …`. This registration is the ONLY thing installing that hook,
 *      which is why no other extension may register `bash` (see AGENTS.md).
 *   2. Execution timing — Pi measures the whole tool call, including the time
 *      the call spent waiting on an approval dialog. The gate records the
 *      moment consent landed, and the renderers below prefer that over the
 *      call's own start so an approved command does not report the human's
 *      thinking time as runtime.
 */

import type {
  BashToolDetails,
  ToolDefinition,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { sandboxSpawnHook } from "../sandbox/wrap";
import { withBackgroundBashRefusal, withClaudeArgNames } from "./builtins";

export interface GatekeeperBashToolDetails extends BashToolDetails {
  executionTimeMs?: number;
}

interface BashRenderState {
  startedAt?: number;
  endedAt?: number;
}

export interface BashTool {
  tool: ToolDefinition;
  /** Called by the gate the instant a command is cleared to run. */
  markExecutionStart(toolCallId: string): void;
  /** Consumes the recorded start and returns the details patch, if any. */
  takeExecutionTime(event: ToolResultEvent): GatekeeperBashToolDetails | undefined;
}

export function createGatekeeperBashTool(cwd: string): BashTool {
  const bashTool = createBashToolDefinition(cwd, { spawnHook: sandboxSpawnHook });
  if (!bashTool.renderCall || !bashTool.renderResult) {
    throw new Error("Gatekeeper requires Pi's built-in bash renderers");
  }
  const executionStarts = new Map<string, number>();

  /** Adopt the gate's start time whenever it is newer than what the renderer
   *  has, so a re-render after approval corrects the earlier estimate. */
  function adoptActualStart(state: BashRenderState, toolCallId: string): number | undefined {
    const actual = executionStarts.get(toolCallId);
    if (actual !== undefined && (state.startedAt === undefined || state.startedAt < actual)) {
      state.startedAt = actual;
      state.endedAt = undefined;
    }
    return actual;
  }

  // prepareArguments runs first (run_in_background -> runInBackground), then
  // the wrapped execute sees the normalized name.
  const tool: ToolDefinition = withClaudeArgNames(
    withBackgroundBashRefusal({
      ...bashTool,
      renderCall(args, theme, context) {
        const state = context.state as BashRenderState;
        const actual = adoptActualStart(state, context.toolCallId);
        if (actual === undefined && context.executionStarted && state.startedAt === undefined) {
          state.startedAt = Date.now();
          state.endedAt = undefined;
        }
        return bashTool.renderCall!(args, theme, context);
      },
      renderResult(result, options, theme, context) {
        const state = context.state as BashRenderState;
        const details = result.details as GatekeeperBashToolDetails | undefined;
        adoptActualStart(state, context.toolCallId);
        if (!options.isPartial && typeof details?.executionTimeMs === "number") {
          const endedAt =
            state.startedAt !== undefined ? state.startedAt + details.executionTimeMs : Date.now();
          state.startedAt = endedAt - details.executionTimeMs;
          state.endedAt = endedAt;
        }
        return bashTool.renderResult!(result, options, theme, context);
      },
    }),
  );

  return {
    tool,
    markExecutionStart(toolCallId) {
      executionStarts.set(toolCallId, Date.now());
    },
    takeExecutionTime(event) {
      const startedAt = executionStarts.get(event.toolCallId);
      if (startedAt === undefined) return undefined;
      executionStarts.delete(event.toolCallId);
      return {
        ...(event.details as BashToolDetails | undefined),
        executionTimeMs: Math.max(0, Date.now() - startedAt),
      };
    },
  };
}
