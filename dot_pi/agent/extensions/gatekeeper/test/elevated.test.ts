import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { runElevated } from "../src/sandbox/elevated";

let tempDir: string;

before(() => {
  tempDir = mkdtempSync(join(tmpdir(), "gatekeeper-elevated-"));
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("runElevated", () => {
  test("returns stdout and a zero exit code", async () => {
    assert.deepEqual(await runElevated("echo hi", tempDir, undefined), {
      output: "hi\n",
      exitCode: 0,
    });
  });

  test("runs in the requested cwd", async () => {
    // realpath: macOS tmpdir lives behind the /var -> /private/var symlink.
    assert.equal(
      (await runElevated("pwd", tempDir, undefined)).output.trim(),
      realpathSync(tempDir),
    );
  });

  test("reports a non-zero exit code instead of throwing", async () => {
    assert.equal((await runElevated("exit 3", tempDir, undefined)).exitCode, 3);
  });

  test("times out", async () => {
    await assert.rejects(runElevated("sleep 5", tempDir, undefined, 200), /timed out/);
  });

  test("never sources a stray BASH_ENV before the approved command", async () => {
    // Elevated commands run unsandboxed, so a hostile BASH_ENV would execute
    // with full privileges ahead of whatever the user actually approved.
    const bashEnvFile = join(tempDir, "bash-env-marker.sh");
    writeFileSync(bashEnvFile, "echo LEAKED_BASH_ENV\n");
    const previous = process.env.BASH_ENV;
    process.env.BASH_ENV = bashEnvFile;
    try {
      assert.equal((await runElevated("echo clean", tempDir, undefined)).output, "clean\n");
    } finally {
      if (previous === undefined) delete process.env.BASH_ENV;
      else process.env.BASH_ENV = previous;
    }
  });
});
