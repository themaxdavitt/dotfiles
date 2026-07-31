/**
 * Status-bar content, as pure data.
 *
 * Kept free of `ctx.ui` so the wording and the mode-to-emphasis mapping can be
 * tested; index.ts does the `setStatus` calls.
 */

import type { GatekeeperConfig, PermissionMode } from "./policy";

/**
 * A theme colour key from Pi's `ThemeColor` set, named rather than hex so the
 * status bar follows whichever theme is loaded. Spelled out here instead of
 * imported because Pi's packages resolve only inside Pi (see AGENTS.md).
 */
export type StatusTone = "error" | "warning" | "success" | "muted" | "dim";

export interface StatusEntry {
  key: string;
  text: string;
  tone: StatusTone;
}

export function truncateStatus(text: string, max = 54): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Colour reads as a risk ladder: red where the gate is off, amber where a model
 * clears calls, gray where every gated call stops for a human.
 */
export function modeStatus(mode: PermissionMode): { text: string; tone: StatusTone } {
  if (mode === "danger") return { text: "⚡ danger", tone: "error" };
  if (mode === "auto") return { text: "🤖 auto", tone: "warning" };
  return { text: "● manual", tone: "muted" };
}

export function buildStatusEntries(config: GatekeeperConfig, nonoProfile: string): StatusEntry[] {
  const mode = modeStatus(config.mode);
  return [
    { key: "gatekeeper", text: mode.text, tone: mode.tone },
    {
      key: "gatekeeper-ask",
      text: config.askMode === "headful" ? "ask headful" : "ask never",
      tone: "dim",
    },
    { key: "gatekeeper-nono", text: `🛡 ${nonoProfile}`, tone: "dim" },
  ];
}

export function planStatusText(summary: string | undefined): string {
  return summary ? `📋 ${truncateStatus(summary)}` : "";
}
