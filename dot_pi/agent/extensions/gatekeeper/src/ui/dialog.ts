import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { type ConsentResult, buildToolSummary } from "./summary";

export { type ConsentResult, buildToolSummary };

function makeEditorTheme(theme: ExtensionContext["ui"]["theme"]): EditorTheme {
  return {
    borderColor: (s) => theme.fg("accent", s),
    selectList: {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    },
  };
}

const MAX_DIFF_LINES = 14;

function getSummaryLineColor(toolName: string, line: string, lineIndex: number): string {
  if (line.startsWith("+ ")) return "toolDiffAdded";
  if (line.startsWith("- ")) return "toolDiffRemoved";
  if (line.startsWith("── ")) return "muted";
  if (lineIndex === 0) return "muted";
  return toolName === "edit" ? "muted" : "text";
}

export async function showGatekeeperDialog(
  ctx: ExtensionContext,
  toolName: string,
  input: Record<string, unknown>,
  detectionReasons?: string[],
): Promise<ConsentResult> {
  return ctx.ui.custom<ConsentResult>((tui, theme, _kb, done) => {
    // ── State ──
    let focus: "diff" | "options" = "diff";
    let selected = 0; // 0=Yes, 1=No
    const options = ["Yes", "No"];
    let diffScrollOffset = 0;
    let editorOpen = false;
    let editorForOption = 0; // which option the editor is open for
    let cachedLines: string[] | undefined;

    // Parse summary into lines
    const summaryLines = buildToolSummary(toolName, input).split("\n");
    const maxDiffScroll = Math.max(0, summaryLines.length - MAX_DIFF_LINES);

    function clampScroll() {
      diffScrollOffset = Math.max(0, Math.min(diffScrollOffset, maxDiffScroll));
    }

    // Editor for attaching a message
    const editor = new Editor(tui, makeEditorTheme(theme));

    editor.onSubmit = (value) => {
      const msg = value.trim() || undefined;
      if (editorForOption === 0) {
        done({ allowed: true, message: msg });
      } else {
        done({ allowed: false, message: msg });
      }
    };

    function refresh() {
      cachedLines = undefined;
      tui.requestRender();
    }

    function handleInput(data: string) {
      // ── Editor mode takes priority ──
      if (editorOpen) {
        if (matchesKey(data, Key.escape)) {
          editorOpen = false;
          editor.setText("");
          refresh();
          return;
        }
        editor.handleInput(data);
        refresh();
        return;
      }

      // ── Quick keys (always work) ──
      if (data === "y" || data === "Y") {
        done({ allowed: true });
        return;
      }
      if (data === "n" || data === "N") {
        done({ allowed: false });
        return;
      }

      // ── Tab — toggle focus between diff and options ──
      if (matchesKey(data, Key.tab)) {
        focus = focus === "diff" ? "options" : "diff";
        refresh();
        return;
      }

      // ── Focus-dependent input ──
      if (focus === "diff") {
        // Scroll the diff preview
        if (matchesKey(data, Key.up)) {
          if (diffScrollOffset > 0) {
            diffScrollOffset--;
            refresh();
          }
          return;
        }
        if (matchesKey(data, Key.down)) {
          if (diffScrollOffset < maxDiffScroll) {
            diffScrollOffset++;
            refresh();
          }
          return;
        }
        if (matchesKey(data, Key.home)) {
          if (diffScrollOffset > 0) {
            diffScrollOffset = 0;
            refresh();
          }
          return;
        }
        if (matchesKey(data, Key.end)) {
          if (diffScrollOffset < maxDiffScroll) {
            diffScrollOffset = maxDiffScroll;
            refresh();
          }
          return;
        }
        // Ctrl+D / Ctrl+U: page down / page up
        if (matchesKey(data, Key.ctrl("d"))) {
          const page = Math.max(1, Math.floor(MAX_DIFF_LINES / 2));
          diffScrollOffset = Math.min(maxDiffScroll, diffScrollOffset + page);
          refresh();
          return;
        }
        if (matchesKey(data, Key.ctrl("u"))) {
          const page = Math.max(1, Math.floor(MAX_DIFF_LINES / 2));
          diffScrollOffset = Math.max(0, diffScrollOffset - page);
          refresh();
          return;
        }
      } else {
        // Focus on options — navigate
        if (matchesKey(data, Key.up) || matchesKey(data, Key.left)) {
          selected = (selected - 1 + options.length) % options.length;
          refresh();
          return;
        }
        if (matchesKey(data, Key.down) || matchesKey(data, Key.right)) {
          selected = (selected + 1) % options.length;
          refresh();
          return;
        }
      }

      // ── Enter — open editor on Yes/No ──
      if (matchesKey(data, Key.enter)) {
        editorOpen = true;
        editorForOption = selected;
        editor.setText("");
        refresh();
        return;
      }

      // ── Escape — decline ──
      if (matchesKey(data, Key.escape)) {
        done({ allowed: false });
        return;
      }
    }

    function render(width: number): string[] {
      if (cachedLines) return cachedLines;

      const lines: string[] = [];
      const border = theme.fg("accent", "─".repeat(width));

      lines.push(border);

      // ── Title ──
      const toolLabel = toolName.charAt(0).toUpperCase() + toolName.slice(1);
      const focusHint = focus === "diff" ? theme.fg("dim", " [scroll]") : "";
      lines.push(
        truncateToWidth(
          ` ${theme.fg("text", theme.bold(`Allow ${toolLabel}?`))}${focusHint}`,
          width,
        ),
      );
      lines.push("");

      // ── Diff preview (scrollable) ──
      clampScroll();
      const visibleEnd = Math.min(diffScrollOffset + MAX_DIFF_LINES, summaryLines.length);

      // Scroll indicator at top (if scrolled down)
      if (diffScrollOffset > 0) {
        lines.push(
          truncateToWidth(`  ${theme.fg("dim", `▲ ${diffScrollOffset} more lines above`)}`, width),
        );
      }

      for (let i = diffScrollOffset; i < visibleEnd; i++) {
        const sl = summaryLines[i];
        const color = getSummaryLineColor(toolName, sl, i);
        lines.push(truncateToWidth(`  ${theme.fg(color as any, sl)}`, width));
      }

      // Scroll indicator at bottom (if more below)
      if (diffScrollOffset < maxDiffScroll) {
        const remaining = summaryLines.length - visibleEnd;
        lines.push(
          truncateToWidth(`  ${theme.fg("dim", `▼ ${remaining} more lines below`)}`, width),
        );
      }

      // ── Detection reasons ──
      if (detectionReasons && detectionReasons.length > 0) {
        lines.push("");
        lines.push(truncateToWidth(`  ${theme.fg("warning", "Gated because:")}`, width));
        for (const reason of detectionReasons) {
          lines.push(truncateToWidth(`  ${theme.fg("warning", `• ${reason}`)}`, width));
        }
      }

      lines.push("");

      // ── Editor for message attachment ──
      if (editorOpen) {
        const label = editorForOption === 0 ? "Yes" : "No";
        lines.push(truncateToWidth(` ${theme.fg("text", `${label} with message:`)}`, width));
        for (const line of editor.render(width - 2)) {
          lines.push(truncateToWidth(` ${line}`, width));
        }
        lines.push("");
        lines.push(
          truncateToWidth(` ${theme.fg("dim", "Enter to submit · Esc to go back")}`, width),
        );
      } else {
        // ── Option buttons ──
        const parts: string[] = [];
        for (let i = 0; i < options.length; i++) {
          const label = ` ${options[i]} `;
          const isActive = i === selected && focus === "options";
          if (isActive) {
            parts.push(theme.bg("selectedBg", theme.fg("text", label)));
          } else {
            parts.push(theme.fg("dim", label));
          }
        }
        lines.push(truncateToWidth(` ${parts.join("  ")}`, width));

        lines.push("");
        // Dynamic help text based on focus
        const help: string[] = [];
        if (focus === "diff") {
          help.push("↑↓ scroll diff");
          help.push("Home/End jump");
        } else {
          help.push("←→ pick option");
          help.push("Enter add msg");
        }
        help.push("y/n quick-pick");
        help.push("Tab toggle focus");
        lines.push(truncateToWidth(` ${theme.fg("dim", help.join(" · "))}`, width));
      }

      lines.push(border);

      cachedLines = lines;
      return lines;
    }

    return {
      render,
      invalidate: () => {
        cachedLines = undefined;
      },
      handleInput,
    };
  });
}
