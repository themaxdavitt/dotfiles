// MIT licensed, basically stolen from:
// https://github.com/noel-debug/pi-gatekeeper/blob/d66b988efadb0a12369c095d56843ef38a73a60d/analyzer.ts
// Do not modify logic without running changes through my personal test suite.

/**
 * Bash Command Analyzer
 *
 * Uses tree-sitter-bash to parse shell commands into an AST, then walks
 * the tree to classify whether the command could mutate files.
 *
 * Detection layers:
 *   1. AST parse via tree-sitter-bash (structural analysis)
 *   2. Default-deny allowlist for every resolved command
 *   3. PATH-aware trust: the file each allowlisted name resolves to must live
 *      in a trusted bin root (./bin-trust.ts), because an allowlisted *name*
 *      says nothing about which file runs
 *   4. Exec-environment assignments (PATH=, DYLD_*, LD_*, BASH_ENV=, …) → gate,
 *      since they redirect resolution or inject code into a trusted binary
 *   5. Output redirection detection (>, >>)
 *   6. Dynamic/unresolvable construct detection (command substitution,
 *      variable expansion, ANSI-C strings in command position → gate)
 *
 * Failure mode: if any layer can't determine safety, the command is gated.
 * Parse errors, unknown constructs, and dynamic names all trigger gating.
 */

import { dirname, join } from "node:path";
import { BENIGN_WRAPPERS, type CommandRule, SAFE_COMMANDS } from "./allowlist";
import {
  type TrustEnv,
  type TrustEnvOptions,
  checkExecutable,
  isExecInfluencingVar,
  resolveTrustEnv,
} from "./bin-trust";

// ── Types ───────────────────────────────────────────────────────────────

// We use `any` for tree-sitter types to avoid import issues with WASM module.
// The actual runtime objects are fully typed by web-tree-sitter.
type SyntaxNode = any;
type ParserInstance = any;

export interface AnalysisResult {
  /** Whether this command should be gated (require user approval) */
  gated: boolean;
  /** Human-readable reasons why the command is gated */
  reasons: string[];
  /** Non-fatal trust-setup problems (unresolvable mise tools, bad roots) */
  warnings: string[];
}

/**
 * Walker state. `env` is resolved once per analyzeCommand call so the walk
 * itself stays synchronous.
 */
interface WalkContext {
  reasons: string[];
  env: TrustEnv;
}

// ── Parser singleton ────────────────────────────────────────────────────

let parserPromise: Promise<ParserInstance> | null = null;

async function getParser(): Promise<ParserInstance> {
  if (!parserPromise) parserPromise = initParser();
  return parserPromise;
}

async function initParser(): Promise<ParserInstance> {
  const { Parser, Language } = await import("web-tree-sitter");

  // Locate WASM files via package resolution
  const tsPkgDir = dirname(require.resolve("web-tree-sitter"));
  const bashPkgDir = dirname(require.resolve("tree-sitter-bash/package.json"));

  // WASM filename changed in 0.26.x: tree-sitter.wasm → web-tree-sitter.wasm
  const wasmCandidates = ["web-tree-sitter.wasm", "tree-sitter.wasm"];
  const { existsSync } = await import("node:fs");
  const wasmFile = wasmCandidates.find((f) => existsSync(join(tsPkgDir, f))) ?? wasmCandidates[0];

  await Parser.init({
    locateFile: () => join(tsPkgDir, wasmFile),
  });

  const parser = new Parser();
  const Bash = await Language.load(join(bashPkgDir, "tree-sitter-bash.wasm"));
  parser.setLanguage(Bash);
  return parser;
}

// ── Public API ──────────────────────────────────────────────────────────

