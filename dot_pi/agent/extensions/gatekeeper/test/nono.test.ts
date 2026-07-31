import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import {
  appendNonoDenialGuidance,
  gateFileTool,
  looksLikeNonoDenial,
  pathQueryForTool,
  queryToolsProfile,
} from "../src/sandbox/nono";
import { toolsProfile } from "../src/sandbox/wrap";

let tempDir: string;

before(() => {
  tempDir = mkdtempSync(join(tmpdir(), "gatekeeper-nono-"));
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("pathQueryForTool", () => {
  test("maps each file tool to the access it implies", () => {
    assert.deepEqual(pathQueryForTool({ toolName: "read", input: { path: "/a" } } as never), {
      path: "/a",
      op: "read",
    });
    assert.deepEqual(pathQueryForTool({ toolName: "write", input: { path: "/a" } } as never), {
      path: "/a",
      op: "write",
    });
    assert.deepEqual(pathQueryForTool({ toolName: "edit", input: { path: "/a" } } as never), {
      path: "/a",
      op: "readwrite",
    });
  });

  test("ignores tools with no file path", () => {
    assert.equal(
      pathQueryForTool({ toolName: "bash", input: { command: "ls" } } as never),
      undefined,
    );
    assert.equal(pathQueryForTool({ toolName: "read", input: {} } as never), undefined);
    assert.equal(pathQueryForTool({ toolName: "read", input: { path: "" } } as never), undefined);
  });
});

describe("gateFileTool", () => {
  test("lets non-file tools through untouched", async () => {
    assert.equal(
      await gateFileTool({ toolName: "bash", input: { command: "ls" } }, tempDir),
      undefined,
    );
  });

  // Live probes against the chezmoi-SOURCE profile file: `nono run`/`why`
  // accept profile paths as well as names, so this needs no deploy.
  describe("against the real pi-tools profile", () => {
    const profilePath = fileURLToPath(
      new URL("../../../../../dot_config/nono/profiles/pi-tools.jsonc", import.meta.url),
    );

    test("allows a write inside the workdir and denies a read of a private key", async (t) => {
      process.env.GATEKEEPER_NONO_PROFILE = profilePath;
      try {
        assert.equal(toolsProfile(), profilePath);
        const probe = await queryToolsProfile(join(tempDir, "probe.txt"), "write", tempDir);
        if (!probe) {
          t.skip("nono unavailable — see the fail-closed test below");
          return;
        }
        assert.equal(probe.status, "allowed");
        assert.equal(
          await gateFileTool(
            { toolName: "write", input: { path: join(tempDir, "x.txt") } },
            tempDir,
          ),
          undefined,
        );

        const denied = await gateFileTool(
          { toolName: "read", input: { path: join(homedir(), ".ssh/id_ed25519") } },
          tempDir,
        );
        assert.equal(denied?.op, "read");
        assert.equal(denied?.path, join(homedir(), ".ssh/id_ed25519"));
        assert.ok(denied?.detail && !denied.detail.includes("query failed"));
        assert.match(denied?.blockReason ?? "", /denies read/);
        assert.match(denied?.blockReason ?? "", /nono sandbox diagnostic/);
      } finally {
        delete process.env.GATEKEEPER_NONO_PROFILE;
      }
    });

    test("fails closed when the profile query cannot answer", async () => {
      // A profile path that cannot resolve stands in for a broken nono install.
      process.env.GATEKEEPER_NONO_PROFILE = join(tempDir, "no-such-profile.jsonc");
      try {
        const fallback = await gateFileTool(
          { toolName: "write", input: { path: join(tempDir, "x.txt") } },
          tempDir,
        );
        assert.equal(fallback?.detail, "profile query failed");
        assert.match(fallback?.blockReason ?? "", /could not verify/);
      } finally {
        delete process.env.GATEKEEPER_NONO_PROFILE;
      }
    });

    test("resolves a relative path against the session cwd", async () => {
      process.env.GATEKEEPER_NONO_PROFILE = join(tempDir, "no-such-profile.jsonc");
      try {
        const denial = await gateFileTool(
          { toolName: "read", input: { path: "notes.md" } },
          tempDir,
        );
        assert.equal(denial?.path, join(tempDir, "notes.md"));
      } finally {
        delete process.env.GATEKEEPER_NONO_PROFILE;
      }
    });
  });
});

const denialEvent = {
  type: "tool_result",
  toolCallId: "t1",
  toolName: "bash",
  input: { command: "cat secret.txt" },
  content: [{ type: "text", text: "cat: secret.txt: Operation not permitted" }],
  details: {},
  isError: true,
};

describe("looksLikeNonoDenial", () => {
  test("recognizes a sandbox denial in an errored result", () => {
    assert.equal(looksLikeNonoDenial(denialEvent as never), true);
  });

  test("ignores the same text on a successful result", () => {
    assert.equal(looksLikeNonoDenial({ ...denialEvent, isError: false } as never), false);
  });

  test("recognizes the other denial spellings", () => {
    for (const text of [
      "bash: /etc/shadow: Permission denied",
      "EACCES: permission denied",
      "sandbox: deny file-read-data",
    ]) {
      assert.equal(
        looksLikeNonoDenial({ ...denialEvent, content: [{ type: "text", text }] } as never),
        true,
        text,
      );
    }
  });

  test("leaves ordinary failures alone", () => {
    assert.equal(
      looksLikeNonoDenial({
        ...denialEvent,
        content: [{ type: "text", text: "cat: nope.txt: No such file or directory" }],
      } as never),
      false,
    );
  });
});

describe("appendNonoDenialGuidance", () => {
  test("appends the diagnostic to a denial", () => {
    const patch = appendNonoDenialGuidance(denialEvent as never);
    assert.ok(patch?.content);
    const text = patch.content.map((item) => ("text" in item ? item.text : "")).join("\n");
    assert.match(text, /nono why --self/);
    assert.match(text, /elevated_bash/);
    // The guidance names sudo only to forbid it — kernel enforcement cannot be
    // escalated around, and suggesting it sends the model down a dead end.
    assert.match(text, /Do not suggest sudo/);
    // The original content survives ahead of the guidance.
    assert.match(text, /Operation not permitted/);
  });

  test("returns no patch for a non-denial", () => {
    assert.equal(appendNonoDenialGuidance({ ...denialEvent, isError: false } as never), undefined);
  });
});
