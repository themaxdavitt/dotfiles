/**
 * PATH-aware executable trust for the Bash allowlist.
 *
 * The allowlist in ./allowlist.ts keys off a command *name*, but a name is not
 * an identity: `./ls`, `/tmp/x/ls`, and `PATH=/tmp/x ls` all put an
 * agent-controlled file where the analyzer would otherwise see a trusted system
 * tool. This module answers the question the allowlist cannot — *which file
 * will actually run?* — and refuses to vouch for anything the agent could have
 * planted.
 *
 * Trust is by location, decided in this order:
 *   1. anything under an agent-writable root (session cwd, TMPDIR) is
 *      untrusted no matter what else grants it — the sandbox profile hands the
 *      agent write access there, so it could have authored the file. This rule
 *      wins last-minute grants too, e.g. a hostile repo-local `mise.toml` that
 *      points `mise which rg` at a binary inside the workdir.
 *   2. anything under a configured trusted root is trusted
 *   3. everything else is untrusted — default-deny, like the allowlist itself
 *
 * Trusted roots are configured in ~/.pi/agent/extensions/gatekeeper.json only.
 * A project-level file cannot widen them: it lives in the workdir the agent can
 * write, so honoring it would let the agent grant itself the very trust this
 * module exists to withhold.
 *
 * TOCTOU: resolution happens when the call is gated, execution a few
 * milliseconds later. Nothing can change in between without already-running
 * code inside this sandbox — and planting a file takes a gated command first.
 *
 * One known blind spot: `nono run` prepends its own per-call shim dir (under
 * TMPDIR, sandbox-writable) to PATH, and that dir does not exist yet at gate
 * time. It ships only `open` and `nono-open-url-helper`, neither allowlisted,
 * and it is recreated per call — so it cannot carry a plant between calls.
 */

import { execFile } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ── Configuration ───────────────────────────────────────────────────────

/**
 * One list, two jobs: these directories are both the PATH handed to the
 * sandboxed bash and the set of locations whose executables are trusted. Search
 * order is `miseTools` (in listed order) then `roots` (in listed order), so a
 * mise-pinned tool wins over a system copy of the same name and the system dirs
 * come last — the ordering `,sb` uses.
 *
 * Keeping them one list means bash's default lookup can only reach somewhere we
 * vouch for, with no second list to drift. It also means the PATH is *ours*: the
 * ambient PATH pi inherited is never read for resolution and never validated
 * against this, because a login PATH is not something to be groomed for an
 * agent's benefit.
 */
export interface BinTrustConfig {
  /**
   * mise-managed tools, by the name you would type. Each is resolved with
   * `mise which <tool>`, and its containing directory joins the search path and
   * the trust set — the shape `,sb` builds its PATH from.
   *
   * Listing a tool here does NOT make it run unprompted. Which *names* skip the
   * prompt is `hazmat/allowlist.ts`'s call alone, and deliberately so: this list
   * has to carry `gh`, `node`, `python`, and `uv` for approved commands to run
   * at all, and `gh pr create` or `node -e '…'` must never be a free action.
   */
  miseTools: string[];
  /**
   * Plain directories. `~` is expanded; relative entries are rejected, since
   * bash would resolve them against the agent's own working directory.
   */
  roots: string[];
}

/**
 * Ported from `,sb.sh`'s NEW_PATHS — a working set for sandboxed agent work,
 * minus its first entry (the dir of the tool being launched, i.e. pi itself,
 * which the agent's bash has no reason to reach).
 *
 * A pinned PATH constrains *approved* commands too: anything whose directory is
 * missing here fails with command-not-found even after the user allows it. That
 * friction is deliberate — add the tool to `miseTools` rather than widening a
 * root to a directory the agent can influence.
 */
export const DEFAULT_BIN_TRUST: BinTrustConfig = {
  miseTools: ["gh", "aube", "uv", "nono", "node", "python", "rg", "fd", "agent-browser"],
  roots: ["~/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"],
};

export function isBinTrustConfig(value: unknown): value is Partial<BinTrustConfig> {
  if (typeof value !== "object" || value === null) return false;
  const data = value as Record<string, unknown>;
  for (const key of ["roots", "miseTools"] as const) {
    const list = data[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.some((item) => typeof item !== "string")) return false;
  }
  return true;
}

/**
 * Environment variables that change what code an otherwise-trusted binary
 * runs or let a read-only command write elsewhere. Assigning any of them gates
 * the command: resolution would no longer prove what executes, and a logging
 * destination would let an otherwise-safe command mutate the filesystem.
 */
