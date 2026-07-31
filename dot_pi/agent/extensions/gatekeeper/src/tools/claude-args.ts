/**
 * Claude-shaped compatibility for Pi's built-in tools.
 *
 * Claude-trained models call Read/Write/Edit/Bash with Claude Code's parameter
 * names (`file_path`, `old_string`, `replace_all`, `run_in_background`). Pi's
 * schemas use its own, so those calls either fail validation or — worse — have
 * the extra parameter silently dropped.
 *
 * Adapted 2026-07-29 from ~/Projects/2026-pi-claude-p (src/tool-overrides.ts,
 * src/tool-mapping.ts), leaving behind everything tied to the `claude -p`
 * provider it was written for.
 *
 * Pure translation only, with no Pi imports, so it stays testable outside
 * Pi; the tool definitions that apply it live in ./builtins.ts.
 */

type Args = Record<string, unknown>;

function str(args: Args, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === "string") return value;
  }
  return undefined;
}

/**
 * Rewrite Claude's parameter spellings to Pi's, in place, before schema
 * validation. Unknown shapes pass through untouched — this is a translation
 * layer, not a validator.
 */
export function translateClaudeArgs(raw: unknown): Args {
  if (typeof raw !== "object" || raw === null) return raw as Args;
  const args = { ...(raw as Args) };

  const path = str(args, "path", "file_path", "filePath");
  if (path !== undefined) {
    args.path = path;
    delete args.file_path;
    delete args.filePath;
  }

  // Claude's single-edit form; Pi takes an `edits` array.
  const oldText = str(args, "old_string", "oldText");
  const newText = str(args, "new_string", "newText");
  if (oldText !== undefined && newText !== undefined && !Array.isArray(args.edits)) {
    args.edits = [{ oldText, newText }];
    delete args.old_string;
    delete args.new_string;
    delete args.oldText;
    delete args.newText;
  }

  if (typeof args.replace_all === "boolean") {
    args.replaceAll = args.replace_all;
    delete args.replace_all;
  }
  if (typeof args.run_in_background === "boolean") {
    args.runInBackground = args.run_in_background;
    delete args.run_in_background;
  }
  return args;
}

/**
 * Count non-overlapping occurrences — `split().length - 1` without building the
 * array. An empty needle would loop forever, so it is reported as absent.
 */
export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

export const BACKGROUND_BASH_REFUSAL =
  "Background execution is not supported: Pi has no background bash, and the command was NOT " +
  "started. Re-run it in the foreground, or start it yourself in a separate terminal/tmux.";
