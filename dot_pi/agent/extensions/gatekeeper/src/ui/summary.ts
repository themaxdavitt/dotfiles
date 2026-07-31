/**
 * What the user (and the auditor) actually reads about a pending tool call.
 *
 * Kept free of Pi imports so the gate can use it and the tests can reach it —
 * dialog.ts, which renders this, cannot be imported outside Pi.
 */

export interface ConsentResult {
  allowed: boolean;
  /** Free text the user attached while approving or declining. */
  message?: string;
}

export function buildToolSummary(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "write": {
      const path = input.path as string;
      const content = input.content as string;
      const lines = content?.split("\n").length ?? 0;
      return `Write ${path} (${lines} lines)\n\n${content}`;
    }
    case "edit": {
      const path = input.path as string;
      const edits = input.edits as Array<{ oldText: string; newText: string }> | undefined;
      const count = edits?.length ?? 1;
      const scope = input.replaceAll === true ? ", ALL occurrences" : "";
      let summary = `Edit ${path} (${count} edit${count !== 1 ? "s" : ""}${scope})`;
      if (edits) {
        for (let i = 0; i < edits.length; i++) {
          const e = edits[i];
          if (count > 1) summary += `\n\n── edit ${i + 1} ──`;
          else summary += "\n";
          for (const line of e.oldText.split("\n")) summary += `\n- ${line}`;
          for (const line of e.newText.split("\n")) summary += `\n+ ${line}`;
        }
      }
      return summary;
    }
    // Both show the exact command, untruncated: approving elevation on an
    // abbreviated summary would defeat the point of ask-per-command.
    case "bash":
    case "elevated_bash":
      return input.command as string;
    case "read": {
      const path = input.path as string;
      const offset = typeof input.offset === "number" ? ` offset ${input.offset}` : "";
      const limit = typeof input.limit === "number" ? ` limit ${input.limit}` : "";
      return `Read ${path}${offset}${limit}`;
    }
    default:
      return `${toolName}: ${JSON.stringify(input).slice(0, 120)}`;
  }
}
