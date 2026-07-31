import assert from "node:assert/strict";
import { delimiter } from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  configureToolsPath,
  sandboxBashOperations,
  sandboxSpawnHook,
  shellQuote,
  toolsPath,
  toolsProfile,
  wrapBashCommand,
} from "../src/sandbox/wrap";
import { shouldSandboxUserBash } from "../src/policy";

// The tools PATH is module-level mutable state configured once per session.
// Restore it around every test so declaration order stops mattering.
const ORIGINAL_TOOLS_PATH = toolsPath();
afterEach(() => {
  configureToolsPath(ORIGINAL_TOOLS_PATH.split(delimiter));
});

describe("shellQuote", () => {
  test("closes, escapes, and reopens around an embedded single quote", () => {
    assert.equal(shellQuote("it's"), "'it'\\''s'");
  });

  test("wraps ordinary text verbatim", () => {
    assert.equal(shellQuote("echo hi"), "'echo hi'");
  });

  test("neutralizes a quote-break injection attempt", () => {
    // Without the escape this would end the quoted string and start a new command.
    assert.equal(shellQuote("'; rm -rf /; '"), "''\\''; rm -rf /; '\\'''");
  });
});

describe("toolsProfile", () => {
  test("defaults to the pi-tools profile", () => {
    assert.equal(toolsProfile(), "pi-tools");
  });

  test("honors the documented test-only override", () => {
    process.env.GATEKEEPER_NONO_PROFILE = "/tmp/some-profile.jsonc";
    try {
      assert.equal(toolsProfile(), "/tmp/some-profile.jsonc");
    } finally {
      delete process.env.GATEKEEPER_NONO_PROFILE;
    }
  });
});

describe("toolsPath", () => {
  test("never falls back to the ambient PATH before the session config resolves", () => {
    // /etc/paths.d puts entries on the login PATH that bash would resolve
    // against agent-writable space; the pre-config value must be ours, not that.
    assert.ok(!toolsPath().includes("/usr/local/share/dotnet"));
  });

  test("takes the dirs the session config resolved", () => {
    configureToolsPath(["/pinned/one", "/pinned/two"]);
    assert.equal(toolsPath(), "/pinned/one:/pinned/two");
  });
});

describe("wrapBashCommand", () => {
  test("wraps the command in nono with a pinned PATH and a pure bash", () => {
    configureToolsPath(["/pinned/one", "/pinned/two"]);
    const wrapped = wrapBashCommand("echo 'hi there'");
    assert.match(
      wrapped,
      /^nono run --profile 'pi-tools' --allow-cwd --trust-proxy-ca --silent -- env -u BASH_ENV -u ENV PATH='\/pinned\/one:\/pinned\/two' bash --noprofile --norc -c /,
    );
    assert.ok(wrapped.endsWith(`bash --noprofile --norc -c 'echo '\\''hi there'\\'''`));
  });

  test("sets a default PATH without forcing one", () => {
    // PATH #2 stays the agent's: `PATH=./node_modules/.bin npm test` is
    // legitimate work, so a per-command assignment must still win (the analyzer
    // gates such statements for review rather than rewriting them).
    const wrapped = wrapBashCommand("ls");
    assert.ok(!wrapped.includes("readonly PATH"));
    assert.ok(!wrapped.includes("export PATH"));
  });

  test("quotes the profile so a path-shaped profile cannot break out", () => {
    process.env.GATEKEEPER_NONO_PROFILE = "/a dir/profile.jsonc";
    try {
      assert.match(wrapBashCommand("ls"), /--profile '\/a dir\/profile\.jsonc'/);
    } finally {
      delete process.env.GATEKEEPER_NONO_PROFILE;
    }
  });
});

describe("sandboxSpawnHook", () => {
  test("pins the spawn env PATH so the outer nono lookup uses our list", () => {
    configureToolsPath(["/pinned/one", "/pinned/two"]);
    const context = { command: "ls", cwd: "/repo", env: { HOME: "/h" } };
    const hooked = sandboxSpawnHook(context as never);
    assert.equal(hooked.env.PATH, "/pinned/one:/pinned/two");
  });

  test("rewrites the command and preserves the rest of the context", () => {
    const context = { command: "ls", cwd: "/repo", env: { HOME: "/h" } };
    const hooked = sandboxSpawnHook(context as never);
    assert.match(hooked.command, /^nono run --profile /);
    assert.equal(hooked.cwd, "/repo");
    assert.equal(hooked.env.HOME, "/h");
  });
});

describe("shouldSandboxUserBash", () => {
  test("confines a plain `!` command", () => {
    assert.equal(shouldSandboxUserBash(false), true);
  });

  test("lets `!!` out — the one deliberate escape hatch for a typed command", () => {
    assert.equal(shouldSandboxUserBash(true), false);
  });
});

describe("sandboxBashOperations", () => {
  /** Records what the delegate was handed, and reports a clean exit. */
  function spyOperations() {
    const calls: { command: string; cwd: string; env?: NodeJS.ProcessEnv }[] = [];
    return {
      calls,
      operations: {
        exec: async (
          command: string,
          cwd: string,
          options: { env?: NodeJS.ProcessEnv },
        ): Promise<{ exitCode: number | null }> => {
          calls.push({ command, cwd, env: options.env });
          return { exitCode: 0 };
        },
      },
    };
  }

  test("wraps the delegate's command in nono", async () => {
    const spy = spyOperations();
    await sandboxBashOperations(spy.operations as never).exec("ls", "/repo", {
      onData: () => {},
    } as never);
    assert.equal(spy.calls.length, 1);
    assert.match(spy.calls[0]!.command, /^nono run --profile /);
    assert.ok(spy.calls[0]!.command.endsWith(`bash --noprofile --norc -c 'ls'`));
    assert.equal(spy.calls[0]!.cwd, "/repo");
  });

  test("pins PATH rather than letting the delegate default to the ambient env", () => {
    // Pi's local operations fall back to `getShellEnv()` when handed no env,
    // which is the login PATH — the outer `nono` would then resolve off a list
    // nobody groomed. Passing env explicitly is what stops that.
    configureToolsPath(["/pinned/one", "/pinned/two"]);
    const spy = spyOperations();
    return sandboxBashOperations(spy.operations as never)
      .exec("ls", "/repo", { onData: () => {}, env: { HOME: "/h" } } as never)
      .then(() => {
        assert.equal(spy.calls[0]!.env?.PATH, "/pinned/one:/pinned/two");
        assert.equal(spy.calls[0]!.env?.HOME, "/h");
      });
  });

  test("supplies an env even when the caller passes none", async () => {
    const spy = spyOperations();
    await sandboxBashOperations(spy.operations as never).exec("ls", "/repo", {
      onData: () => {},
    } as never);
    assert.ok(spy.calls[0]!.env !== undefined);
    assert.equal(spy.calls[0]!.env?.PATH, toolsPath());
  });

  test("forwards the caller's other options untouched", async () => {
    const seen: Record<string, unknown>[] = [];
    const operations = {
      exec: async (_c: string, _d: string, options: Record<string, unknown>) => {
        seen.push(options);
        return { exitCode: 0 };
      },
    };
    const signal = new AbortController().signal;
    const onData = () => {};
    await sandboxBashOperations(operations as never).exec("ls", "/repo", {
      onData,
      signal,
      timeout: 42,
    } as never);
    assert.equal(seen[0]!.signal, signal);
    assert.equal(seen[0]!.timeout, 42);
    assert.equal(seen[0]!.onData, onData);
  });
});
