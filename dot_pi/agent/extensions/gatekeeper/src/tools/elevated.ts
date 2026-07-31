/**
 * The `elevated_bash` tool definition.
 *
 * The command runs completely outside the per-call nono sandbox, so the gate
 * demands explicit human approval for every call before this ever executes
 * (src/gate.ts) — that dialog is the entire privilege boundary.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { ELEVATED_BASH_TOOL } from "../policy";
import { runElevated } from "../sandbox/elevated";

export function createElevatedBashTool(): ToolDefinition {
  return {
    name: ELEVATED_BASH_TOOL,
    label: "Elevated Bash",
    description:
      "Run one shell command OUTSIDE the per-call nono sandbox that wraps normal bash. " +
      "Every call requires explicit user approval. Use only when work is provably " +
      "blocked by the sandbox (see [nono sandbox diagnostic] output) or must outlive it " +
      "(e.g. starting a background service); otherwise use bash.",
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to run outside the sandbox" }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const timeoutMs = typeof params.timeout === "number" ? params.timeout * 1000 : undefined;
      const { output, exitCode } = await runElevated(params.command, ctx.cwd, signal, timeoutMs);
      if (exitCode !== 0) throw new Error(`exit ${exitCode}\n${output}`.trim());
      return { content: [{ type: "text", text: output || "(no output)" }] };
    },
    renderCall(args, theme) {
      const command = typeof args.command === "string" ? args.command : "";
      return new Text(
        theme.fg("warning", theme.bold("elevated ")) + theme.fg("muted", command),
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const text = result.content.find((item) => item.type === "text");
      return new Text(theme.fg("dim", text?.type === "text" ? text.text : ""), 0, 0);
    },
  };
}
