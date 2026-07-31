/**
 * Bridge to the Plannotator CLI.
 *
 * This does not install or import `@plannotator/pi-extension`; it shells out to
 * the public CLI contract `plannotator annotate <plan.md> --gate --json` and
 * reads the decision off the last JSON line of stdout.
 */

import { spawn } from "node:child_process";

export type PlannotatorDecision =
  | { decision: "approved" }
  | { decision: "annotated"; feedback: string }
  | { decision: "dismissed" };

export type PlanReviewResult =
  | { status: "approved" }
  | { status: "annotated"; feedback: string }
  | { status: "dismissed"; feedback: string }
  | { status: "unavailable"; feedback: string }
  | { status: "error"; feedback: string };

export function parsePlannotatorDecision(stdout: string): PlannotatorDecision {
  const trimmed = stdout.trim();
  if (!trimmed) return { decision: "dismissed" };
  const candidates = [
    ...trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("{") && line.endsWith("}"))
      .reverse(),
    trimmed,
  ];
  let parsed: { decision?: unknown; feedback?: unknown } | undefined;
  for (const candidate of candidates) {
    try {
      parsed = JSON.parse(candidate) as { decision?: unknown; feedback?: unknown };
      break;
    } catch {
      // Try the next candidate; Plannotator may print logs before JSON.
    }
  }
  if (!parsed) throw new Error("Plannotator did not return JSON");
  if (parsed.decision === "approved") return { decision: "approved" };
  if (parsed.decision === "annotated") {
    return {
      decision: "annotated",
      feedback: typeof parsed.feedback === "string" ? parsed.feedback : "",
    };
  }
  if (parsed.decision === "dismissed") return { decision: "dismissed" };
  throw new Error("Plannotator returned an unknown decision");
}

/**
 * Never rejects: every failure mode becomes a non-approved result, because the
 * caller turns this into a tool result the model has to act on.
 *
 * SESSION_PLANNER_PLANNOTATOR_BIN overrides the binary; `bin/.src/pi.sh` sets it
 * to `mise which plannotator` so the pinned copy is used rather than PATH's.
 */
export function reviewPlanWithPlannotator(
  planPath: string,
  options: { binary?: string; signal?: AbortSignal } = {},
): Promise<PlanReviewResult> {
  const binary = options.binary || process.env.SESSION_PLANNER_PLANNOTATOR_BIN || "plannotator";
  const mirrorStderr = process.env.SESSION_PLANNER_PLANNOTATOR_VERBOSE === "1";
  return new Promise((resolvePromise) => {
    const child = spawn(binary, ["annotate", planPath, "--gate", "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: PlanReviewResult) => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };

    const abort = () => {
      child.kill();
      finish({ status: "dismissed", feedback: "Plan review was aborted." });
    };

    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (mirrorStderr) process.stderr.write(text);
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      options.signal?.removeEventListener("abort", abort);
      if (err.code === "ENOENT") {
        finish({
          status: "unavailable",
          feedback:
            "Plannotator CLI was not found. Install it or set SESSION_PLANNER_PLANNOTATOR_BIN.",
        });
        return;
      }
      finish({ status: "error", feedback: err.message });
    });
    child.on("close", (code) => {
      options.signal?.removeEventListener("abort", abort);
      if (settled) return;
      if (code !== 0) {
        const detail = stderr.trim() || stdout.trim() || `plannotator exited with code ${code}`;
        finish({ status: "error", feedback: detail });
        return;
      }
      try {
        const decision = parsePlannotatorDecision(stdout);
        if (decision.decision === "approved") {
          finish({ status: "approved" });
        } else if (decision.decision === "annotated") {
          finish({ status: "annotated", feedback: decision.feedback || "Plan changes requested." });
        } else {
          finish({ status: "dismissed", feedback: "Plan review was dismissed without approval." });
        }
      } catch (err) {
        finish({
          status: "error",
          feedback: `Could not parse Plannotator output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });
  });
}
