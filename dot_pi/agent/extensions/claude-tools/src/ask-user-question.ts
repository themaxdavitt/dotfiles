/**
 * AskUserQuestion — a Pi executor for Claude Code's native AskUserQuestion.
 *
 * Vendored 2026-07-29 from ~/Projects/2026-pi-claude-p (src/ask-user-question.ts),
 * which itself adapted Pi's examples/extensions/questionnaire.ts and added
 * multi-select, previews, and notes. Local changes: the data model moved to
 * ./answers.ts so it can be tested outside Pi, and the formatting follows this
 * repo's oxfmt settings. That upstream was never runtime-tested, so the TUI
 * paths here are only as good as the manual pass they have had.
 *
 * The schema mirrors the native contract: 1-4 questions, each with a short
 * header, optional multiSelect, and 2-4 options (label + description + optional
 * preview). A free-text "Other" choice is always offered, and the user can
 * attach a per-question free-text note ("yes-and") to their selection. Options
 * with a `preview` render side-by-side (single-select only, native behavior).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  Text,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  type AnswerState,
  type AskUserQuestionResult,
  EMPTY_CUSTOM_ANSWER,
  buildAnswers,
  formatAnswerSummary,
  isAnswered,
  normalizeQuestions,
  otherIndex,
} from "./answers";

const OptionSchema = Type.Object({
  label: Type.String({ description: "Concise display label (1-5 words)" }),
  description: Type.String({
    description: "What this option means or what happens if chosen",
  }),
  preview: Type.Optional(
    Type.String({ description: "Optional markdown preview (single-select questions only)" }),
  ),
});

const QuestionSchema = Type.Object({
  question: Type.String({ description: "The full question to ask the user" }),
  header: Type.String({ description: "Very short label shown as a chip/tab (max 12 chars)" }),
  multiSelect: Type.Optional(
    Type.Boolean({ description: "Allow selecting multiple options (default false)" }),
  ),
  options: Type.Array(OptionSchema, {
    description: "2-4 mutually exclusive choices",
    minItems: 2,
    maxItems: 4,
  }),
});

const AskUserQuestionParams = Type.Object({
  questions: Type.Array(QuestionSchema, {
    description: "1-4 questions to ask the user",
    minItems: 1,
    maxItems: 4,
  }),
});

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    details: { answers: [], cancelled: true } satisfies AskUserQuestionResult,
  };
}

export function registerAskUserQuestionTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "AskUserQuestion",
    label: "Ask user",
    description:
      "Ask the user one or more questions with predefined options to resolve a decision you " +
      "cannot make from the request, code, or sensible defaults. A free-text option is always available.",
    parameters: AskUserQuestionParams,
    // Sequential: this owns the screen, so it must not race a sibling call.
    executionMode: "sequential",

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (ctx.mode !== "tui") {
        return errorResult(
          "Error: AskUserQuestion requires interactive (TUI) mode; no answer was collected.",
        );
      }
      const questions = normalizeQuestions(params);
      if (questions.length === 0) return errorResult("Error: No questions provided.");

      const isMulti = questions.length > 1;
      const totalTabs = questions.length + 1; // questions + Submit

      const result = await ctx.ui.custom<AskUserQuestionResult>((tui, theme, _kb, done) => {
        let currentTab = 0;
        let optionIndex = 0;
        let inputMode = false;
        let inputQuestion = -1;
        let inputKind: "other" | "note" = "other";
        let cachedLines: string[] | undefined;
        const state: AnswerState = {
          selected: new Map(),
          customText: new Map(),
          notes: new Map(),
        };

        const editorTheme: EditorTheme = {
          borderColor: (s) => theme.fg("accent", s),
          selectList: {
            selectedPrefix: (t) => theme.fg("accent", t),
            selectedText: (t) => theme.fg("accent", t),
            description: (t) => theme.fg("muted", t),
            scrollInfo: (t) => theme.fg("dim", t),
            noMatch: (t) => theme.fg("warning", t),
          },
        };
        const editor = new Editor(tui, editorTheme);

        function refresh() {
          cachedLines = undefined;
          tui.requestRender();
        }

        function selectedSet(q: number): Set<number> {
          let set = state.selected.get(q);
          if (!set) {
            set = new Set();
            state.selected.set(q, set);
          }
          return set;
        }

        const answered = (q: number) => isAnswered(state, q);
        const allAnswered = () => questions.every((_q, i) => answered(i));
        const optionCount = (q: number) => otherIndex(questions[q]) + 1;
        const isOther = (q: number, i: number) => i === otherIndex(questions[q]);

        function submit(cancelled: boolean) {
          done({ answers: buildAnswers(questions, state), cancelled });
        }

        function advance() {
          if (!isMulti) {
            submit(false);
            return;
          }
          currentTab = currentTab < questions.length - 1 ? currentTab + 1 : questions.length;
          optionIndex = 0;
          refresh();
        }

        editor.onSubmit = (value) => {
          if (inputQuestion < 0) return;
          const q = inputQuestion;
          const trimmed = value.trim();

          if (inputKind === "note") {
            if (trimmed) state.notes.set(q, trimmed);
            else state.notes.delete(q);
            inputMode = false;
            inputQuestion = -1;
            inputKind = "other";
            editor.setText("");
            refresh(); // a note is supplementary; don't advance
            return;
          }

          state.customText.set(q, trimmed || EMPTY_CUSTOM_ANSWER);
          inputMode = false;
          inputQuestion = -1;
          editor.setText("");
          if (!questions[q].multiSelect) {
            selectedSet(q).clear(); // single-select: custom replaces any option
            advance();
          } else {
            refresh(); // multi-select: keep toggled options, let the user continue
          }
        };

        function openEditor(q: number, kind: "other" | "note") {
          inputMode = true;
          inputQuestion = q;
          inputKind = kind;
          editor.setText((kind === "note" ? state.notes.get(q) : state.customText.get(q)) ?? "");
          refresh();
        }

        function handleInput(data: string) {
          if (inputMode) {
            if (matchesKey(data, Key.escape)) {
              inputMode = false;
              inputQuestion = -1;
              inputKind = "other";
              editor.setText("");
              refresh();
              return;
            }
            editor.handleInput(data);
            refresh();
            return;
          }

          if (isMulti) {
            if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
              currentTab = (currentTab + 1) % totalTabs;
              optionIndex = 0;
              refresh();
              return;
            }
            if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
              currentTab = (currentTab - 1 + totalTabs) % totalTabs;
              optionIndex = 0;
              refresh();
              return;
            }
          }

          if (currentTab === questions.length) {
            if (matchesKey(data, Key.enter) && allAnswered()) submit(false);
            else if (matchesKey(data, Key.escape)) submit(true);
            return;
          }

          const q = currentTab;
          const count = optionCount(q);

          if (matchesKey(data, Key.up)) {
            optionIndex = Math.max(0, optionIndex - 1);
            refresh();
            return;
          }
          if (matchesKey(data, Key.down)) {
            optionIndex = Math.min(count - 1, optionIndex + 1);
            refresh();
            return;
          }

          if (data === "n") {
            openEditor(q, "note");
            return;
          }

          const onOther = isOther(q, optionIndex);

          if (data === " " && questions[q].multiSelect) {
            if (onOther) {
              openEditor(q, "other");
              return;
            }
            const set = selectedSet(q);
            if (set.has(optionIndex)) set.delete(optionIndex);
            else set.add(optionIndex);
            refresh();
            return;
          }

          if (matchesKey(data, Key.enter)) {
            if (onOther) {
              openEditor(q, "other");
              return;
            }
            if (questions[q].multiSelect) {
              if (answered(q)) advance(); // require at least one choice
              return;
            }
            const set = selectedSet(q);
            set.clear();
            set.add(optionIndex);
            state.customText.delete(q);
            advance();
            return;
          }

          if (matchesKey(data, Key.escape)) submit(true);
        }

        function render(width: number): string[] {
          if (cachedLines) return cachedLines;
          const lines: string[] = [];
          const renderWidth = Math.max(1, width);

          function wrapWithPrefix(out: string[], w: number, prefix: string, text: string) {
            const usable = Math.max(1, w);
            const prefixWidth = visibleWidth(prefix);
            if (prefixWidth >= usable) {
              out.push(...wrapTextWithAnsi(prefix + text, usable));
              return;
            }
            const wrapped = wrapTextWithAnsi(text, usable - prefixWidth);
            const cont = " ".repeat(prefixWidth);
            for (let i = 0; i < wrapped.length; i++) {
              out.push(`${i === 0 ? prefix : cont}${wrapped[i]}`);
            }
          }
          const addWrapped = (prefix: string, text: string) =>
            wrapWithPrefix(lines, renderWidth, prefix, text);

          lines.push(theme.fg("accent", "─".repeat(renderWidth)));

          if (isMulti) {
            const tabs: string[] = ["← "];
            for (let i = 0; i < questions.length; i++) {
              const active = i === currentTab;
              const box = answered(i) ? "■" : "□";
              const text = ` ${box} ${questions[i].header} `;
              tabs.push(
                `${
                  active
                    ? theme.bg("selectedBg", theme.fg("text", text))
                    : theme.fg(answered(i) ? "success" : "muted", text)
                } `,
              );
            }
            const submitText = " ✓ Submit ";
            const onSubmit = currentTab === questions.length;
            tabs.push(
              `${
                onSubmit
                  ? theme.bg("selectedBg", theme.fg("text", submitText))
                  : theme.fg(allAnswered() ? "success" : "dim", submitText)
              } →`,
            );
            addWrapped(" ", tabs.join(""));
            lines.push("");
          }

          function renderOptions(q: number, out: string[], colWidth: number) {
            const opts = questions[q].options;
            const set = selectedSet(q);
            for (let i = 0; i < optionCount(q); i++) {
              const other = isOther(q, i);
              const cursor = i === optionIndex;
              const checked = other ? !!state.customText.get(q)?.trim() : set.has(i);
              const box = questions[q].multiSelect
                ? checked
                  ? "[x] "
                  : "[ ] "
                : checked
                  ? "(•) "
                  : "( ) ";
              const prefix = cursor ? theme.fg("accent", "> ") : "  ";
              const editing = cursor && inputMode && inputKind === "other";
              const label = other
                ? `${box}Type something.${editing ? " ✎" : ""}`
                : `${box}${opts[i].label}`;
              wrapWithPrefix(
                out,
                colWidth,
                prefix,
                theme.fg(cursor || checked ? "accent" : "text", label),
              );
              if (other) {
                const custom = state.customText.get(q)?.trim();
                if (custom) wrapWithPrefix(out, colWidth, "      ", theme.fg("muted", custom));
              } else if (opts[i].description) {
                wrapWithPrefix(out, colWidth, "      ", theme.fg("muted", opts[i].description));
              }
            }
          }

          function renderPreviewLines(text: string, colWidth: number): string[] {
            const out: string[] = [];
            wrapWithPrefix(out, colWidth, "", theme.fg("dim", "Preview"));
            for (const raw of text.split("\n")) {
              if (raw === "") {
                out.push("");
                continue;
              }
              for (const w of wrapTextWithAnsi(raw, Math.max(1, colWidth)))
                out.push(theme.fg("text", w));
            }
            return out;
          }

          if (currentTab === questions.length) {
            addWrapped(" ", theme.fg("accent", theme.bold("Ready to submit")));
            lines.push("");
            for (const answer of buildAnswers(questions, state)) {
              const shown = answer.selected.join(", ") || "—";
              addWrapped(
                " ",
                `${theme.fg("muted", `${answer.header}: `)}${theme.fg("text", shown)}`,
              );
              if (answer.note) {
                addWrapped(
                  "   ",
                  `${theme.fg("accent", "note: ")}${theme.fg("muted", answer.note)}`,
                );
              }
            }
            lines.push("");
            if (allAnswered()) addWrapped(" ", theme.fg("success", "Press Enter to submit"));
            else {
              const missing = questions.filter((_q, i) => !answered(i)).map((q) => q.header);
              addWrapped(" ", theme.fg("warning", `Unanswered: ${missing.join(", ")}`));
            }
          } else {
            const q = currentTab;
            addWrapped(" ", theme.fg("text", questions[q].question));
            lines.push("");

            const focused =
              optionIndex < questions[q].options.length
                ? questions[q].options[optionIndex]
                : undefined;
            // Previews are single-select only, mirroring native AskUserQuestion.
            const previewText = !questions[q].multiSelect ? focused?.preview : undefined;

            if (previewText !== undefined && renderWidth >= 56) {
              const leftWidth = Math.min(48, Math.max(24, Math.floor((renderWidth - 3) * 0.5)));
              const rightWidth = Math.max(12, renderWidth - 3 - leftWidth);
              const leftLines: string[] = [];
              renderOptions(q, leftLines, leftWidth);
              const rightLines = renderPreviewLines(previewText, rightWidth);
              const divider = theme.fg("accent", " │ ");
              for (let i = 0; i < Math.max(leftLines.length, rightLines.length); i++) {
                const l = leftLines[i] ?? "";
                const pad = " ".repeat(Math.max(0, leftWidth - visibleWidth(l)));
                lines.push(`${l}${pad}${divider}${rightLines[i] ?? ""}`);
              }
            } else {
              renderOptions(q, lines, renderWidth);
              if (previewText !== undefined) {
                // Too narrow for a pane: stack the preview below the options.
                lines.push("");
                for (const line of renderPreviewLines(previewText, Math.max(1, renderWidth - 2))) {
                  lines.push(`  ${line}`);
                }
              }
            }

            const note = state.notes.get(q)?.trim();
            if (note && !(inputMode && inputQuestion === q && inputKind === "note")) {
              lines.push("");
              addWrapped("  ", `${theme.fg("accent", "note: ")}${theme.fg("muted", note)}`);
            }

            if (inputMode && inputQuestion === q) {
              lines.push("");
              addWrapped(
                " ",
                theme.fg("muted", inputKind === "note" ? "Your note (yes-and):" : "Your answer:"),
              );
              for (const line of editor.render(Math.max(1, renderWidth - 2)))
                lines.push(` ${line}`);
            }
          }

          lines.push("");
          let help: string;
          if (inputMode) help = "Enter to submit • Esc to go back";
          else if (currentTab === questions.length) help = "Enter to submit • Esc to cancel";
          else {
            const nav = isMulti ? "Tab/←→ questions • ↑↓ options • " : "↑↓ options • ";
            help = questions[currentTab].multiSelect
              ? `${nav}Space toggle • Enter confirm • n note • Esc cancel`
              : `${nav}Enter select • n note • Esc cancel`;
          }
          addWrapped(" ", theme.fg("dim", help));
          lines.push(theme.fg("accent", "─".repeat(renderWidth)));

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

      if (result.cancelled) {
        return {
          content: [{ type: "text", text: "User cancelled the question without answering." }],
          details: result,
        };
      }
      return {
        content: [
          { type: "text", text: `The user answered:\n${formatAnswerSummary(result.answers)}` },
        ],
        details: result,
      };
    },

    renderCall(args, theme) {
      const qs = Array.isArray(args.questions) ? args.questions : [];
      const headers = qs
        .map((q: { header?: string }) => q.header)
        .filter(Boolean)
        .join(", ");
      let text = theme.fg("toolTitle", theme.bold("AskUserQuestion "));
      text += theme.fg("muted", `${qs.length} question${qs.length !== 1 ? "s" : ""}`);
      if (headers) text += theme.fg("dim", ` (${headers})`);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const details = result.details as AskUserQuestionResult | undefined;
      if (!details) {
        const first = result.content[0];
        return new Text(first?.type === "text" ? first.text : "", 0, 0);
      }
      if (details.cancelled) return new Text(theme.fg("warning", "Cancelled"), 0, 0);
      const lines = details.answers.map((a) => {
        let line = `${theme.fg("success", "✓ ")}${theme.fg("accent", a.header)}: ${a.selected.join(", ")}`;
        if (a.note) line += theme.fg("muted", `  (note: ${a.note})`);
        return line;
      });
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}
