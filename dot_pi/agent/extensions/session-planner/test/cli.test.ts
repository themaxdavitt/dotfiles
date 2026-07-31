/**
 * The planner launch contract.
 *
 * These argv builders are the whole security story of the planning run: the
 * planning Pi is confined by the nono profile named here and limited to the
 * tools listed here. A silently dropped flag would hand a planning agent write
 * access, so assert the shape rather than trusting it.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildExecutionArgs, buildPlannerArgs, parseArgs, shellQuote } from "../src/cli.js";

const BASE = { profile: "p", pi: "pi", nono: "nono", extension: "/ext/index.ts", cwd: "/repo" };

describe("parseArgs", () => {
  test("defaults to the planner profile and the local extension entry", () => {
    const { options } = parseArgs([]);
    assert.equal(options.profile, "pi-session-planner");
    assert.equal(options.exec, false);
    assert.match(options.extension, /index\.ts$/);
  });

  test("takes values for each option flag", () => {
    const { options } = parseArgs([
      "--profile",
      "custom",
      "--pi",
      "/bin/pi",
      "--nono",
      "/bin/nono",
    ]);
    assert.equal(options.profile, "custom");
    assert.equal(options.pi, "/bin/pi");
    assert.equal(options.nono, "/bin/nono");
  });

  test("resolves path-shaped options to absolute paths", () => {
    const { options } = parseArgs(["--cwd", "."]);
    assert.ok(options.cwd.startsWith("/"));
  });

  test("passes unknown args through to Pi", () => {
    const { passthrough } = parseArgs(["-p", "Plan the change"]);
    assert.deepEqual(passthrough, ["-p", "Plan the change"]);
  });

  test("sends everything after -- to Pi verbatim, flags included", () => {
    const { passthrough } = parseArgs(["--exec", "--", "--profile", "not-ours"]);
    assert.deepEqual(passthrough, ["--profile", "not-ours"]);
  });

  test("reports help instead of running", () => {
    assert.equal(parseArgs(["-h"]).help, true);
    assert.equal(parseArgs(["--help"]).help, true);
  });

  test("rejects an option missing its value rather than eating the next flag", () => {
    assert.throws(() => parseArgs(["--profile", "--exec"]), /--profile requires a value/);
    assert.throws(() => parseArgs(["--profile"]), /--profile requires a value/);
  });
});

describe("buildPlannerArgs", () => {
  const args = buildPlannerArgs(BASE, ["-p", "go"], "run-1", "/data/run-1");
  const joined = args.join(" ");

  test("confines the planning run to the requested nono profile and workdir", () => {
    assert.equal(args[0], "run");
    assert.deepEqual(args.slice(1, 3), ["--profile", "p"]);
    assert.match(joined, /--workdir \/repo/);
    assert.match(joined, /--read \/repo/);
  });

  test("gives the planner read-only tools only", () => {
    // A planning agent that can edit or write has defeated the entire point of
    // gating implementation on an approved plan.
    assert.match(joined, /--tools read,bash,set_turn_plan,submit_session_plan/);
    assert.match(joined, /--exclude-tools ls,find,grep,edit,write/);
    assert.doesNotMatch(joined, /--tools[^-]*\bedit\b/);
  });

  test("runs Gatekeeper headless so the planner never prompts", () => {
    assert.match(joined, /--session-planner/);
    assert.match(joined, /--gatekeeper-mode auto/);
    assert.match(joined, /--gatekeeper-ask never/);
  });

  test("isolates Plannotator state per run", () => {
    assert.match(joined, /PLANNOTATOR_DATA_DIR=\/data\/run-1/);
    assert.match(joined, /PLANNOTATOR_READY_FILE=\/data\/run-1\/ready\.jsonl/);
    assert.match(joined, /SESSION_PLANNER_RUN_ID=run-1/);
  });

  test("appends passthrough args after the extension's own", () => {
    assert.deepEqual(args.slice(-2), ["-p", "go"]);
  });
});

describe("buildExecutionArgs", () => {
  const args = buildExecutionArgs(BASE, "plan-123");

  test("loads the approved plan by id", () => {
    assert.match(args.join(" "), /--approved-session-plan plan-123/);
  });

  test("restores the mutating tools for the implementing run", () => {
    assert.match(args.join(" "), /--tools read,bash,edit,write,set_turn_plan/);
  });

  test("keeps the built-ins Gatekeeper hides excluded", () => {
    assert.match(args.join(" "), /--exclude-tools ls,find,grep/);
  });
});

describe("shellQuote", () => {
  test("leaves copy-pasteable tokens unquoted", () => {
    assert.equal(shellQuote("--tools"), "--tools");
    assert.equal(shellQuote("/usr/bin/pi"), "/usr/bin/pi");
  });

  test("quotes anything with a space", () => {
    assert.equal(shellQuote("two words"), "'two words'");
  });

  test("escapes an embedded single quote", () => {
    assert.equal(shellQuote("it's"), "'it'\\''s'");
  });
});