export async function analyzeCommand(
  command: string,
  options: TrustEnvOptions = {},
): Promise<AnalysisResult> {
  const parser = await getParser();
  const env = await resolveTrustEnv(options);

  const tree = parser.parse(command);
  try {
    const root = tree.rootNode;

    // Parse errors → gate (possible obfuscation or complex construct)
    if (root.hasError) {
      return {
        gated: true,
        reasons: [
          "shell parser reported syntax errors — possible obfuscation or complex construct",
        ],
        warnings: env.warnings,
      };
    }

    const ctx: WalkContext = { reasons: [], env };
    classifyNode(root, ctx);
    return { gated: ctx.reasons.length > 0, reasons: ctx.reasons, warnings: env.warnings };
  } finally {
    // Tree-sitter WASM trees must be explicitly freed to avoid
    // accumulating allocations over long-running sessions.
    tree.delete();
  }
}

// ── AST walker ──────────────────────────────────────────────────────────

/**
 * Node classification strategy:
 *
 * - "command"             → extract name, unwrap wrappers, check allowlist,
 *                           then scan children for nested executable code
 * - "file_redirect"       → check for output operators (>, >>)
 * - "function_definition" → always gate (defines callable code)
 * - Leaf-inert nodes      → skip (only truly non-executable: comments, heredoc text)
 * - Everything else       → recurse into named children
 *
 * Unknown named node types hit the default branch which recurses.
 * This ensures we never silently skip a dangerous construct.
 */

/**
 * Node types that can NEVER contain executable code.
 * Everything else is recursed into — this is critical for catching
 * command substitutions in variable assignments, test expressions, etc.
 * e.g. FOO=$(rm file), [ $(rm file) ], export BAR=$(touch x)
 */
const LEAF_INERT = new Set(["comment", "heredoc_body", "heredoc_start", "heredoc_end"]);

function classifyNode(node: SyntaxNode, ctx: WalkContext): void {
  // ERROR nodes from tree-sitter error recovery
  if (node.type === "ERROR" || node.isError) {
    ctx.reasons.push(
      `AST parse error near \`${node.text.slice(0, 40)}\` — possible obfuscation or unsupported syntax`,
    );
    return;
  }

  switch (node.type) {
    case "command":
      classifyCommand(node, ctx);
      return;

    case "pipeline":
      classifyPipeline(node, ctx);
      return;

    case "file_redirect":
      classifyFileRedirect(node, ctx);
      return;

    case "function_definition":
      ctx.reasons.push(
        "function definition — defines callable code that cannot be statically analyzed",
      );
      return;

    // Standalone `PATH=/tmp/x` and `export PATH=/tmp/x`, whose effect outlives
    // the statement and would redirect every later command in the list.
    case "variable_assignment":
    case "declaration_command":
      classifyExecEnvAssignments(node, ctx);
      recurseNamedChildren(node, ctx); // still catches FOO=$(rm file)
      return;

    default:
      // Leaf-inert nodes: can never contain executable code
      if (LEAF_INERT.has(node.type)) return;

      // Everything else: recurse into named children
      // This covers: program, list, pipeline, redirected_statement,
      // subshell, compound_statement, for_statement, while_statement,
      // if_statement, case_statement, negated_command, do_group,
      // elif_clause, else_clause, case_item, heredoc_redirect, etc.
      recurseNamedChildren(node, ctx);
      return;
  }
}

function recurseNamedChildren(node: SyntaxNode, ctx: WalkContext): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.isNamed) classifyNode(child, ctx);
  }
}

/**
 * Gate assignments that change how a command resolves or what code it loads —
 * `PATH=/tmp/x ls`, `DYLD_INSERT_LIBRARIES=x.dylib ls`, `BASH_ENV=x.sh …`.
 * Resolving the command name would prove nothing under these: the binary we
 * would vouch for is no longer the only thing that executes.
 *
 * Scans the direct `variable_assignment` children of a command, a bare
 * assignment statement, or a `declaration_command` (`export`/`declare`).
 * Returns whether anything was gated.
 */
