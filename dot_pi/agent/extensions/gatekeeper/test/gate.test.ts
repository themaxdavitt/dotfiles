/**
 * The gate's decision pipeline.
 *
 * The ORDER of these checks is the security property — e.g. the turn-plan gate
 * has to come before anything that can execute, and elevated_bash must reach a
 * human even in `auto`. Every collaborator is a fake here, so a reordering
 * shows up as a failure rather than as a quiet behavior change in production.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_CONFIG } from "../src/config";
import { type GateDeps, type GateToolCall, decideToolCall } from "../src/gate";
import type { GatekeeperConfig } from "../src/policy";

interface Calls {
  asked: { toolName: string; reasons?: string[] }[];
  audited: string[];
  analyzed: string[];
}

function makeDeps(overrides: Partial<GateDeps> = {}, config: Partial<GatekeeperConfig> = {}) {
  const calls: Calls = { asked: [], audited: [], analyzed: [] };
  const deps: GateDeps = {
    config: { ...DEFAULT_CONFIG, ...config },
    hasPlan: true,
    askAvailable: true,
    nonoProfile: "pi-tools",
    async analyze(command) {
      calls.analyzed.push(command);
      return { gated: false, reasons: [], warnings: [] };
    },
    async gateFile() {
      return undefined;
    },
    async audit(summary) {
      calls.audited.push(summary);
      return { verdict: "allow", reason: "in scope" };
    },
    async ask(toolName, _input, reasons) {
      calls.asked.push({ toolName, reasons });
      return { allowed: true };
    },
    summarize: (toolName, input) => `${toolName} ${JSON.stringify(input)}`,
    reportWarnings() {},
    ...overrides,
  };
  return { deps, calls };
}

const bashCall: GateToolCall = { toolName: "bash", input: { command: "rm -rf build" } };
const readCall: GateToolCall = { toolName: "read", input: { path: "/repo/a.ts" } };

describe("hidden built-ins", () => {
  test("are blocked in every mode, with or without a turn plan", async () => {
    for (const mode of ["manual", "auto", "danger"] as const) {
      const { deps } = makeDeps({ hasPlan: false }, { mode });
      const outcome = await decideToolCall({ toolName: "grep", input: {} }, deps);
      assert.equal(outcome.kind, "block", mode);
      assert.match(outcome.reason, /Bash CLI commands/);
    }
  });
});

describe("the turn-plan gate", () => {
  test("blocks any tool before a plan is declared", async () => {
    const { deps } = makeDeps({ hasPlan: false });
    const outcome = await decideToolCall(readCall, deps);
    assert.equal(outcome.kind, "block");
    assert.match(outcome.reason, /call set_turn_plan/);
  });

  test("never gates the plan tool itself", async () => {
    // Declaring the plan is what satisfies the gate, so gating it deadlocks.
    const { deps } = makeDeps({ hasPlan: false });
    assert.equal(
      (await decideToolCall({ toolName: "set_turn_plan", input: {} }, deps)).kind,
      "allow",
    );
  });

  test("lets an exempt tool through so the agent can ask before planning", async () => {
    const { deps } = makeDeps({ hasPlan: false });
    const outcome = await decideToolCall({ toolName: "AskUserQuestion", input: {} }, deps);
    assert.equal(outcome.kind, "allow");
  });

  test("exempts nothing else", async () => {
    const { deps } = makeDeps({ hasPlan: false }, { planExemptTools: [] });
    assert.equal(
      (await decideToolCall({ toolName: "AskUserQuestion", input: {} }, deps)).kind,
      "block",
    );
  });
});

describe("danger", () => {
  test("skips the file gate, the analyzer, and the dialog", async () => {
    const { deps, calls } = makeDeps(
      {
        async gateFile() {
          throw new Error("file gate must not run under danger");
        },
      },
      { mode: "danger" },
    );
    assert.equal((await decideToolCall(bashCall, deps)).kind, "allow");
    assert.equal((await decideToolCall(readCall, deps)).kind, "allow");
    assert.deepEqual(calls.analyzed, []);
    assert.deepEqual(calls.asked, []);
  });

  test("still requires a turn plan", async () => {
    // The escape hatch is about permissions, not about skipping the plan.
    const { deps } = makeDeps({ hasPlan: false }, { mode: "danger" });
    assert.equal((await decideToolCall(bashCall, deps)).kind, "block");
  });

  test("marks bash as started so timing stays honest", async () => {
    const { deps } = makeDeps({}, { mode: "danger" });
    const outcome = await decideToolCall(bashCall, deps);
    assert.equal(outcome.kind === "allow" && outcome.startsBash, true);
  });
});

describe("the file-write gate", () => {
  const writeCall: GateToolCall = { toolName: "write", input: { path: "/repo/a.ts" } };
  const editCall: GateToolCall = { toolName: "edit", input: { path: "/repo/a.ts" } };

  test("manual asks before edit and write", async () => {
    // These are in-process fs calls: unlike bash, no OS sandbox stands behind
    // this decision, so manual mode is the only thing in front of the disk.
    for (const call of [writeCall, editCall]) {
      const { deps, calls } = makeDeps({}, { mode: "manual" });
      assert.equal((await decideToolCall(call, deps)).kind, "allow");
      assert.deepEqual(
        calls.asked.map((a) => a.toolName),
        [call.toolName],
      );
    }
  });

  test("a decline carries the user's message back to the model", async () => {
    const { deps } = makeDeps(
      {
        async ask() {
          return { allowed: false, message: "edit the source, not the target" };
        },
      },
      { mode: "manual" },
    );
    const outcome = await decideToolCall(writeCall, deps);
    assert.equal(outcome.kind, "block");
    assert.equal(outcome.reason, "Declined by user: edit the source, not the target");
  });

  test("manual blocks a write it cannot ask about", async () => {
    const { deps, calls } = makeDeps({ askAvailable: false }, { mode: "manual" });
    const outcome = await decideToolCall(writeCall, deps);
    assert.equal(outcome.kind, "block");
    assert.match(outcome.reason, /--gatekeeper-mode auto/);
    assert.deepEqual(calls.asked, []);
  });

  test("auto writes without prompting", async () => {
    const { deps, calls } = makeDeps({}, { mode: "auto" });
    assert.equal((await decideToolCall(writeCall, deps)).kind, "allow");
    assert.deepEqual(calls.asked, []);
  });

  test("never reports an approved write as a bash start", async () => {
    const { deps } = makeDeps({}, { mode: "manual" });
    const outcome = await decideToolCall(writeCall, deps);
    assert.equal(outcome.kind === "allow" && outcome.startsBash, false);
  });

  test("a profile denial prompts once, not twice", async () => {
    // The denial path asks with the richer reasons and returns; the manual gate
    // must not then ask again about the same write.
    const { deps, calls } = makeDeps(
      {
        async gateFile() {
          return {
            path: "/etc/hosts",
            op: "write" as const,
            detail: "outside the workdir grant",
            blockReason: "Gatekeeper: profile denies write",
          };
        },
      },
      { mode: "manual" },
    );
    assert.equal((await decideToolCall(writeCall, deps)).kind, "allow");
    assert.equal(calls.asked.length, 1);
    assert.match(calls.asked[0].reasons?.join("\n") ?? "", /profile denies write/);
  });

  test("read is never gated by mode alone", async () => {
    const { deps, calls } = makeDeps({}, { mode: "manual" });
    assert.equal((await decideToolCall(readCall, deps)).kind, "allow");
    assert.deepEqual(calls.asked, []);
  });
});

describe("the file-tool profile gate", () => {
  const denial = {
    path: "/home/me/.ssh/id_ed25519",
    op: "read" as const,
    detail: "outside the workdir grant",
    blockReason: "Gatekeeper: profile denies read",
  };

  test("asks the user, naming the profile and the path", async () => {
    const { deps, calls } = makeDeps({
      async gateFile() {
        return denial;
      },
    });
    assert.equal((await decideToolCall(readCall, deps)).kind, "allow");
    assert.equal(calls.asked.length, 1);
    assert.match(calls.asked[0].reasons?.join("\n") ?? "", /pi-tools' profile denies read/);
    assert.match(calls.asked[0].reasons?.join("\n") ?? "", /id_ed25519/);
    assert.match(calls.asked[0].reasons?.join("\n") ?? "", /unsandboxed Pi process/);
  });

  test("blocks with the profile's reason when no human is reachable", async () => {
    const { deps, calls } = makeDeps({
      askAvailable: false,
      async gateFile() {
        return denial;
      },
    });
    const outcome = await decideToolCall(readCall, deps);
    assert.equal(outcome.kind, "block");
    assert.equal(outcome.reason, denial.blockReason);
    assert.deepEqual(calls.asked, []);
  });

  test("carries a decline message back to the model", async () => {
    const { deps } = makeDeps({
      async gateFile() {
        return denial;
      },
      async ask() {
        return { allowed: false, message: "not that key" };
      },
    });
    const outcome = await decideToolCall(readCall, deps);
    assert.equal(outcome.kind, "block");
    assert.equal(outcome.reason, "Declined by user: not that key");
  });

  test("never reports an approved file tool as a bash start", async () => {
    const { deps } = makeDeps({
      async gateFile() {
        return denial;
      },
    });
    const outcome = await decideToolCall(readCall, deps);
    assert.equal(outcome.kind === "allow" && outcome.startsBash, false);
  });
});

describe("elevated_bash", () => {
  const call: GateToolCall = { toolName: "elevated_bash", input: { command: "brew install x" } };

  test("always reaches a human, even in auto", async () => {
    // The auditor must never be able to approve leaving the sandbox.
    const { deps, calls } = makeDeps({}, { mode: "auto" });
    assert.equal((await decideToolCall(call, deps)).kind, "allow");
    assert.deepEqual(calls.audited, []);
    assert.equal(calls.asked.length, 1);
    assert.match(calls.asked[0].reasons?.join("\n") ?? "", /OUTSIDE the per-call nono sandbox/);
  });

  test("is blocked outright when no human is reachable", async () => {
    for (const mode of ["manual", "auto"] as const) {
      const { deps } = makeDeps({ askAvailable: false }, { mode });
      const outcome = await decideToolCall(call, deps);
      assert.equal(outcome.kind, "block", mode);
      assert.match(outcome.reason, /requires interactive user approval/);
    }
  });
});

describe("bash gating", () => {
  test("runs an allowlisted command with no prompt and no audit", async () => {
    const { deps, calls } = makeDeps({}, { mode: "auto" });
    const outcome = await decideToolCall(bashCall, deps);
    assert.equal(outcome.kind, "allow");
    assert.equal(outcome.kind === "allow" && outcome.startsBash, true);
    assert.deepEqual(calls.asked, []);
    assert.deepEqual(calls.audited, []);
  });

  test("passes the analyzer the command text", async () => {
    const { deps, calls } = makeDeps();
    await decideToolCall(bashCall, deps);
    assert.deepEqual(calls.analyzed, ["rm -rf build"]);
  });

  test("surfaces analyzer warnings even when the command passes", async () => {
    const warnings: string[] = [];
    const { deps } = makeDeps({
      async analyze() {
        return { gated: false, reasons: [], warnings: ["mise which rg failed"] };
      },
      reportWarnings: (w) => warnings.push(...w),
    });
    await decideToolCall(bashCall, deps);
    assert.deepEqual(warnings, ["mise which rg failed"]);
  });

  const gated: Partial<GateDeps> = {
    async analyze() {
      return { gated: true, reasons: ["not in the safe command allowlist"], warnings: [] };
    },
  };

  test("manual mode prompts, showing the detection reasons", async () => {
    const { deps, calls } = makeDeps(gated, { mode: "manual" });
    assert.equal((await decideToolCall(bashCall, deps)).kind, "allow");
    assert.equal(calls.asked.length, 1);
    assert.match(calls.asked[0].reasons?.join("\n") ?? "", /not in the safe command allowlist/);
  });

  // The reasons are why the user is being interrupted at all, so they are not
  // suppressible: there is no config path that reaches a dialog without them.
  test("the auditor's verdict and the analyzer's reasons both reach the dialog", async () => {
    const { deps, calls } = makeDeps(
      {
        ...gated,
        async audit() {
          return { verdict: "ask", reason: "deletes a build directory" };
        },
      },
      { mode: "auto" },
    );
    await decideToolCall(bashCall, deps);
    const reasons = calls.asked[0].reasons?.join("\n") ?? "";
    assert.match(reasons, /Auditor verdict: ask/);
    assert.match(reasons, /not in the safe command allowlist/);
  });

  test("auto audits first and honors an allow verdict without prompting", async () => {
    const { deps, calls } = makeDeps(gated, { mode: "auto" });
    assert.equal((await decideToolCall(bashCall, deps)).kind, "allow");
    assert.equal(calls.audited.length, 1);
    assert.match(calls.audited[0], /rm -rf build/);
    assert.deepEqual(calls.asked, []);
  });

  test("auto escalates a block verdict to the human rather than deciding alone", async () => {
    const { deps, calls } = makeDeps(
      {
        ...gated,
        async audit() {
          return { verdict: "block", reason: "deletes an unrelated tree" };
        },
      },
      { mode: "auto" },
    );
    assert.equal((await decideToolCall(bashCall, deps)).kind, "allow");
    assert.equal(calls.asked.length, 1);
    assert.match(calls.asked[0].reasons?.join("\n") ?? "", /deletes an unrelated tree/);
  });

  test("auto blocks on a block verdict when nobody can be asked", async () => {
    const { deps, calls } = makeDeps(
      {
        ...gated,
        askAvailable: false,
        async audit() {
          return { verdict: "block", reason: "deletes an unrelated tree" };
        },
      },
      { mode: "auto" },
    );
    const outcome = await decideToolCall(bashCall, deps);
    assert.equal(outcome.kind, "block");
    assert.match(outcome.reason, /deletes an unrelated tree/);
    assert.deepEqual(calls.asked, []);
  });

  test("default blocks rather than running unattended when nobody can be asked", async () => {
    const { deps } = makeDeps({ ...gated, askAvailable: false }, { mode: "manual" });
    assert.equal((await decideToolCall(bashCall, deps)).kind, "block");
  });

  test("carries an approval note out for delivery with the tool result", async () => {
    const { deps } = makeDeps({
      ...gated,
      async ask() {
        return { allowed: true, message: "only the build dir" };
      },
    });
    const outcome = await decideToolCall(bashCall, deps);
    assert.equal(outcome.kind === "allow" && outcome.note, "only the build dir");
  });

  test("a bare decline still reads as a decline", async () => {
    const { deps } = makeDeps({
      ...gated,
      async ask() {
        return { allowed: false };
      },
    });
    const outcome = await decideToolCall(bashCall, deps);
    assert.equal(outcome.kind, "block");
    assert.equal(outcome.reason, "Declined by user");
  });
});

describe("ungated tools", () => {
  test("run without analysis once the file gate is satisfied", async () => {
    const { deps, calls } = makeDeps();
    const outcome = await decideToolCall(
      { toolName: "write", input: { path: "/repo/a.ts" } },
      deps,
    );
    assert.equal(outcome.kind, "allow");
    assert.equal(outcome.kind === "allow" && outcome.startsBash, false);
    assert.deepEqual(calls.analyzed, []);
  });
});
