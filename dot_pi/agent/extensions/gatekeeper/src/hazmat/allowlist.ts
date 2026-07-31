/**
 * Safe Command Allowlist (Default-Deny)
 *
 * Only commands listed here are allowed to run without user approval.
 * Everything else is gated — the user must explicitly approve it.
 *
 * Each entry is either:
 *   `true`                        → always safe regardless of arguments
 *   `(args: string[]) => boolean` → safe only when the predicate returns true
 *
 * Design principle: false positives (unnecessary prompts) are annoying but safe.
 * False negatives (missed mutations) are dangerous. When in doubt, omit the command.
 *
 * The upstream fork carried unwired per-command analyzers (git, npm, curl, tar,
 * wget, …); they were deliberately dropped on vendoring (2026-07-18) in favor of
 * this deliberately small list. Recover them from the fork or git history if a
 * command ever earns its way in.
 */

export type CommandRule = true | ((args: string[]) => boolean);

// ── Conditional-safe helpers ────────────────────────────────────────────

function isNonoSafe(args: string[]): boolean {
  if (args[0] !== "why") return false;

  // `nono why` reads policy state, but its --log-file flag writes. Bare words
  // alone are accepted so a variable, quote, escape, or glob cannot resolve
  // to that flag after the analyzer has waived the prompt.
  return args
    .slice(1)
    .every(
      (arg) =>
        /^[A-Za-z0-9_./:=,@%+-]+$/.test(arg) &&
        arg !== "--log-file" &&
        !arg.startsWith("--log-file="),
    );
}

/**
 * Bash `printf -v NAME FORMAT …` assigns to NAME instead of writing stdout.
 * In particular, `printf -v PATH …; ls` changes lookup after bin trust has
 * approved it. `getCommandArgs` preserves each argument's raw shell spelling,
 * so only accept a first argument whose leading literal cannot become an
 * option after expansion. `--` explicitly ends Bash's option parsing.
 */
function isPrintfSafe(args: string[]): boolean {
  if (args.length === 0 || args[0] === "--") return true;

  const first = args[0];
  // A complete single-quoted word has no expansion; preserve common
  // `printf '%s\n' value` usage while rejecting quoted option spellings.
  const singleQuoted = /^'([^']*)'$/.exec(first);
  if (singleQuoted) return !singleQuoted[1].startsWith("-");

  // A leading literal from this set survives shell expansion and cannot turn
  // into `-v`. Everything else (quotes, $, backslashes, globs, braces, …)
  // is conservatively gated rather than trying to implement shell expansion.
  return /^[A-Za-z0-9_+.,/%:=@]/.test(first);
}

// NOTE: "sed" intentionally omitted from the allowlist entirely. Its dangerous
// operations live *inside* the sed mini-language — `w`/`W` (write file), `e`
// (execute shell, command or `s///e` flag), `r`/`R` (read file), plus `-i`
// (in-place) and `-f file`/`-f -` (script we can't inspect). Statically proving a
// sed script is read-only means parsing that language, and the heuristics needed
// are false-positive-prone. Defense-in-depth: always gate sed.

// ── Allowlist ───────────────────────────────────────────────────────────

// Starting small. Basically just a prompt-avoidance heuristic, a collection of commands that can't (AFAIK) exec something else (the sandbox handles read/writes just fine).
export const SAFE_COMMANDS: Record<string, CommandRule> = {
  cat: true,
  head: true,
  tail: true,
  grep: true,
  ls: true,
  pwd: true,
  wc: true,
  nono: isNonoSafe,
  true: true,
  test: true,
  cd: true,
  ":": true,
  false: true,
  "[": true,
  echo: true,
  printf: isPrintfSafe,
  type: true,
  times: true,
  wait: true,
};

// ── Benign command wrappers ─────────────────────────────────────────────
// These prefix another command without adding danger.
// The analyzer unwraps them to check the inner command.

export const BENIGN_WRAPPERS = new Set([
  "nice",
  "nohup",
  "builtin",
  "command",
  "time",
  "stdbuf",
  "timeout",
]);
