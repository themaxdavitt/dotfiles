/**
 * The escape hatch out of the per-call sandbox.
 *
 * Kept free of Pi imports so it stays testable outside Pi; the tool definition
 * that exposes it to the model lives in ../tools/elevated.ts.
 */

import { spawn } from "node:child_process";

/** Cap model-visible output like Pi's bash tool does. */
const MAX_OUTPUT_BYTES = 50 * 1024;

function tail(text: string): string {
  if (Buffer.byteLength(text) <= MAX_OUTPUT_BYTES) return text;
  const buf = Buffer.from(text);
  return `…[output truncated to last ${MAX_OUTPUT_BYTES} bytes]\n${buf.subarray(buf.length - MAX_OUTPUT_BYTES).toString()}`;
}

export interface ElevatedRunResult {
  output: string;
  exitCode: number;
}

/**
 * Run `command` directly from the Pi process. Pi itself is unsandboxed (only
 * its tool calls are confined), so no escape channel is needed — the entire
 * privilege boundary here is the per-command approval dialog the gate demands
 * before this ever executes (see `src/gate.ts`).
 */
export async function runElevated(
  command: string,
  cwd: string,
  signal: AbortSignal | undefined,
  timeoutMs?: number,
): Promise<ElevatedRunResult> {
  // Pure bash: the user approved exactly `command`, so nothing else may run
  // first — BASH_ENV would make unconfined bash source an unreviewed file at
  // startup (--noprofile --norc alone does not disable it).
  const env = { ...process.env };
  delete env.BASH_ENV;
  delete env.ENV;
  const child = spawn("bash", ["--noprofile", "--norc", "-c", command], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const chunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));

  let timedOut = false;
  const killChild = () => child.kill("SIGKILL");
  signal?.addEventListener("abort", killChild, { once: true });
  const timer = timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        killChild();
      }, timeoutMs)
    : undefined;

  try {
    const exitCode: number = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 1));
    });

    const output = tail(Buffer.concat(chunks).toString("utf-8"));
    if (signal?.aborted) {
      throw new Error(
        `elevated_bash aborted (grandchild processes may still be running)\n${output}`,
      );
    }
    if (timedOut) {
      throw new Error(
        `elevated_bash timed out after ${timeoutMs}ms (grandchild processes may still be running)\n${output}`,
      );
    }
    return { output, exitCode };
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", killChild);
  }
}
