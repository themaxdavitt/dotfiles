/**
 * AskUserQuestion's data model, separated from its TUI.
 *
 * No Pi imports here on purpose: `@earendil-works/*` and `typebox` resolve only
 * when the extension runs inside Pi, so anything that needs a test has to live
 * on this side of the line. src/ask-user-question.ts is the rendering half.
 */

export interface QuestionOption {
  label: string;
  description: string;
  /** Rendered beside the options, single-select only, mirroring the native tool. */
  preview?: string;
}

export interface NormalizedQuestion {
  header: string;
  question: string;
  multiSelect: boolean;
  options: QuestionOption[];
}

export interface AnsweredQuestion {
  header: string;
  question: string;
  selected: string[];
  /** True when the user typed a free-text answer rather than picking. */
  wasCustom: boolean;
  /** Free-text "yes-and" the user attached to their selection. */
  note?: string;
}

export interface AskUserQuestionResult {
  answers: AnsweredQuestion[];
  cancelled: boolean;
}

/** Mutable selection state, owned by the TUI and read here. */
export interface AnswerState {
  selected: Map<number, Set<number>>;
  customText: Map<number, string>;
  notes: Map<number, string>;
}

/** The tab chip is a fixed-width slot, so an overlong header would break the
 *  layout rather than merely look bad. */
export const MAX_HEADER_LENGTH = 12;

/** Placeholder recorded when the user submits "Other" with nothing typed, so
 *  the answer stays distinguishable from having skipped the question. */
export const EMPTY_CUSTOM_ANSWER = "(no response)";

export function normalizeQuestions(raw: unknown): NormalizedQuestion[] {
  const questions = (raw as { questions?: unknown } | undefined)?.questions;
  if (!Array.isArray(questions)) return [];
  return questions.map((entry) => {
    const q = (entry ?? {}) as Record<string, unknown>;
    const options = Array.isArray(q.options) ? q.options : [];
    return {
      header: String(q.header || "Question").slice(0, MAX_HEADER_LENGTH),
      question: typeof q.question === "string" ? q.question : "",
      // Only an explicit true enables multi-select; a missing value is single.
      multiSelect: q.multiSelect === true,
      options: options.map((option) => {
        const o = (option ?? {}) as Record<string, unknown>;
        return {
          label: typeof o.label === "string" ? o.label : "",
          description: typeof o.description === "string" ? o.description : "",
          ...(typeof o.preview === "string" ? { preview: o.preview } : {}),
        };
      }),
    };
  });
}

/** "Other" is always the option one past the real ones. */
export function otherIndex(question: NormalizedQuestion): number {
  return question.options.length;
}

export function isAnswered(state: AnswerState, index: number): boolean {
  const chosen = state.selected.get(index)?.size ?? 0;
  return chosen > 0 || (state.customText.get(index)?.trim().length ?? 0) > 0;
}

export function buildAnswers(
  questions: NormalizedQuestion[],
  state: AnswerState,
): AnsweredQuestion[] {
  return questions.map((question, index) => {
    // Sorted so the answer reads in the order the options were presented,
    // not the order the user happened to toggle them.
    const labels = [...(state.selected.get(index) ?? [])]
      .sort((a, b) => a - b)
      .map((option) => question.options[option]?.label)
      .filter((label): label is string => typeof label === "string");
    const custom = state.customText.get(index)?.trim();
    if (custom) labels.push(custom);
    const note = state.notes.get(index)?.trim();
    return {
      header: question.header,
      question: question.question,
      selected: labels,
      wasCustom: !!custom,
      note: note || undefined,
    };
  });
}

export function formatAnswerSummary(answers: AnsweredQuestion[]): string {
  return answers
    .map((answer) => {
      const base = `${answer.header}: ${answer.selected.join(", ") || "(no selection)"}`;
      return answer.note ? `${base}\n  note: ${answer.note}` : base;
    })
    .join("\n");
}
