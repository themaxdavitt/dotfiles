import assert from "node:assert/strict";
import { homedir } from "node:os";
import { describe, test } from "node:test";
import { WARMUP_PAYLOAD, proxyCaWarmupArgs, warmProxyCa } from "../src/sandbox/warmup";
import { wrapBashCommand } from "../src/sandbox/wrap";

describe("proxyCaWarmupArgs", () => {
  test("names the profile it was given", () => {
    assert.deepEqual(proxyCaWarmupArgs("pi-tools").slice(0, 3), ["run", "--profile", "pi-tools"]);
  });

  test("carries every sandbox flag the real bash wrapper uses", () => {
    // If wrap.ts ever changes which CA nono is asked to trust, warming with the
    // old flag set would trust the wrong one and the keychain prompt would come
    // back mid-session — the exact thing this exists to prevent. Compare against
    // wrapBashCommand rather than a copied literal so the two cannot drift.
    const wrapped = wrapBashCommand("echo hi");
    const args = proxyCaWarmupArgs("pi-tools");
    for (const flag of ["--allow-cwd", "--trust-proxy-ca", "--silent"]) {
      assert.ok(wrapped.includes(flag), `wrapBashCommand no longer passes ${flag}`);
      assert.ok(args.includes(flag), `warm-up no longer passes ${flag}`);
    }
  });

  test("runs an absolute no-op rather than a PATH lookup", () => {
    // `nono run` trusts the CA on the way in, so the payload is irrelevant —
    // but it still resolves inside the sandbox, where our PATH does not apply.
    const args = proxyCaWarmupArgs("pi-tools");
    assert.equal(args.at(-2), "--");
    assert.equal(args.at(-1), WARMUP_PAYLOAD);
    assert.ok(WARMUP_PAYLOAD.startsWith("/"), "payload must not depend on PATH");
  });
});

describe("warmProxyCa", () => {
  test("runs outside $HOME, which --allow-cwd refuses", async () => {
    // $HOME overlaps nono's own state root, and Pi is often launched there.
    let seenCwd: string | undefined;
    const outcome = await warmProxyCa({
      profile: "pi-tools",
      run: async (_args, cwd) => {
        seenCwd = cwd;
      },
    });
    assert.deepEqual(outcome, { ok: true });
    assert.notEqual(seenCwd, homedir());
  });

  test("reports a failure instead of throwing into session start", async () => {
    const outcome = await warmProxyCa({
      run: async () => {
        throw new Error("nono: unknown profile");
      },
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.detail ?? "", /unknown profile/);
    // The message has to say what the user will actually notice.
    assert.match(outcome.detail ?? "", /mid-session/);
  });
});