function classifyExecEnvAssignments(node: SyntaxNode, ctx: WalkContext): boolean {
  // A bare `PATH=/tmp/x` statement is itself the assignment; a command prefix
  // and an `export`/`declare` carry assignments as children.
  const assignments: SyntaxNode[] = node.type === "variable_assignment" ? [node] : [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === "variable_assignment") assignments.push(child);
  }

  let gated = false;
  for (const assignment of assignments) {
    const name = assignment.childForFieldName("name")?.text ?? "";
    if (!isExecInfluencingVar(name)) continue;
    ctx.reasons.push(
      `assigns \`${name}\` — redirects command resolution or injects code into an ` +
        "otherwise-trusted binary, so an allowlisted command name proves nothing",
    );
    gated = true;
  }
  return gated;
}

// ── Pipeline classification ──────────────────────────────────────────────

/** Shell commands that execute their stdin as code */
const SHELL_EXECUTORS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);

/**
 * Detect encoded payload pipelines like `echo <base64> | base64 -d | sh`.
 * When found, decode the payload and report what actually executes.
 */
function classifyPipeline(node: SyntaxNode, ctx: WalkContext): void {
  const reasons = ctx.reasons;
  // Collect pipeline stages
  const stages: SyntaxNode[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.isNamed) stages.push(child);
  }

  // Look for pattern: ... | base64 -d | <shell>
  const decoded = tryDecodePipelinePayload(stages);
  if (decoded) {
    const trimmed = decoded.payload.trim();
    const payloadDisplay = trimmed.length > 120 ? trimmed.slice(0, 120) + "…" : trimmed;
    reasons.push(
      `encoded pipeline \`${node.text.slice(0, 80)}\` \u2014 ` +
        `base64 payload decodes to: \`${payloadDisplay}\` \u2192 piped to \`${decoded.shell}\` for execution`,
    );
    return;
  }

  // No special pattern detected \u2014 classify each stage individually
  for (const stage of stages) {
    classifyNode(stage, ctx);
  }
}

interface DecodedPipeline {
  payload: string;
  shell: string;
}

/** Try to extract and decode a base64 payload from a pipeline */
function tryDecodePipelinePayload(stages: SyntaxNode[]): DecodedPipeline | null {
  if (stages.length < 2) return null;

  // Check if the last stage is a shell executor
  const lastStage = stages[stages.length - 1];
  const lastCmd = getCommandName(lastStage);
  if (!lastCmd || !SHELL_EXECUTORS.has(lastCmd)) return null;

  // Look for a base64 decode stage before it
  let base64Idx = -1;
  for (let i = stages.length - 2; i >= 0; i--) {
    const cmd = getCommandName(stages[i]);
    if (cmd === "base64" && hasFlag(stages[i], "-d", "--decode", "-D")) {
      base64Idx = i;
      break;
    }
  }
  if (base64Idx < 0) return null;

  // Try to extract the literal payload from stages before base64
  const payload = extractLiteralPayload(stages, base64Idx);
  if (!payload) return null;

  // Decode
  try {
    const decoded = Buffer.from(payload, "base64").toString("utf-8");
    // Sanity check: must produce printable text (tab/LF/CR + printable ASCII)
    // oxlint-disable-next-line no-control-regex -- matching control chars is the point
    if (!/^[\u0009\u000a\u000d\u0020-\u007e]+$/.test(decoded)) return null;
    return { payload: decoded, shell: lastCmd };
  } catch {
    return null;
  }
}

/**
 * Get the command name from a command node, as a bare basename.
 *
 * Only the base64-payload *diagnostic* below uses this — it wants to recognize
 * `/usr/bin/base64` as base64 when describing what a pipeline decodes to.
 * Security decisions never go through here; they use resolveCommandName, which
 * preserves the directory part.
 */
function getCommandName(node: SyntaxNode): string | null {
  if (node.type !== "command") return null;
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return null;
  const resolved = resolveCommandName(nameNode);
  if (!resolved) return null;
  const slash = resolved.lastIndexOf("/");
  return slash === -1 ? resolved : resolved.slice(slash + 1) || null;
}