const EXEC_ENV_VARS = new Set([
  "PATH",
  "BASH_ENV",
  "ENV",
  "IFS",
  "SHELLOPTS",
  "BASHOPTS",
  "CDPATH",
  "GLOBIGNORE",
  "PROMPT_COMMAND",
  "NONO_LOG_FILE",
]);

/** Prefixes covering every dynamic-loader injection knob (macOS DYLD_*, ELF LD_*). */
const EXEC_ENV_PREFIXES = ["DYLD_", "LD_"];

export function isExecInfluencingVar(name: string): boolean {
  return EXEC_ENV_VARS.has(name) || EXEC_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Bash resolves these without consulting PATH, so no file can shadow them and
 * there is nothing to trust-check. Only reachable for a bare name: `./test` is
 * a file, not the builtin. Shell *functions* could shadow them, but the
 * analyzer already gates every function definition.
 */
const SHELL_BUILTINS = new Set([
  ":",
  "true",
  "false",
  "test",
  "[",
  "pwd",
  "echo",
  "printf",
  "cd",
  "command",
  "builtin",
  "type",
  "times",
  "umask",
  "wait",
]);

export function isShellBuiltin(name: string): boolean {
  return SHELL_BUILTINS.has(name);
}

// ── Resolved trust environment ──────────────────────────────────────────

/**
 * Everything the (synchronous) AST walker needs to decide trust: roots already
 * expanded and realpath'd, mise tools already resolved. Built once per
 * analyzeCommand call by resolveTrustEnv.
 */
export interface TrustEnv {
  cwd: string;
  /**
   * The PATH we construct from the config and hand to bash — not read from the
   * ambient environment. sandbox.ts pins the same value on the wrapped command,
   * so gate-time resolution and exec-time resolution walk one list.
   *
   * This is only the *default* PATH for the command. A command may set its own
   * (`PATH=./node_modules/.bin npm test` is legitimate work), which is why the
   * analyzer gates statements that assign PATH instead of trying to prevent
   * them — bash's resolution is never overridden, only judged.
   */
  path: string;
  /** Search-path directories, in order — same set as the trust roots. */
  searchDirs: string[];
  /** Realpath'd directories whose executables are trusted. */
  trustedRoots: string[];
  /** Realpath'd directories the agent can write, which beat any trusted root. */
  writableRoots: string[];
  /** Non-fatal setup problems (unresolvable mise tools, bad roots). */
  warnings: string[];
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** True when `path` is `parent` or sits underneath it. */
export function isWithin(path: string, parent: string): boolean {
  if (path === parent) return true;
  const rel = relative(parent, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

// `mise which` is stable for the life of a session (a version change means a
// new pi launch), so resolve each (cwd, tool) once. Keyed by cwd because a
// project mise.toml can pin different versions per directory — rule 1 above
// still rejects anything that resolves into the workdir.
const miseCache = new Map<string, Promise<string | undefined>>();

async function miseWhich(tool: string, cwd: string): Promise<string | undefined> {
  const key = `${cwd}\0${tool}`;
  const cached = miseCache.get(key);
  if (cached) return cached;
  const pending = (async () => {
    try {
      const { stdout } = await execFileAsync("mise", ["which", tool], { cwd, timeout: 5000 });
      const path = stdout.trim();
      return path ? path : undefined;
    } catch {
      // mise missing, tool not installed, or timeout — fail closed by leaving
      // the tool untrusted, which surfaces as a gate rather than a silent pass.
      return undefined;
    }
  })();
  miseCache.set(key, pending);
  return pending;
}

/** Test seam: drops memoized `mise which` results. */
export function clearMiseCache(): void {
  miseCache.clear();
}

export interface TrustEnvOptions {
  cwd?: string;
  config?: BinTrustConfig;
  /**
   * Test-only seam for exercising resolution against a PATH the config could
   * never produce (shadowing by an early agent-writable entry, an empty entry
   * meaning cwd, a relative entry). Production never sets this: the PATH is
   * always the one built from the config.
   */
  path?: string;
}

/**
 * Directories from the config that can be known without running anything, in
 * search order. sandbox.ts uses this as its pre-session PATH so an unconfigured
 * spawn falls back to a narrower list rather than to the ambient PATH.
 */
export function staticSearchDirs(config: BinTrustConfig = DEFAULT_BIN_TRUST): string[] {
  return config.roots.map(expandHome).filter((root) => isAbsolute(root));
}

export async function resolveTrustEnv(options: TrustEnvOptions = {}): Promise<TrustEnv> {
  const cwd = options.cwd ?? process.cwd();
  const config = options.config ?? DEFAULT_BIN_TRUST;
  const warnings: string[] = [];

  // mise dirs first so a pinned tool beats a system copy of the same name.
  const searchDirs: string[] = [];
  const resolved = await Promise.all(
    config.miseTools.map(async (tool) => ({ tool, path: await miseWhich(tool, cwd) })),
  );
  for (const { tool, path: toolPath } of resolved) {
    if (!toolPath) {
      warnings.push(
        `\`mise which ${tool}\` failed — ${tool} is off the tools PATH, so commands using it will fail even once approved`,
      );
      continue;
    }
    // dirname, matching how ,sb builds its PATH from `dirname "$(mise which <tool>)"`.
    searchDirs.push(join(toolPath, ".."));
  }

  for (const root of config.roots) {
    const expanded = expandHome(root);
    if (!isAbsolute(expanded)) {
      warnings.push(
        `ignoring relative bin-trust root \`${root}\` — bash would resolve it against the agent's own cwd`,
      );
      continue;
    }
    searchDirs.push(expanded);
  }

  const uniqueDirs = [...new Set(searchDirs)];

  // The sandbox profile grants the workdir and TMPDIR; nono's own shim dir
  // lives under TMPDIR too. /tmp is included because it is writable by
  // anything on the box, TMPDIR or not.
  const writableRoots = [cwd, tmpdir(), "/tmp"].map(realpathOrSelf);

  return {
    cwd,
    path: options.path ?? uniqueDirs.join(delimiter),
    searchDirs: uniqueDirs,
    trustedRoots: uniqueDirs.map(realpathOrSelf),
    writableRoots,
    warnings,
  };
}

// ── The trust check ─────────────────────────────────────────────────────

export type ExecutableTrust =
  | { trusted: true; kind: "builtin" }
  | { trusted: true; kind: "file"; path: string }
  | { trusted: false; reason: string };

/**
 * Resolve `name` the way bash will, then decide whether the file it lands on
 * can be trusted. `name` is the raw command word: it may contain slashes, in
 * which case PATH is not consulted at all.
 */
export function checkExecutable(name: string, env: TrustEnv): ExecutableTrust {
  const hasSlash = name.includes("/");

  if (!hasSlash && isShellBuiltin(name)) return { trusted: true, kind: "builtin" };

  const candidate = hasSlash ? resolveAgainstCwd(name, env) : lookupOnPath(name, env);
  if (!candidate) {
    return {
      trusted: false,
      reason: hasSlash
        ? `\`${name}\` — no executable file at that path, so what would run cannot be verified`
        : `\`${name}\` — not found in PATH, so what would run cannot be verified`,
    };
  }

  const real = realpathOrSelf(candidate);
  const writable = env.writableRoots.find((root) => isWithin(real, root));
  if (writable) {
    return {
      trusted: false,
      reason:
        `\`${name}\` resolves to ${real}, inside an agent-writable directory (${writable}) — ` +
        "an allowlisted name is no proof of identity when the file itself could have been planted",
    };
  }

  if (!env.trustedRoots.some((root) => isWithin(real, root))) {
    return {
      trusted: false,
      reason:
        `\`${name}\` resolves to ${real}, outside every trusted bin root — ` +
        "add the directory (or its mise tool) to gatekeeper.json binTrust if it should be trusted",
    };
  }

  return { trusted: true, kind: "file", path: real };
}

function resolveAgainstCwd(name: string, env: TrustEnv): string | undefined {
  const path = isAbsolute(name) ? name : resolve(env.cwd, name);
  return isExecutableFile(path) ? path : undefined;
}

/**
 * First executable match wins, exactly as bash's PATH search does — so a plant
 * in an early PATH entry is what we trust-check, never the system binary it
 * shadows further down.
 */
function lookupOnPath(name: string, env: TrustEnv): string | undefined {
  for (const entry of env.path.split(delimiter)) {
    // An empty PATH entry means the current directory (POSIX), and a relative
    // entry is resolved against cwd — both land in agent-writable space, which
    // the caller then rejects. Skipping them would make us vouch for a system
    // binary bash would never reach.
    const dir = entry === "" ? env.cwd : isAbsolute(entry) ? entry : resolve(env.cwd, entry);
    const candidate = join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}
