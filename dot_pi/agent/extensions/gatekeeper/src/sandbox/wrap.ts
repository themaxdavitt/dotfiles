import type { BashOperations, BashSpawnContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_BIN_TRUST, staticSearchDirs } from "../hazmat/bin-trust";
import { delimiter } from "node:path";

/**
 * Per-call OS sandboxing for the bash tool.
 *
 * Pi itself runs unsandboxed; every unprivileged bash command is wrapped in
 * `nono run` against the tools profile instead. This is deliberately
 * fail-closed: if `nono` is missing from the tools PATH the wrapped command
 * errors loudly rather than silently running unconfined.
 *
 * Env hygiene is nono's job (verified against v0.65.1 on 2026-07-18): the
 * child sees a proxy placeholder for GH_TOKEN (the profile's credential
 * route) and other secret-shaped vars like DATALAB_API_KEY scrubbed.
 *
 * The PATH handed to bash is constructed from `binTrust` (hazmat/bin-trust.ts),
 * never inherited: a login PATH is not something to be groomed for an agent's
 * benefit, and pi's own can carry entries bash resolves against the agent's cwd.
 * This pins only the *default* lookup — a command that sets its own PATH still
 * wins for that command, which is legitimate (`PATH=./node_modules/.bin npm t`)
 * and is why the analyzer gates such statements rather than rewriting them.
 * nono prepends its per-call shim dir to whatever we pass, so the effective
 * search path is `<nono shim>:<ours>`.
 */

/** Overridable so tests can point at the chezmoi-source profile file. */
export function toolsProfile(): string {
  return process.env.GATEKEEPER_NONO_PROFILE || "pi-tools";
}

// Config-derived dirs need `mise which`, so the real value arrives once the
// session config resolves. Until then this is the config's static dirs only:
// narrower than intended, never the ambient PATH — a missing tool fails loudly
// with command-not-found instead of silently resolving somewhere unvouched.
let toolsPathValue = staticSearchDirs(DEFAULT_BIN_TRUST).join(delimiter);

export function configureToolsPath(dirs: string[]): void {
  toolsPathValue = dirs.join(delimiter);
}

export function toolsPath(): string {
  return toolsPathValue;
}

export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

export function wrapBashCommand(command: string): string {
  // --trust-proxy-ca lets HTTPS through nono's credential-injecting proxy;
  // --allow-cwd is required because non-interactive `nono run` does not apply
  // the profile's workdir grant on its own (nono.ts queries mirror it with
  // --allow <cwd>). The inner bash is kept pure: `env -u BASH_ENV -u ENV`
  // stops bash from sourcing an arbitrary startup file (non-interactive bash
  // honors $BASH_ENV even with the belt-and-suspenders --noprofile --norc),
  // and PATH is set here rather than only in the spawn env because this string
  // is the part we provably control.
  return (
    `nono run --profile ${shellQuote(toolsProfile())} --allow-cwd --trust-proxy-ca --silent -- ` +
    `env -u BASH_ENV -u ENV PATH=${shellQuote(toolsPath())} bash --noprofile --norc -c ${shellQuote(command)}`
  );
}

/** BashSpawnHook: rewrites the spawned command and pins PATH — the transcript,
 * the model, and the renderers all keep seeing the original input. The env is
 * pinned too so the outer lookup of `nono` itself uses the tools PATH instead of
 * whatever pi inherited. */
export function sandboxSpawnHook(context: BashSpawnContext): BashSpawnContext {
  return {
    ...context,
    command: wrapBashCommand(context.command),
    env: { ...context.env, PATH: toolsPath() },
  };
}

/**
 * The same confinement for a path that has no `spawnHook` to hang it on.
 *
 * `spawnHook` is an option on the *tool* definition, so it only ever sees calls
 * the model made. A `!` command the user types goes to `AgentSession.executeBash`
 * instead, which reaches the shell through a `BashOperations` and never touches
 * the tool — that is how `!` ran unconfined until 2026-07-30. Wrapping the
 * operations puts the two paths back on one implementation.
 *
 * Passing `env` explicitly matters as much as rewriting the command: pi's own
 * operations default to `getShellEnv()` (`{...process.env}`), which is the
 * ambient login PATH plus whatever `~/bin/pi` injected — a real `GH_TOKEN` and
 * `fnox`'s `DATALAB_API_KEY`. Handing the child our list instead means the outer
 * `nono` resolves off the trusted PATH, and nono scrubs the secrets from there.
 */
export function sandboxBashOperations(operations: BashOperations): BashOperations {
  return {
    exec: (command, cwd, options) => {
      const spawned = sandboxSpawnHook({ command, cwd, env: options.env ?? process.env });
      return operations.exec(spawned.command, spawned.cwd, { ...options, env: spawned.env });
    },
  };
}
