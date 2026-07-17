---
id: guidance/routable-trigger
title: Make skill triggers concrete and routable
severity: error
scope:
  - skill-definition
# Evidence: Routing accuracy (does the agent invoke the right skill?) depends on the
# overlap between the user's task framing and the skill's description tokens.
# Vague descriptions like "use for documents" have low token overlap with real queries.
# Synthesis: personal research notes, out of tree (sub-question 5:
# routing is model reasoning over descriptions; description quality determines routing).
why: >-
  A skill that a model cannot reliably route to is dead weight. The description field
  is the primary signal used to decide when to load the skill; it must name the
  concrete situations, inputs, file types, and verbs that should activate it.
llm:
  reasoning_effort: low
tests:
  - bad: "Use for documents."
    good: "Use when creating, reading, or editing .docx files; triggers on: Word doc, .docx, letterhead, table of contents, redline."
  - bad: "Helps with code."
    good: "Use when writing, reviewing, or refactoring Python; triggers on: .py files, pytest, ruff, mypy, type hints, pydantic."
  - bad: "For agent work."
    good: "ALWAYS use whenever you are asked to work on AGENTS.md, CLAUDE.md, SKILL.md files, or similar agent guidance documents."
---

Flag descriptions too vague to route on: ones that name a broad category ("documents", "code") without the specific file types, verbs, or trigger phrases that would cause the model to invoke this skill. The description should be matchable against real user task strings.