/** Check if a command node has a specific flag (supports combined short flags like -di) */
function hasFlag(node: SyntaxNode, ...flags: string[]): boolean {
  const args = getCommandArgs(node);
  return args.some((a) => {
    if (flags.includes(a)) return true;
    // Check combined short flags: -di contains -d
    if (a.startsWith("-") && !a.startsWith("--") && a.length > 2) {
      for (const flag of flags) {
        if (flag.startsWith("-") && !flag.startsWith("--") && flag.length === 2) {
          if (a.includes(flag[1])) return true;
        }
      }
    }
    return false;
  });
}

/** Extract the literal string payload fed into a base64 -d stage */
function extractLiteralPayload(stages: SyntaxNode[], base64Idx: number): string | null {
  if (base64Idx === 0) return null;
  const feedStage = stages[base64Idx - 1];
  if (feedStage.type !== "command") return null;
  const cmd = getCommandName(feedStage);
  if (cmd !== "echo" && cmd !== "printf") return null;
  const args = getCommandArgs(feedStage);
  if (args.length === 0) return null;
  // Return the last argument (the payload), stripping quotes
  let payload = args[args.length - 1];
  if (
    (payload.startsWith("'") && payload.endsWith("'")) ||
    (payload.startsWith('"') && payload.endsWith('"'))
  ) {
    payload = payload.slice(1, -1);
  }
  return payload;
}

// ── Command classification ──────────────────────────────────────────────

function classifyCommand(node: SyntaxNode, ctx: WalkContext): void {
  const reasons = ctx.reasons;
  const nameNode = node.childForFieldName("name");
  if (!nameNode) {
    reasons.push("command node has no name field — cannot determine what will execute");
    return;
  }

  // `PATH=/tmp/x ls` and friends: the prefix decides what `ls` even means, so
  // no amount of name resolution below could vouch for it.
  if (classifyExecEnvAssignments(node, ctx)) return;

  // Resolve the static command name, directory part included — `./ls` is not
  // `ls`, and conflating them is how an agent-planted file used to inherit an
  // allowlisted name's trust.
  const resolved = resolveCommandName(nameNode);
  if (!resolved) {
    reasons.push(describeDynamicName(nameNode));
    return;
  }

  const args = getCommandArgs(node);

  // Special case: `command -v/-V` is a type-check, always safe
  if (resolved === "command" && args.length > 0 && (args[0] === "-v" || args[0] === "-V")) {
    scanCommandChildren(node, ctx);
    return;
  }

  // Unwrap benign wrappers (nice, nohup, timeout, …), recording each wrapper
  // so the trust check below covers the whole chain: `./timeout 5 ls` executes
  // ./timeout, whatever the inner command turns out to be.
  const wrappers: string[] = [];
  const unwrapped = unwrapCommand(resolved, args, wrappers);

  // Check the unwrapped command against the allowlist, by name. A directory
  // part never changes which rule applies: `/bin/ls` is still the `ls` rule.
  // allowlist.ts is the only authority on which names are unprompted — bin trust
  // decides *where* a name may live, never *whether* it is free to run, so the
  // tools PATH can carry `gh` and `node` without making them free actions.
  const commandName = basename(unwrapped.command);
  const rule: CommandRule | undefined = SAFE_COMMANDS[commandName];
  if (rule === undefined) {
    const detail =
      unwrapped.command !== resolved ? ` (resolved from \`${resolved} ${args.join(" ")}\`)` : "";
    reasons.push(
      `\`${unwrapped.command}\` is not in the safe command allowlist${detail} — default-deny policy gates unknown commands`,
    );
    return; // Already gated — no need to scan further
  }
  if (rule !== true && !rule(unwrapped.commandArgs)) {
    const argStr =
      unwrapped.commandArgs.length > 0 ? ` with args [${unwrapped.commandArgs.join(", ")}]` : "";
    reasons.push(
      `\`${unwrapped.command}\`${argStr} — allowlisted command but arguments indicate file mutation`,
    );
    return; // Already gated
  }

  // The name is allowlisted; now prove the file behind it is trustworthy.
  for (const name of [...wrappers, unwrapped.command]) {
    const trust = checkExecutable(name, ctx.env);
    if (!trust.trusted) {
      reasons.push(trust.reason);
      return; // Already gated
    }
  }

  // Command itself passes the allowlist, but children may still contain
  // dangerous nested code: output redirects (>, >>), command substitutions
  // in arguments — echo $(rm file), or env-var assignments with embedded
  // commands — FOO=$(rm file) echo hi.
  scanCommandChildren(node, ctx);
}

