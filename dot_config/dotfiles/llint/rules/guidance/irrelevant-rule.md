---
id: guidance/irrelevant-rule
title: Keep guidance scoped to its stated domain
severity: warning
scope:
  - agent-guidance
# Evidence: Plausible-but-irrelevant context degrades reasoning accuracy by consuming
# context budget and introducing interference. See: "lost in the middle" (Liu et al.,
# TACL 2024); GSM-IC/GSM-DC distractor studies; RuleArena (distractive *rules* degrade
# performance while equal-length meaningless padding barely does).
# Synthesis: personal research notes, out of tree (sub-question 4).
why: >-
  Guidance that sounds plausible but belongs to a different domain consumes context
  budget, may interfere with the task at hand, and signals poor curation — eroding
  trust in the guidance as a whole.
llm:
  reasoning_effort: medium
tests:
  - bad: |
      # Rust Service Guidance

      ALWAYS: run `cargo test` before completion.
      ALWAYS: in Slack, react with a thumbs-up before replying in a thread.
    good: |
      # Rust Service Guidance

      ALWAYS: run `cargo test` before completion.
  - bad: |
      # Code Review Assistant

      ALWAYS: write concise commit messages.
      ALWAYS: schedule your 1:1 with your manager weekly.
    good: |
      # Code Review Assistant

      ALWAYS: write concise commit messages.
  # The multi-domain exemption (e.g. a combined onboarding doc) lives in the
  # check text below; it cannot be expressed as a bad/good pair because both
  # sides of an exemption example are non-violations.
---

Flag directives that are plausible and well-formed but belong to a different domain than the file's stated purpose. Suggest moving them to the file, skill, or prompt that owns that situation.

Do NOT flag if the file explicitly spans multiple domains (e.g., a combined onboarding doc, a multi-role guide).
