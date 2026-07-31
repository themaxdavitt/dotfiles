/**
 * Pi's built-in tools, re-registered with Claude-shaped argument tolerance.
 *
 * These live in Gatekeeper rather than in the claude-tools extension on
 * purpose: registering a built-in tool name OVERRIDES it, so whichever
 * extension registers `bash` last wins. Gatekeeper's registration is what
 * installs the nono spawn hook, and losing that would silently remove OS
 * confinement from every bash call. One owner for built-in names, and it is the
 * one whose registration is load-bearing for security.
 *
 * The pure argument translation lives in ./claude-args.ts; this module is the
 * Pi-coupled half.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BACKGROUND_BASH_REFUSAL, countOccurrences, translateClaudeArgs } from "./claude-args";

type Args = Record<string, unknown>;

/** Attach the translation to a tool definition without touching anything else. */
export function withClaudeArgNames(tool: ToolDefinition): ToolDefinition {
  return { ...tool, prepareArguments: (args) => translateClaudeArgs(args) as never };
}

export function createReadTool(cwd: string): ToolDefinition {
  return withClaudeArgNames(createReadToolDefinition(cwd));
}

export function createWriteTool(cwd: string): ToolDefinition {
  return withClaudeArgNames(createWriteToolDefinition(cwd));
}

/**
 * Pi's `edit` throws on a non-unique `oldText`, where Claude's Edit accepts
 * `replace_all: true`. Delegate to Pi's implementation for everything except
 * the case it genuinely cannot express — a repeated `oldText` with
 * `replaceAll` set — so fuzzy matching, diffs, CRLF handling, and the file
 * mutation queue stay Pi's for the overwhelmingly common path.
 */
export function createEditTool(cwd: string): ToolDefinition {
  const builtin = createEditToolDefinition(cwd);
  const parameters = Type.Intersect([
    builtin.parameters,
    Type.Object({
      replaceAll: Type.Optional(
        Type.Boolean({ description: "Replace every occurrence of each oldText, not just one" }),
      ),
    }),
  ]);

  return {
    ...builtin,
    parameters: parameters as never,
    prepareArguments: (args) => translateClaudeArgs(args) as never,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { replaceAll, ...rest } = params as {
        replaceAll?: boolean;
        path: string;
        edits: { oldText: string; newText: string }[];
      };
      if (replaceAll !== true) {
        return builtin.execute(toolCallId, rest as never, signal, onUpdate, ctx);
      }

      const abs = isAbsolute(rest.path) ? rest.path : resolve(ctx.cwd, rest.path);
      const edits = rest.edits ?? [];
      const original = readFileSync(abs, "utf-8");
      // Only a genuinely repeated oldText needs us; a unique one still gets
      // Pi's richer handling.
      if (!edits.some((edit) => countOccurrences(original, edit.oldText) > 1)) {
        return builtin.execute(toolCallId, rest as never, signal, onUpdate, ctx);
      }

      return withFileMutationQueue(abs, async () => {
        let updated = readFileSync(abs, "utf-8");
        let replaced = 0;
        for (const edit of edits) {
          const count = countOccurrences(updated, edit.oldText);
          if (count === 0) {
            throw new Error(
              `edit: oldText not found in ${rest.path}: ${edit.oldText.slice(0, 80)}`,
            );
          }
          replaced += count;
          updated = updated.split(edit.oldText).join(edit.newText);
        }
        writeFileSync(abs, updated);
        return {
          content: [
            {
              type: "text",
              text: `Replaced all ${replaced} occurrence(s) across ${edits.length} edit(s) in ${rest.path}`,
            },
          ],
        };
      });
    },
  };
}

/**
 * Pi has no background bash by design. Refuse loudly instead of running the
 * command in the foreground, so the model never proceeds believing it left a
 * process running.
 */
export function withBackgroundBashRefusal(tool: ToolDefinition): ToolDefinition {
  const parameters = Type.Intersect([
    tool.parameters,
    Type.Object({
      description: Type.Optional(
        Type.String({ description: "Accepted for Claude compatibility; ignored" }),
      ),
      runInBackground: Type.Optional(
        Type.Boolean({ description: "Not supported by Pi; the command will be refused" }),
      ),
    }),
  ]);

  return {
    ...tool,
    parameters: parameters as never,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { runInBackground, description: _ignored, ...rest } = params as Args;
      if (runInBackground === true) {
        return {
          content: [{ type: "text", text: BACKGROUND_BASH_REFUSAL }],
          isError: true,
          details: { rejected: "run_in_background" } as never,
        };
      }
      return tool.execute(toolCallId, rest as never, signal, onUpdate, ctx);
    },
  };
}