/** Trailing path component of a command word: `/bin/ls` → `ls`, `ls` → `ls`. */
function basename(name: string): string {
  const slash = name.lastIndexOf("/");
  return slash === -1 ? name : name.slice(slash + 1);
}

/**
 * Scan all non-name children of a command node for nested executable code.
 * Handles: output redirects, command substitutions in arguments/strings,
 * variable assignments with embedded commands, etc.
 */
function scanCommandChildren(node: SyntaxNode, ctx: WalkContext): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child || !child.isNamed) continue;
    if (child.type === "command_name") continue; // already resolved above
    classifyNode(child, ctx);
  }
}

// ── Dynamic name diagnostics ────────────────────────────────────────────

const DYNAMIC_NAME_DESCRIPTIONS: Record<string, string> = {
  command_substitution:
    "command substitution `$(...)` in command position — executed command is determined at runtime",
  simple_expansion:
    "variable expansion `$var` in command position — command name resolved at runtime from variable",
  expansion: "parameter expansion `${...}` in command position — command name resolved at runtime",
  process_substitution:
    "process substitution `<(...)` in command position — cannot statically determine command",
  concatenation:
    "string concatenation in command position — fragments may assemble an arbitrary command name",
};

function describeDynamicName(nameNode: SyntaxNode): string {
  const child = nameNode.childCount > 0 ? nameNode.child(0) : null;
  const nodeType = child?.type ?? "unknown";
  const snippet = nameNode.text.slice(0, 60);

  // ANSI-C strings: decode and show the actual command
  if (nodeType === "ansi_c_string" && child) {
    const decoded = decodeAnsiCString(child.text);
    return `\`${snippet}\` decodes to \`${decoded}\` — ANSI-C quoting \`$'...'\` in command position encodes command name via escape sequences`;
  }

  const description =
    DYNAMIC_NAME_DESCRIPTIONS[nodeType] ??
    `dynamic construct (AST node: ${nodeType}) — cannot statically resolve command name`;
  return `\`${snippet}\` — ${description}`;
}

/** Decode a bash ANSI-C quoted string: $'\x72\x6d' → rm */
function decodeAnsiCString(raw: string): string {
  // Strip the $' prefix and ' suffix
  let s = raw;
  if (s.startsWith("$'") && s.endsWith("'")) {
    s = s.slice(2, -1);
  }

  let result = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "\\" || i + 1 >= s.length) {
      result += s[i];
      continue;
    }
    const next = s[i + 1];
    switch (next) {
      case "x":
      case "X": {
        // \xHH
        const hex = s.slice(i + 2, i + 4);
        const code = parseInt(hex, 16);
        result += isNaN(code) ? s.slice(i, i + 4) : String.fromCharCode(code);
        i += 3;
        break;
      }
      case "u": {
        // \uHHHH
        const hex = s.slice(i + 2, i + 6);
        const code = parseInt(hex, 16);
        result += isNaN(code) ? s.slice(i, i + 6) : String.fromCodePoint(code);
        i += 5;
        break;
      }
      case "U": {
        // \UHHHHHHHH
        const hex = s.slice(i + 2, i + 10);
        const code = parseInt(hex, 16);
        result += isNaN(code) ? s.slice(i, i + 10) : String.fromCodePoint(code);
        i += 9;
        break;
      }
      case "0":
      case "1":
      case "2":
      case "3":
      case "4":
      case "5":
      case "6":
      case "7": {
        // \NNN octal
        let oct = next;
        if (i + 2 < s.length && s[i + 2] >= "0" && s[i + 2] <= "7") {
          oct += s[i + 2];
          i++;
        }
        if (i + 2 < s.length && s[i + 2] >= "0" && s[i + 2] <= "7") {
          oct += s[i + 2];
          i++;
        }
        result += String.fromCharCode(parseInt(oct, 8));
        i++;
        break;
      }
      case "n":
        result += "\n";
        i++;
        break;
      case "t":
        result += "\t";
        i++;
        break;
      case "r":
        result += "\r";
        i++;
        break;
      case "a":
        result += "\x07";
        i++;
        break;
      case "b":
        result += "\b";
        i++;
        break;
      case "f":
        result += "\f";
        i++;
        break;
      case "v":
        result += "\v";
        i++;
        break;
      case "e":
      case "E":
        result += "\x1b";
        i++;
        break;
      case "\\":
        result += "\\";
        i++;
        break;
      case "'":
        result += "'";
        i++;
        break;
      case '"':
        result += '"';
        i++;
        break;
      default:
        result += "\\" + next;
        i++;
        break;
    }
  }
  return result;
}

