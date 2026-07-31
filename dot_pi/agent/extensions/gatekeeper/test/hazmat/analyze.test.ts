/**
 * The bash gate's regression suite.
 *
 * Nearly every case here is a real bypass that ran unprompted until the dated
 * fix that closed it. Treat a failure as a live hole, not a stale expectation,
 * and never relax an assertion to make a refactor pass.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { analyzeCommand } from "../../src/hazmat/analyze";

/** A workdir the agent can write, holding plants named after safe commands. */
let plantDir: string;
/** Resolution uses the config-derived PATH, exactly as production does. */
let inPlantDir: { cwd: string };
/** Synthetic PATHs for shapes the config can never produce — only reachable
 *  through the documented test-only seam. */
const systemPath = "/usr/bin:/bin";

function makeExecutable(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

before(() => {
  plantDir = mkdtempSync(join(tmpdir(), "gatekeeper-plant-"));
  inPlantDir = { cwd: plantDir };
  for (const name of ["ls", "nono", "timeout", "rg"]) {
    makeExecutable(plantDir, name, "echo pwned");
  }
});

after(() => {
  rmSync(plantDir, { recursive: true, force: true });
});

describe("the read-only allowlist", () => {
  test("passes a proven read-only command", async () => {
    assert.equal((await analyzeCommand("ls -la")).gated, false);
  });

  test("gates a command that is not on the allowlist", async () => {
    assert.equal((await analyzeCommand("touch x")).gated, true);
  });

  test("gates find, which can delete", async () => {
    assert.equal((await analyzeCommand("find . -name '*.tmp' -delete")).gated, true);
  });

  test("gates printf forms that can assign PATH", async () => {
    for (const command of [
      "printf -v PATH %s /tmp/evil",
      "printf -vPATH %s /tmp/evil",
      "printf \\-v PATH %s /tmp/evil",
      "printf $'-v' PATH %s /tmp/evil",
      'printf "$format" PATH %s /tmp/evil',
      "printf -v PATH %s /tmp/evil; ls",
    ]) {
      assert.equal((await analyzeCommand(command)).gated, true, `expected gate: ${command}`);
    }
  });

  test("passes ordinary printf output after a static format or --", async () => {
    assert.equal((await analyzeCommand("printf '%s\\n' hello")).gated, false);
    assert.equal((await analyzeCommand('printf -- "$format"')).gated, false);
  });
});

describe("a command name is not an identity", () => {
  // Stripping the directory to match the allowlist is what let all of these
  // run unprompted until 2026-07-27.
  test("gates a path-qualified plant", async () => {
    assert.equal((await analyzeCommand("./ls", inPlantDir)).gated, true);
    assert.equal((await analyzeCommand("./ls -la", inPlantDir)).gated, true);
    assert.equal((await analyzeCommand(`${plantDir}/ls`, inPlantDir)).gated, true);
  });

  test("gates the one otherwise-exempt mise tool when it is a plant", async () => {
    assert.equal((await analyzeCommand(`${plantDir}/nono why`, inPlantDir)).gated, true);
  });

  test("explains that the file sits in agent-writable space", async () => {
    assert.match(
      (await analyzeCommand("./ls", inPlantDir)).reasons[0],
      /inside an agent-writable directory/,
    );
  });

  test("gates a benign wrapper that is itself a plant", async () => {
    // `timeout` runs before `ls` does, so the wrapper is an executable too.
    assert.equal((await analyzeCommand(`${plantDir}/timeout 5 ls`, inPlantDir)).gated, true);
  });

  test("resolves quoted forms exactly like their bare equivalents", async () => {
    assert.equal((await analyzeCommand("'./ls'", inPlantDir)).gated, true);
    assert.equal((await analyzeCommand("'ls' -la", inPlantDir)).gated, false);
  });
});

describe("PATH search order", () => {
  test("lets an early plant shadow the system binary below it", async () => {
    assert.equal(
      (await analyzeCommand("ls -la", { cwd: plantDir, path: `${plantDir}:${systemPath}` })).gated,
      true,
    );
  });

  test("treats an empty PATH entry as cwd, which is agent-writable", async () => {
    assert.equal(
      (await analyzeCommand("ls -la", { cwd: plantDir, path: `:${systemPath}` })).gated,
      true,
    );
  });

  test("resolves a relative PATH entry against cwd", async () => {
    assert.equal(
      (await analyzeCommand("ls -la", { cwd: plantDir, path: `.:${systemPath}` })).gated,
      true,
    );
  });

  test("skips a non-executable plant, like bash's search does", async () => {
    writeFileSync(join(plantDir, "wc"), "#!/bin/sh\necho pwned\n"); // no +x
    assert.equal(
      (await analyzeCommand("wc -l f", { cwd: plantDir, path: `${plantDir}:${systemPath}` })).gated,
      false,
    );
  });
});

describe("exec-environment assignments", () => {
  test("gates statements that redirect execution or set an output file", async () => {
    // Resolution cannot vouch for a command whose lookup or loader is
    // redirected, and a log-file setting gives a read-only command a write.
    for (const command of [
      "PATH=/tmp/evil ls",
      "PATH=/tmp/evil:$PATH ls -la",
      "PATH=. ls",
      "PATH=/tmp/evil; ls",
      "export PATH=/tmp/evil",
      "DYLD_INSERT_LIBRARIES=/tmp/x.dylib ls",
      "DYLD_LIBRARY_PATH=/tmp ls",
      "LD_PRELOAD=/tmp/x.so cat f",
      "BASH_ENV=/tmp/x.sh grep p f",
      "IFS=x wc -l f",
      "NONO_LOG_FILE=/tmp/nono.log nono why --self",
    ]) {
      assert.equal(
        (await analyzeCommand(command, inPlantDir)).gated,
        true,
        `expected gate: ${command}`,
      );
    }
  });

  test("names the offending variable", async () => {
    assert.match(
      (await analyzeCommand("PATH=/tmp/evil ls", inPlantDir)).reasons[0],
      /assigns `PATH`/,
    );
  });

  test("lets a harmless assignment through", async () => {
    assert.equal((await analyzeCommand("FOO=bar ls", inPlantDir)).gated, false);
  });
});

describe("commands with no usable PATH", () => {
  const noPath = { cwd: "", path: "" };

  test("passes shell builtins, which need no lookup", async () => {
    assert.equal((await analyzeCommand("test -f x", { ...noPath, cwd: plantDir })).gated, false);
    assert.equal((await analyzeCommand("pwd", { ...noPath, cwd: plantDir })).gated, false);
    assert.equal((await analyzeCommand("true", { ...noPath, cwd: plantDir })).gated, false);
  });

  test("gates an external that cannot be found, and says so", async () => {
    const result = await analyzeCommand("cat f", { ...noPath, cwd: plantDir });
    assert.equal(result.gated, true);
    assert.match(result.reasons[0], /not found in PATH/);
  });
});

describe("trust is by location", () => {
  test("gates a system binary that sits outside every configured root", async () => {
    const narrow = { cwd: plantDir, path: systemPath, config: { miseTools: [], roots: [] } };
    const result = await analyzeCommand("ls -la", narrow);
    assert.equal(result.gated, true);
    assert.match(result.reasons[0], /outside every trusted bin root/);
  });
});

describe("a trusted location is not a free action", () => {
  test("still gates non-allowlisted names that are findable and trusted", async (t) => {
    // The tools PATH must carry gh/node/python so approved commands can run —
    // that must never turn `gh pr create` or `node -e '…'` into a free action.
    for (const command of ["rg -n foo", "gh pr create --title x", "node -e 'process.exit(0)'"]) {
      const result = await analyzeCommand(command, { cwd: plantDir });
      if (result.warnings.length > 0) {
        t.skip("`mise which` unavailable");
        return;
      }
      assert.equal(result.gated, true, `expected gate: ${command}`);
      assert.match(result.reasons[0], /not in the safe command allowlist/);
    }
  });

  test("exempts static nono why queries only from a trusted location", async (t) => {
    const options = { cwd: plantDir };
    const probe = await analyzeCommand("nono why --self", options);
    if (probe.warnings.length > 0) {
      t.skip("`mise which nono` unavailable");
      return;
    }
    assert.equal(probe.gated, false);
    assert.equal(
      (
        await analyzeCommand(
          "nono why --json --profile pi-tools --allow /tmp --path /tmp --op read",
          options,
        )
      ).gated,
      false,
    );
    for (const command of [
      "nono why --log-file /tmp/nono.log",
      "nono why --log-file=/tmp/nono.log",
      'nono why "--log-file=/tmp/nono.log"',
      'nono why "$query"',
      "NONO_LOG_FILE=/tmp/nono.log nono why --self",
    ]) {
      assert.equal(
        (await analyzeCommand(command, options)).gated,
        true,
        `expected gate: ${command}`,
      );
    }
    // Bin trust decides where nono may live, never whether it is free to run.
    assert.equal((await analyzeCommand("nono run --profile x -- rm -rf /", options)).gated, true);
    assert.equal((await analyzeCommand(`${plantDir}/nono why`, inPlantDir)).gated, true);
  });
});

describe("warnings", () => {
  test("reports an unresolvable mise tool alongside the gate", async () => {
    const result = await analyzeCommand("definitely-not-a-real-tool", {
      cwd: plantDir,
      config: { miseTools: ["definitely-not-a-real-tool"], roots: ["/usr/bin", "/bin"] },
    });
    assert.equal(result.gated, true);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /mise which definitely-not-a-real-tool` failed/);
  });
});
