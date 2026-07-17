---
id: guidance/abstract-without-anchor
title: Anchor abstract guidance to concrete behavior
severity: suggestion
scope:
  - agent-guidance
# Evidence: In-context generalization from abstract principles is exemplar-bound and scale-dependent.
# High-level priors improve when paired with concrete triggers or examples.
# See: Chan et al. (arXiv 2210.05675, in-context generalization is largely exemplar-based);
# Mueller et al. (arXiv 2311.07811, ICL often relies on non-generalizing heuristics).
# Synthesis: personal research notes, out of tree (sub-question 2).
why: >-
  Abstract principles without concrete anchors rely on the model generalizing
  correctly, which is exemplar-bound. A paired directive or trigger makes the
  intended behavior unambiguous and testable.
llm:
  reasoning_effort: medium
tests:
  - bad: "Remember: code is a liability."
    good: "When refactoring, implement the concrete case first; add an abstraction only after the third real repetition."
  - bad: "Prefer simplicity."
    good: "Prefer a plain function over a class when the class has no state; prefer a class once you need three or more related functions."
  - bad: |
      ALWAYS: write tests.
    good: |
      ALWAYS: write a failing test before touching the implementation; run `npm test` and paste the output before claiming done.
  # Exemption: a philosophy paragraph under H1 is intentionally abstract and should NOT be flagged.
  - bad: "The key insight: more code is more surface area for bugs."
    good: |
      Philosophy: treat each line of code as a liability; the fewer lines to achieve a goal, the better.

      ALWAYS: before adding a helper, verify it is called from at least two distinct call sites.
---

Pair each high-level principle with a concrete directive or trigger. If a principle only applies in a specific situation, suggest moving it to a just-in-time skill rather than keeping it in the always-loaded guidance.

Do NOT flag the single philosophy paragraph under the top-level H1 heading — abstract framing there is intentional.
