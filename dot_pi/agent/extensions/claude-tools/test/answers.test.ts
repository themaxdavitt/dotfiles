/**
 * AskUserQuestion's data model.
 *
 * The TUI itself cannot be tested outside Pi, so everything that can be moved
 * behind a pure function has been, and is asserted here. What remains untested
 * is keyboard handling and rendering — those need a manual pass.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  type AnswerState,
  MAX_HEADER_LENGTH,
  buildAnswers,
  formatAnswerSummary,
  isAnswered,
  normalizeQuestions,
  otherIndex,
} from "../src/answers";

function emptyState(): AnswerState {
  return { selected: new Map(), customText: new Map(), notes: new Map() };
}

const twoOptions = [
  { label: "Yes", description: "do it" },
  { label: "No", description: "skip it" },
];

describe("normalizeQuestions", () => {
  test("reads a well-formed question", () => {
    const [q] = normalizeQuestions({
      questions: [{ header: "Auth", question: "Which flow?", options: twoOptions }],
    });
    assert.equal(q.header, "Auth");
    assert.equal(q.question, "Which flow?");
    assert.equal(q.multiSelect, false);
    assert.equal(q.options.length, 2);
  });

  test("truncates an overlong header to the tab chip's width", () => {
    const [q] = normalizeQuestions({
      questions: [{ header: "a".repeat(40), question: "?", options: twoOptions }],
    });
    assert.equal(q.header.length, MAX_HEADER_LENGTH);
  });

  test("names an unlabeled question rather than rendering a blank chip", () => {
    const [q] = normalizeQuestions({ questions: [{ question: "?", options: twoOptions }] });
    assert.equal(q.header, "Question");
  });

  test("treats only an explicit true as multi-select", () => {
    const parse = (multiSelect: unknown) =>
      normalizeQuestions({
        questions: [{ header: "h", question: "?", options: twoOptions, multiSelect }],
      })[0].multiSelect;
    assert.equal(parse(true), true);
    assert.equal(parse(false), false);
    assert.equal(parse(undefined), false);
    assert.equal(parse("yes"), false);
  });

  test("survives missing or malformed options instead of throwing at render time", () => {
    const [q] = normalizeQuestions({ questions: [{ header: "h", question: "?" }] });
    assert.deepEqual(q.options, []);
    const [q2] = normalizeQuestions({
      questions: [{ header: "h", question: "?", options: [null] }],
    });
    assert.deepEqual(q2.options, [{ label: "", description: "" }]);
  });

  test("keeps a preview only when it is really a string", () => {
    const [q] = normalizeQuestions({
      questions: [
        {
          header: "h",
          question: "?",
          options: [
            { label: "a", description: "d", preview: "code" },
            { label: "b", description: "d", preview: 42 },
          ],
        },
      ],
    });
    assert.equal(q.options[0].preview, "code");
    assert.equal("preview" in q.options[1], false);
  });

  test("returns nothing for a missing or non-array questions field", () => {
    assert.deepEqual(normalizeQuestions({}), []);
    assert.deepEqual(normalizeQuestions({ questions: "nope" }), []);
    assert.deepEqual(normalizeQuestions(undefined), []);
  });
});

describe("otherIndex", () => {
  test('puts "Other" one past the real options', () => {
    assert.equal(
      otherIndex({ header: "h", question: "?", multiSelect: false, options: twoOptions }),
      2,
    );
  });
});

describe("isAnswered", () => {
  test("counts a selected option", () => {
    const state = emptyState();
    state.selected.set(0, new Set([1]));
    assert.equal(isAnswered(state, 0), true);
  });

  test("counts free text", () => {
    const state = emptyState();
    state.customText.set(0, "something else");
    assert.equal(isAnswered(state, 0), true);
  });

  test("does not count whitespace or a bare note", () => {
    const state = emptyState();
    state.customText.set(0, "   ");
    state.notes.set(0, "a thought");
    // A note is supplementary — it must not stand in for an answer.
    assert.equal(isAnswered(state, 0), false);
  });

  test("is false for an untouched question", () => {
    assert.equal(isAnswered(emptyState(), 0), false);
  });
});

describe("buildAnswers", () => {
  const questions = normalizeQuestions({
    questions: [
      {
        header: "Auth",
        question: "Which flow?",
        multiSelect: true,
        options: [
          { label: "OAuth", description: "" },
          { label: "JWT", description: "" },
          { label: "Session", description: "" },
        ],
      },
    ],
  });

  test("reports selections in presentation order, not click order", () => {
    const state = emptyState();
    state.selected.set(0, new Set([2, 0]));
    assert.deepEqual(buildAnswers(questions, state)[0].selected, ["OAuth", "Session"]);
  });

  test("appends free text after the picked options and flags it", () => {
    const state = emptyState();
    state.selected.set(0, new Set([0]));
    state.customText.set(0, "  Passkeys  ");
    const [answer] = buildAnswers(questions, state);
    assert.deepEqual(answer.selected, ["OAuth", "Passkeys"]);
    assert.equal(answer.wasCustom, true);
  });

  test("carries a trimmed note, and omits an empty one", () => {
    const state = emptyState();
    state.notes.set(0, "  prefer the simplest  ");
    assert.equal(buildAnswers(questions, state)[0].note, "prefer the simplest");
    state.notes.set(0, "   ");
    assert.equal(buildAnswers(questions, state)[0].note, undefined);
  });

  test("returns an empty selection rather than failing for an unanswered question", () => {
    const [answer] = buildAnswers(questions, emptyState());
    assert.deepEqual(answer.selected, []);
    assert.equal(answer.wasCustom, false);
  });

  test("ignores a selection index with no matching option", () => {
    const state = emptyState();
    state.selected.set(0, new Set([99]));
    assert.deepEqual(buildAnswers(questions, state)[0].selected, []);
  });

  test("keeps the question text so the model can see what was answered", () => {
    assert.equal(buildAnswers(questions, emptyState())[0].question, "Which flow?");
  });
});

describe("formatAnswerSummary", () => {
  test("renders one line per question", () => {
    const summary = formatAnswerSummary([
      { header: "Auth", question: "?", selected: ["OAuth"], wasCustom: false },
      { header: "DB", question: "?", selected: ["Postgres", "Redis"], wasCustom: false },
    ]);
    assert.equal(summary, "Auth: OAuth\nDB: Postgres, Redis");
  });

  test("indents a note under its answer", () => {
    const summary = formatAnswerSummary([
      {
        header: "Auth",
        question: "?",
        selected: ["OAuth"],
        wasCustom: false,
        note: "keep it simple",
      },
    ]);
    assert.equal(summary, "Auth: OAuth\n  note: keep it simple");
  });

  test("says so explicitly when a question went unanswered", () => {
    // An empty string here would read as an answer the model could invent.
    assert.equal(
      formatAnswerSummary([{ header: "Auth", question: "?", selected: [], wasCustom: false }]),
      "Auth: (no selection)",
    );
  });
});