// ── Command name resolution ─────────────────────────────────────────────

/**
 * Resolve a command_name AST node to a plain string, *including* any directory
 * part — `./ls` resolves to `./ls`, not `ls`. Callers pair the basename (which
 * allowlist rule applies) with the full word (which file actually runs); see
 * checkExecutable in ./bin-trust.ts.
 *
 * Returns null if the name is dynamic (variable expansion, command
 * substitution, ANSI-C string, concatenation, etc.).
 */
function resolveCommandName(nameNode: SyntaxNode): string | null {
  if (nameNode.childCount === 0) return null;
  const child = nameNode.child(0);
  if (!child) return null;

  switch (child.type) {
    case "word": {
      // Strip backslash escapes: \rm → rm
      const name = child.text.replace(/\\/g, "");
      return name || null;
    }

    case "string": {
      // Double-quoted command name: "rm"
      // Only safe if it's pure static content (no interpolation)
      let content = "";
      let dynamic = false;
      for (let i = 0; i < child.childCount; i++) {
        const sc = child.child(i);
        if (!sc) continue;
        if (sc.type === "string_content") {
          content += sc.text;
        } else if (sc.isNamed) {
          dynamic = true;
          break;
        }
      }
      return dynamic ? null : content || null;
    }

    case "raw_string": {
      // Single-quoted: 'rm'
      const text = child.text;
      if (text.startsWith("'") && text.endsWith("'")) {
        return text.slice(1, -1) || null;
      }
      return null;
    }

    // Dynamic constructs — cannot resolve statically
    case "command_substitution": // $(echo rm)
    case "simple_expansion": // $cmd
    case "expansion": // ${cmd}
    case "process_substitution": // <(cmd)
    case "ansi_c_string": // $'\x72\x6d'
    case "concatenation": // r""m, "$a"b, etc.
      return null;

    default:
      return null;
  }
}

// ── Argument extraction ─────────────────────────────────────────────────

/** Extract argument text values from a command node */
function getCommandArgs(node: SyntaxNode): string[] {
  const args: string[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child || !child.isNamed) continue;
    if (child.type === "command_name") continue;
    if (child.type === "variable_assignment") continue;
    if (child.type === "file_redirect") continue;
    if (child.type === "herestring_redirect") continue;
    if (child.type === "subshell") continue;
    args.push(child.text);
  }
  return args;
}

// ── Command wrapper unwrapping ──────────────────────────────────────────

/**
 * Unwrap benign command wrappers to find the real command.
 * e.g. `nice -n5 timeout 5 rm file` → command: "rm", args: ["file"]
 *
 * Every wrapper name traversed is appended to `wrappers`, because each one is
 * itself an executable that runs: `./timeout 5 ls` must be judged on ./timeout
 * as well as on ls. Wrapper recognition uses the basename, so `/usr/bin/nice`
 * unwraps like `nice` while keeping its path for the trust check.
 */
