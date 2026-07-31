import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_CONFIG } from "../src/config";
import { buildStatusEntries, modeStatus, planStatusText, truncateStatus } from "../src/status";

describe("modeStatus", () => {
  test("colours each mode by how much it can do without a human", () => {
    assert.equal(modeStatus("danger").tone, "error"); // red: gate off
    assert.equal(modeStatus("auto").tone, "warning"); // amber: a model clears
    assert.equal(modeStatus("manual").tone, "muted"); // gray: every call stops
  });

  test("names the active mode", () => {
    assert.match(modeStatus("danger").text, /danger/);
    assert.match(modeStatus("auto").text, /auto/);
  });
});

describe("buildStatusEntries", () => {
  test("reports mode, ask mode, and the active nono profile", () => {
    const entries = buildStatusEntries({ ...DEFAULT_CONFIG, mode: "auto" }, "pi-tools");
    assert.deepEqual(
      entries.map((entry) => entry.key),
      ["gatekeeper", "gatekeeper-ask", "gatekeeper-nono"],
    );
    assert.match(entries[0].text, /auto/);
    assert.match(entries[1].text, /ask headful/);
    assert.match(entries[2].text, /pi-tools/);
  });

  test("shows when prompting is off, since that changes what gating means", () => {
    const entries = buildStatusEntries({ ...DEFAULT_CONFIG, askMode: "never" }, "pi-tools");
    assert.match(entries[1].text, /ask never/);
  });
});

describe("truncateStatus", () => {
  test("leaves short text alone", () => {
    assert.equal(truncateStatus("short"), "short");
  });

  test("clips with an ellipsis at the limit", () => {
    const clipped = truncateStatus("x".repeat(80));
    assert.equal(clipped.length, 54);
    assert.ok(clipped.endsWith("…"));
  });
});

describe("planStatusText", () => {
  test("is empty when there is no plan", () => {
    assert.equal(planStatusText(undefined), "");
    assert.equal(planStatusText(""), "");
  });

  test("keeps plan text for Pi's terminal-width-aware footer clipping", () => {
    assert.equal(planStatusText("fix the auth tests"), "📋 fix the auth tests");
    assert.equal(planStatusText("x".repeat(80)), `📋 ${"x".repeat(80)}`);
    const clipped = planStatusText("x".repeat(160));
    assert.ok(clipped.endsWith("…"));
    assert.equal(clipped.length, 123); // badge plus the 120-character plan cap
  });
});
