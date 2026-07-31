import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  DEFAULT_AUDITOR,
  DEFAULT_CONFIG,
  gatekeeperConfigPath,
  loadFileConfig,
} from "../src/config";
import { DEFAULT_BIN_TRUST } from "../src/hazmat/bin-trust";

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "gatekeeper-config-"));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a config file and load it. */
function load(contents: string) {
  const path = join(dir, `${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, contents);
  return loadFileConfig(path);
}

describe("gatekeeperConfigPath", () => {
  test("points at the agent dir, never the session cwd", () => {
    // A project-local config let the agent award itself danger on
    // the next session, because the sandbox profile grants it write access to
    // its own workdir (removed 2026-07-27).
    assert.equal(gatekeeperConfigPath("/agent"), "/agent/extensions/gatekeeper.json");
  });
});

describe("loadFileConfig", () => {
  test("falls back to defaults when no file exists", () => {
    const loaded = loadFileConfig(join(dir, "does-not-exist.json"));
    assert.deepEqual(loaded.config, DEFAULT_CONFIG);
    assert.deepEqual(loaded.auditor, DEFAULT_AUDITOR);
    assert.deepEqual(loaded.binTrust, DEFAULT_BIN_TRUST);
  });

  test("keeps the defaults when the file is unparseable", () => {
    // A broken config must never leave the session with no policy at all.
    assert.deepEqual(load("{ not json").config, DEFAULT_CONFIG);
  });

  test("reads every supported field", () => {
    const loaded = load(
      JSON.stringify({
        mode: "auto",
        askMode: "never",
        planExemptTools: ["AskUserQuestion", "read"],
        auditor: { provider: "anthropic", modelId: "claude-haiku-4-5" },
        binTrust: { roots: ["/bin"], miseTools: ["nono"] },
      }),
    );
    assert.equal(loaded.config.mode, "auto");
    assert.equal(loaded.config.askMode, "never");
    assert.deepEqual(loaded.config.planExemptTools, ["AskUserQuestion", "read"]);
    assert.deepEqual(loaded.auditor, { provider: "anthropic", modelId: "claude-haiku-4-5" });
    assert.deepEqual(loaded.binTrust, { roots: ["/bin"], miseTools: ["nono"] });
  });

  test("ignores an unknown mode rather than trusting it", () => {
    assert.equal(load(JSON.stringify({ mode: "acceptEdits" })).config.mode, DEFAULT_CONFIG.mode);
    assert.equal(
      load(JSON.stringify({ askMode: "sometimes" })).config.askMode,
      DEFAULT_CONFIG.askMode,
    );
  });

  test("ignores a malformed binTrust instead of widening trust", () => {
    assert.deepEqual(
      load(JSON.stringify({ binTrust: { roots: "/bin" } })).binTrust,
      DEFAULT_BIN_TRUST,
    );
    assert.deepEqual(
      load(JSON.stringify({ binTrust: { miseTools: [1] } })).binTrust,
      DEFAULT_BIN_TRUST,
    );
  });

  test("fills in the missing half of a partial binTrust from the defaults", () => {
    // The list is also the tools PATH, so a half-specified one must not leave
    // approved commands with nowhere to resolve.
    const loaded = load(JSON.stringify({ binTrust: { miseTools: ["nono"] } }));
    assert.deepEqual(loaded.binTrust.miseTools, ["nono"]);
    assert.deepEqual(loaded.binTrust.roots, DEFAULT_BIN_TRUST.roots);
  });

  test("ignores a half-specified auditor", () => {
    assert.deepEqual(
      load(JSON.stringify({ auditor: { provider: "anthropic" } })).auditor,
      DEFAULT_AUDITOR,
    );
  });

  test("ignores a non-string planExemptTools list", () => {
    assert.deepEqual(
      load(JSON.stringify({ planExemptTools: ["ok", 3] })).config.planExemptTools,
      DEFAULT_CONFIG.planExemptTools,
    );
  });

  test("accepts an empty planExemptTools list as a real choice", () => {
    assert.deepEqual(load(JSON.stringify({ planExemptTools: [] })).config.planExemptTools, []);
  });

  test("does not let one load mutate the defaults for the next", () => {
    load(JSON.stringify({ mode: "danger", planExemptTools: [] }));
    assert.equal(DEFAULT_CONFIG.mode, "manual");
    assert.deepEqual(DEFAULT_CONFIG.planExemptTools, ["AskUserQuestion"]);
  });
});
