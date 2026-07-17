---
id: guidance/verifiable
title: Make directives observable
severity: warning
scope:
  - agent-guidance
# Evidence: Models follow explicit, verifiable constraints more reliably than vague
# quality goals. "Correct" and "proper" give no grounding signal.
# IFEval/IFScale: models follow verifiable, explicitly-stated constraints best.
# Synthesis: personal research notes, out of tree (sub-question 1).
# NOTE: directives whose only flaw is a banned hedge word (should/might/usually) are
# owned by Vale WeakImperative/AmbiguousQualifier — this rule covers the semantic residue:
# directives that sound verifiable but leave the success condition undefined.
why: >-
  Quality adjectives ("properly", "correctly", "well") signal intent but do not
  describe a verification condition. When the agent cannot check compliance, neither
  can the reviewer — making the guidance unactionable for both.
llm:
  reasoning_effort: none
tests:
  - bad: "Handle errors properly."
    good: "Return a typed error value; preserve the original cause; never swallow a non-recoverable error."
  - bad: "Write good tests."
    good: "Each test must have a unique name, set up its own state, and assert one observable outcome."
  # Exemption: if the directive names the observable artifact or command, it is verifiable
  # even if it uses a quality adjective in passing.
  - bad: "Document your changes thoroughly."
    good: "Update the CHANGELOG entry and add a docstring to any new public function."
  # Do NOT flag if the banned hedge word is the only issue (that's Vale's job).
  - bad: |
      ALWAYS: write clean code.
    good: |
      ALWAYS: run `ruff check --fix` before committing; ensure `mypy` exits 0.
  # Exemption: the philosophy paragraph under the H1 is intentionally abstract;
  # quality words there are framing, not directives.
  - bad: |
      # Directives

      - ALWAYS: make every script robust, and handle failures properly.
    good: |
      # Philosophy

      Good tooling makes failure obvious and recovery routine.

      # Directives

      - ALWAYS: trap EXIT and print one `path: reason` line per failure.
---

Flag directives where the success condition is undefined: the directive names a quality goal (good, correct, proper, thorough, clean) but not the artifact, command, or observable state that would prove compliance. Do NOT flag a directive just because it contains a hedge word — that belongs to Vale WeakImperative/AmbiguousQualifier. Do NOT flag the prose philosophy paragraph under the top-level H1 heading — quality language there is intentional framing; only flag directives.