function unwrapCommand(
  command: string,
  args: string[],
  wrappers: string[] = [],
): { command: string; commandArgs: string[] } {
  const slash = command.lastIndexOf("/");
  const wrapperName = slash === -1 ? command : command.slice(slash + 1);
  if (!BENIGN_WRAPPERS.has(wrapperName)) {
    return { command, commandArgs: args };
  }
  wrappers.push(command);
  // Wrapper-specific arg skipping keys off the bare name.
  command = wrapperName;

  let i = 0;

  if (command === "env") {
    // env -S/--split-string splits a string into its own command + args at
    // runtime (`env -S'rm file'`), so the real command hides inside the flag
    // and never appears as a positional arg. We can't resolve it statically →
    // return a non-allowlisted sentinel so the call is gated.
    for (const a of args) {
      if (
        a === "-S" ||
        a.startsWith("--split-string") ||
        (a.startsWith("-S") && !a.startsWith("--"))
      ) {
        return { command: "env -S", commandArgs: [] };
      }
    }
    // env: skip variable assignments (FOO=bar) and flags
    while (i < args.length) {
      const a = args[i];
      if (a.includes("=") && !a.startsWith("-")) {
        i++; // VAR=value
      } else if (a.startsWith("-")) {
        if ((a === "-u" || a === "--unset") && i + 1 < args.length) i++; // -u takes a value
        i++;
      } else {
        break;
      }
    }
  } else if (command === "timeout") {
    // timeout [FLAGS] DURATION COMMAND [ARGS]
    while (i < args.length && args[i].startsWith("-")) {
      if (
        (args[i] === "-k" ||
          args[i] === "--kill-after" ||
          args[i] === "-s" ||
          args[i] === "--signal") &&
        i + 1 < args.length
      )
        i++;
      i++;
    }
    if (i < args.length) i++; // skip DURATION
  } else {
    // Generic wrapper: skip flags, first non-flag arg is the real command
    while (i < args.length && args[i].startsWith("-")) i++;
  }

  if (i < args.length) {
    // The inner command keeps its path prefix — it is the thing that executes,
    // so the trust check needs to know where it lives.
    // Recurse in case of stacked wrappers: nice timeout 5 rm
    return unwrapCommand(args[i], args.slice(i + 1), wrappers);
  }

  // No inner command found (e.g., bare `env` prints environment)
  return { command, commandArgs: [] };
}

// ── Redirect classification ─────────────────────────────────────────────

/** Destinations that are safe for output redirects */
const SAFE_REDIRECT_DESTINATIONS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);

function classifyFileRedirect(node: SyntaxNode, ctx: WalkContext): void {
  const reasons = ctx.reasons;
  let operator = "";
  let destination = "";

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;

    if (!child.isNamed) {
      const t = child.type;
      // All redirect operators emitted by tree-sitter-bash
      if (
        t === ">" ||
        t === ">>" ||
        t === ">&" ||
        t === ">|" ||
        t === "&>" ||
        t === "&>>" ||
        t === "<" ||
        t === "<<" ||
        t === "<<<" ||
        t === "<&"
      ) {
        operator = t;
      }
    } else if (child.type !== "file_descriptor") {
      destination = child.text;
    }
  }

  // Input redirects are always safe
  if (operator === "<" || operator === "<<" || operator === "<<<" || operator === "<&") return;

  // fd-to-fd redirect like 2>&1 is safe
  if (operator === ">&" && /^\d+$/.test(destination)) return;

  // Output to /dev/null etc. is safe
  if (SAFE_REDIRECT_DESTINATIONS.has(destination) || destination.startsWith("/dev/fd/")) return;

  // Any output redirect → gate
  // >  >>  >&  >|  (clobber) &> (stdout+stderr) &>> (append stdout+stderr)
  const WRITE_OPERATORS = new Set([">", ">>", ">&", ">|", "&>", "&>>"]);
  if (WRITE_OPERATORS.has(operator)) {
    reasons.push(`output redirect \`${operator} ${destination}\` — writes to filesystem`);
  }
}
