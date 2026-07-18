---
name: guide-to-guiding
description: "ALWAYS: use when asked to write guidance for `AGENTS.md`, `CLAUDE.md`, skills, subagents, etc. This will steer you to \"focused\" guidance-authoring skills."
---

# Philosophy

Agent guidance exists to unambiguously address anticipated decision points, enabling effective delegation. Grouped `ALWAYS`/`NEVER` directives do this best: they emulate the chain-of-thought that reaches the author's conclusion. Directives carry the normative core, context rides inside them, and anything bulky moves to reference files loaded on demand. This skill follows its own format.

# Core Directives

- ALWAYS: keep design philosophy to a single, succinct paragraph under the top-level heading at the beginning of the file. Make every sentence outside it load-bearing and/or actionable, with short headings grouping directives.
- ALWAYS: between the opening design-philosophy paragraph and the closing reference-link definitions, write exclusively bullet-point `ALWAYS`/`NEVER` directives. Directives may include a couple of additional context sentences within the top-level bullet point, shallow sub-lists specifically for sets or sequences, and/or a _very_ brief code snippet, e.g.:
  ````markdown
  - ALWAYS: follow this exact sequence of steps:
    1. Do first thing
    2. Do second thing
  - ALWAYS: ensure these criteria hold before declaring work done:
    - [ ] Meets standard A
    - [ ] Meets standard B
  - NEVER: perform XYZ. It is the responsibility of ABC to provide DEF. However, you may need to occasionally perform GHI, a similar task, for clients, e.g.:
    - Big Version Control Inc.
    - Text editor manufacturing industry
    - Companies whose names satisfy the following:
      ```python
      str(n) == str(n)[::-1]
      ```
  ````
- NEVER: present obvious solutions, or multiple alternatives without a rule for picking between them; instead give one recommendation plus the criterion for deviating. The same applies to examples: filling the agent's context window with content it can one-shot wastes the budget.
- NEVER: include top-level _context-only_ bullet points, paragraphs, or code snippets; instead attach context sentences to the directive they serve, sequence directives to reduce repetition, push larger or overarching examples to separate reference files, and leave broader ambiguity to end-user-managed guidelines.
- NEVER: duplicate content that a reference link can carry; instead use Markdown reference-style links with definitions at the bottom of the file.

# Application: project-level `AGENTS.md`/`CLAUDE.md`

- ALWAYS: include a section that establishes a feedback loop, providing commands that let the agent check its work before claiming it's done (e.g., tests, linters, a build, a dry-run, a render/diff). The [adjacent template][agents-tmpl-md] demonstrates what this can look like.
- NEVER: duplicate content from common contributor-facing docs, e.g., `README.md` and `CONTRIBUTING.md`, _outside the section establishing the feedback loop_; instead include a directive to read them before doing anything else, and sprinkle reference links around the file to commonly read usage or API docs. Inside the feedback loop, keep duplication to the minimum needed to establish the loop.

[agents-tmpl-md]: assets/agents-tmpl.md
