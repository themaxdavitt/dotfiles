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
- NEVER: write a directive with no checkable condition — quality adjectives ("properly", "correctly", "good tests") name an intent, not a standard anyone can hold work against; instead state the observable outcome, or the command that settles it.
- NEVER: state a principle without the behavior it implies ("code is a liability", "prefer simplicity"); instead pair it with the concrete action or trigger it produces, because a model generalizes an abstraction from exemplars it may not share with you.
- ALWAYS: open each section with its highest-stakes directive — attention thins further down a file, so the rule whose breach costs most must not sit mid-list.
- NEVER: keep a directive belonging to a neighboring domain, however sensible it reads; instead move it to the document that owns that domain, since an off-topic rule spends budget, can interfere with the task in hand, and erodes trust in the rest of the file.
- NEVER: present obvious solutions, or multiple alternatives without a rule for picking between them; instead give one recommendation plus the criterion for deviating. The same applies to examples: filling the agent's context window with content it can one-shot wastes the budget.
- NEVER: include top-level _context-only_ bullet points, paragraphs, or code snippets; instead attach context sentences to the directive they serve, sequence directives to reduce repetition, push larger or overarching examples to separate reference files, and leave broader ambiguity to end-user-managed guidelines.
- NEVER: keep a directive that a deterministic check already owns and can teach in time; instead delete it and let the check's failure message carry the rule, reserving always-loaded budget for the rules whose breach lands before any check runs. Settle each candidate in this order:
  1. Does a check fail on the violation? If nothing does, keep the directive.
  2. Is the damage undone by editing a file the check named? When it lands anywhere else — a credential to rotate, a prompt already answered, another checkout — keep the directive, because a rule that only reports after the cost is paid has to prevent instead.
  3. Does the failure message state the action rather than only the violation? If not, fix the message first, or move the explanation into a skill that the message names.
- NEVER: duplicate content that a reference link can carry; instead use Markdown reference-style links with definitions at the bottom of the file.
- NEVER: park background in a reference file because it failed to earn a directive; instead fold that context into the directive it serves or drop it, and reserve reference files for genuine references — specs, upstream tool documentation, long templates — since pseudo-actionable prose filed out of sight goes unread and unchecked.
- ALWAYS: land a new directive together with an eval case that exercises it (`evals/<case>/prompt.md` + `grade.sh` beside the guidance), so its value is measurable rather than asserted — a directive with no case is invisible to ablation, which will keep reporting on the text around it.
- ALWAYS: when editing an existing directive, re-read the eval cases covering it and update them in the same change — narrowing or inverting a rule can leave a grader asserting the old behaviour, which then reports the new text as a regression (this is a real 2026-07-25 incident, not a hypothetical: narrowing an "always warn" rule left its case demanding a warning the rule no longer wants).

# Application: project-level `AGENTS.md`/`CLAUDE.md`

- ALWAYS: include a section that establishes a feedback loop, providing commands that let the agent check its work before claiming it's done (e.g., tests, linters, a build, a dry-run, a render/diff). The [adjacent template][agents-tmpl-md] demonstrates what this can look like.
- NEVER: duplicate content from common contributor-facing docs, e.g., `README.md` and `CONTRIBUTING.md`, _outside the section establishing the feedback loop_; instead include a directive to read them before doing anything else, and sprinkle reference links around the file to commonly read usage or API docs. Inside the feedback loop, keep duplication to the minimum needed to establish the loop.

[agents-tmpl-md]: assets/agents-tmpl.md
