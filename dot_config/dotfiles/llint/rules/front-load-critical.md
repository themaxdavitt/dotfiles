---
id: front-load-critical
title: Front-load the most critical directives
severity: warning
scope:
  - agent-guidance
# Evidence: Long-context instruction following shows primacy and recency effects with a
# performance trough in the middle ("lost in the middle", Liu et al. 2023). Critical
# directives buried mid-file are more frequently missed than those near the top or bottom.
# Safe to restate the single most critical directive at the end of a long doc.
why: >-
  Critical directives buried in the middle of a long guidance file are the most
  likely to be missed or down-weighted. Primacy bias means the first 10–15 lines
  receive the most attention; place the most violated or highest-stakes rule there.
tests:
  - bad: |
      # Agent Guidance

      ALWAYS: use the local style.
      ALWAYS: prefer small commits.
      ALWAYS: keep messages concise.
      ALWAYS: check imports after edits.
      ALWAYS: do not change unrelated files — ask the user first.
      ALWAYS: use existing helpers from `lib/`.
      ALWAYS: preserve public APIs unless explicitly told to break them.
      ALWAYS: ask before destructive actions (deleting files, resetting state).
      ALWAYS: avoid speculative rewrites.
      ALWAYS: run tests before claiming a change is complete.
      ALWAYS: get user approval before pushing to a protected branch.
    good: |
      # Agent Guidance

      ALWAYS: run tests before claiming a change is complete — this is the most critical rule.
      ALWAYS: use the local style.
      ALWAYS: prefer small commits.
  - bad: |
      # PR Review Agent

      ALWAYS: check for typos in code comments.
      ALWAYS: verify that all public methods have docstrings.
      ALWAYS: ensure imports are sorted.
      ALWAYS: check for unused variables.
      ALWAYS: look for obvious performance issues.
      ALWAYS: verify error handling is present on all I/O calls.
      ALWAYS: do NOT approve a PR that removes tests without a documented reason.
    good: |
      # PR Review Agent

      ALWAYS: do NOT approve a PR that removes tests without a documented reason.
      ALWAYS: check for typos in code comments.
      ALWAYS: verify error handling is present on all I/O calls.
---

Look for files where the single most important or most safety-critical directive is buried well past the midpoint, while lower-stakes directives occupy the top. Only flag when the mis-ordered directive is clearly more consequential than those above it — do not flag ordinary reordering between similar-priority rules.
