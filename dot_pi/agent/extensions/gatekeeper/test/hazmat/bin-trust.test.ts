import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  DEFAULT_BIN_TRUST,
  isBinTrustConfig,
  isExecInfluencingVar,
  isShellBuiltin,
  isWithin,
  resolveTrustEnv,
  staticSearchDirs,
} from "../../src/hazmat/bin-trust";

describe("isExecInfluencingVar", () => {
  test("catches vars that redirect execution or write an output file", () => {
    // `PATH=/tmp/evil ls` and `DYLD_INSERT_LIBRARIES=x.dylib ls` both passed
    // before this rule existed: the assignment redirects the very lookup the
    // trust check vouched for.
    for (const name of [
      "PATH",
      "IFS",
      "BASH_ENV",
      "ENV",
      "SHELLOPTS",
      "BASHOPTS",
      "CDPATH",
      "GLOBIGNORE",
      "PROMPT_COMMAND",
      "NONO_LOG_FILE",
      "DYLD_INSERT_LIBRARIES",
      "DYLD_LIBRARY_PATH",
      "LD_PRELOAD",
    ]) {
      assert.equal(isExecInfluencingVar(name), true, name);
    }
  });

  test("leaves ordinary vars alone", () => {
    assert.equal(isExecInfluencingVar("HOME"), false);
    assert.equal(isExecInfluencingVar("FOO"), false);
  });
});

describe("isShellBuiltin", () => {
  test("knows builtins need no PATH lookup", () => {
    assert.equal(isShellBuiltin("test"), true);
    assert.equal(isShellBuiltin("ls"), false);
  });
});

describe("isWithin", () => {
  test("accepts a descendant and the directory itself", () => {
    assert.equal(isWithin("/a/b/c", "/a/b"), true);
    assert.equal(isWithin("/a/b", "/a/b"), true);
  });

  test("rejects a sibling that merely shares a prefix", () => {
    // /a/bc is not inside /a/b — a string prefix test would wrongly trust it.
    assert.equal(isWithin("/a/bc", "/a/b"), false);
  });

  test("rejects an ancestor", () => {
    assert.equal(isWithin("/a", "/a/b"), false);
  });
});

describe("isBinTrustConfig", () => {
  test("accepts the documented shape", () => {
    assert.equal(isBinTrustConfig({ roots: ["/bin"], miseTools: ["nono"] }), true);
    assert.equal(isBinTrustConfig({}), true);
  });

  test("rejects malformed config rather than silently widening trust", () => {
    assert.equal(isBinTrustConfig({ roots: "/bin" }), false);
    assert.equal(isBinTrustConfig({ miseTools: [1] }), false);
  });
});

describe("staticSearchDirs", () => {
  test("expands ~, keeps listed order, and drops relative entries", () => {
    // A relative entry would resolve against the agent's cwd, so it can never
    // be a trusted root.
    assert.deepEqual(staticSearchDirs({ miseTools: ["nono"], roots: ["~/bin", "/bin", "rel"] }), [
      join(homedir(), "bin"),
      "/bin",
    ]);
  });
});

describe("resolveTrustEnv", () => {
  test("puts mise dirs first, then roots in order, deduped", async (t) => {
    const built = await resolveTrustEnv({
      cwd: homedir(),
      config: { miseTools: ["nono"], roots: ["~/bin", "/usr/bin", "/bin", "/usr/bin"] },
    });
    if (built.warnings.length > 0) {
      t.skip("`mise which nono` unavailable");
      return;
    }
    // mise first so a pinned tool beats a system copy of the same name.
    assert.match(built.searchDirs[0], /mise/);
    assert.deepEqual(built.searchDirs.slice(1), [join(homedir(), "bin"), "/usr/bin", "/bin"]);
    assert.equal(built.path, built.searchDirs.join(":"));
  });

  test("uses one list for both jobs: bash's search path and the trust set", async (t) => {
    const built = await resolveTrustEnv({
      cwd: homedir(),
      config: { miseTools: ["nono"], roots: DEFAULT_BIN_TRUST.roots },
    });
    if (built.warnings.length > 0) {
      t.skip("`mise which nono` unavailable");
      return;
    }
    // Two lists here would mean gating a lookup that never happens.
    assert.equal(built.trustedRoots.length, built.searchDirs.length);
  });

  test("warns loudly about an unresolvable mise tool", async () => {
    // It is off the tools PATH, so the command dies with command-not-found
    // even after the user approves it.
    const built = await resolveTrustEnv({
      cwd: homedir(),
      config: { miseTools: ["definitely-not-a-real-tool"], roots: DEFAULT_BIN_TRUST.roots },
    });
    assert.equal(built.warnings.length, 1);
    assert.match(built.warnings[0], /mise which definitely-not-a-real-tool` failed/);
  });
});
