/**
 * Proxy-CA warm-up.
 *
 * The nono proxy CA is self-signed and regenerated every few days, and the
 * first `--trust-proxy-ca` run afterwards pops a macOS keychain prompt. Left alone,
 * whichever bash call happens to come first wears that prompt — which can be a
 * long way into a session, after the user has stopped watching. Warming the CA
 * once at session start puts it where someone is still there to answer it.
 *
 * `~/bin/pi` runs the same warm-up before Pi starts, and that remains the
 * better place: it happens before the TUI owns the terminal. This is the net
 * for every other launcher (`mise which pi`, the raw binary, an IDE), so it
 * stays quiet on success and reports failure rather than acting on it.
 */

import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { toolsProfile } from "./wrap";

const execFileAsync = promisify(execFile);

/**
 * A no-op payload: `nono run` checks and trusts the proxy CA on the way in, so
 * whatever it ends up running is irrelevant. Absolute, because PATH inside the
 * sandbox is not this module's business.
 */
export const WARMUP_PAYLOAD = "/usr/bin/true";

/** Long enough for a human to answer a keychain dialog, short enough that a
 * wedged nono cannot hang session start indefinitely. */
export const WARMUP_TIMEOUT_MS = 120_000;

/**
 * These flags must stay identical to the ones `wrapBashCommand` passes, or the
 * warm-up trusts a CA the real calls will not use and the prompt comes back
 * mid-session anyway. `test/warmup.test.ts` pins them against wrap.ts rather
 * than against a copy of the literal.
 */
export function proxyCaWarmupArgs(profile: string = toolsProfile()): string[] {
  return [
    "run",
    "--profile",
    profile,
    "--allow-cwd",
    "--trust-proxy-ca",
    "--silent",
    "--",
    WARMUP_PAYLOAD,
  ];
}

export interface WarmupOutcome {
  ok: boolean;
  /** Present only when `ok` is false: what to tell the user. */
  detail?: string;
}

export type WarmupRunner = (args: string[], cwd: string) => Promise<void>;

const spawnNono: WarmupRunner = async (args, cwd) => {
  await execFileAsync("nono", args, { cwd, timeout: WARMUP_TIMEOUT_MS });
};

/**
 * Runs from the temp dir rather than the session cwd: `--allow-cwd` is refused
 * for $HOME, which overlaps nono's own state root, and Pi is often launched
 * there.
 */
export async function warmProxyCa(
  options: { profile?: string; run?: WarmupRunner } = {},
): Promise<WarmupOutcome> {
  const run = options.run ?? spawnNono;
  try {
    await run(proxyCaWarmupArgs(options.profile), tmpdir());
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      detail:
        "nono proxy-CA warm-up failed; a keychain prompt may appear mid-session instead. " +
        (error instanceof Error ? error.message : String(error)),
    };
  }
}
