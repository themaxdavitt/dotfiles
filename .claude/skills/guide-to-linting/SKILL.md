---
name: guide-to-linting
description: "ALWAYS: use when asked to write or debug any lint or check: mdschema schemas, Vale rules, `.lints/` scripts, `,llint` rules, hk wiring, or eval graders. This will steer you to \"focused\" lint-authoring skills."
---

# Philosophy

Five lanes police this repo, ordered by cost: schema-shaped structure, lexical rules, mechanical scripts, LLM judges, and behavioral ablation. A check belongs in the cheapest lane that owns its signal — determinism before judgment, judgment before measurement. Lint output is a product: one self-explanatory failure line per finding, trustworthy enough that a red result is always worth reading.

# Core Directives

- ALWAYS: route a new check to the cheapest lane that owns the signal, in this priority order:
  1. `mdschema` (`.mdschema-*.yml`): document structure — required/ordered sections, heading hierarchy, frontmatter presence + types; it cannot test frontmatter *values* (lengths, patterns) — those are `.lints/` scripts.
  2. Vale `AgentGuidance` (`.vale/AgentGuidance/`): lexical discipline — banned weak/ambiguous words, negative-directive-without-alternative, directive-token presence.
  3. `.lints/*.sh`: mechanical repo invariants — counts, positions, file shapes, cross-file sync; activate the `focus-dot-lints-folder-script` skill before writing one.
  4. `,llint lint` rules (`dot_config/dotfiles/llint/rules/`): semantic residue a judge must model — unverifiable, off-topic, unroutable, persona-as-capability, mis-tiered.
  5. `,llint eval`: behavioral ablation — run the consumer model once with and once without the skill text, grade both outputs with the case's `grade.sh`, and compare; that difference (not anyone's opinion) decides redundant/effective/ineffective.
- NEVER: write a `,llint` rule for something Vale or `.lints` can express deterministically; instead reserve judge rules for meaning, and prefer false negatives over false positives — noisy lints erode trust in the whole pipeline.
- NEVER: design a `,llint` check that asks a model to introspect on its own reasoning ("would I already know this?"); instead design cross-review, where a separate judge grades an artifact or behavior some other model produced — for redundancy questions, that means comparing graded runs with vs. without the guidance under test.
- ALWAYS: run new or changed lints with representative file arguments before finishing, and report which current repo failures they produce. Expected failures are acceptable when the user said existing files may violate the new rule.
- ALWAYS: when a red `hk` run shows several simultaneous failures, read [troubleshooting][troubleshooting] before chasing any of them — hk kills in-flight steps when one fails, so most `ERROR`/`aborted` lines are phantoms of a single real failure.
- ALWAYS: wire every new check into `hk.pkl` in the same change, using the narrowest trigger globs that cover the rule (`dotfiles-unused-custom-lint` enforces this for `.lints/`).

# Application: `,llint` lanes

- ALWAYS: raise that `OPENROUTER_API_KEY` is required before running `,llint`; store it via `fnox` and export it in the shell profile so `hk` inherits it.
- ALWAYS: run `,llint lint` through the `llm` hk profile (`mise run check-llm`); results are cached in `~/.cache/llint/` by content hash, so re-runs on unchanged files are free.
- NEVER: wire `,llint eval` as a commit gate — it is slow and paid; instead run it on demand when authoring or reviewing a skill, per the [maintenance ritual][maintenance].
- ALWAYS: keep eval graders (`skills/*/evals/*/grade.sh`) simple and executable — `grep`/`ast-grep` first, LLM cross-judge only when grep is insufficient.
- NEVER: let an eval `prompt.md` paraphrase the directive under test or its rationale, or let `grade.sh` accept phrasings guessable without the skill; instead give the prompt only task-giver context (the request plus environment facts, e.g. "tools are managed with `mise`") and grep for house-specific tokens — leaked guidance reaches the without-skill run and zeroes the ablation.
- NEVER: fail a grader on a mere *mention* of an anti-pattern; instead grep for the presence of the desired behavior — guidance-loaded consumers quote the forbidden form to reject it ("never run bare `chezmoi apply`; instead `chezmoi apply ~/bin`"), so a negative match punishes exactly the runs that absorbed the directive.

# Application: maintaining guidance over time

- ALWAYS: after a model or tooling change, re-run each skill's ablation evals (`,llint eval <skill-dir>`) and delete guidance every deployed consumer model already follows unaided — [`references/maintenance.md`][maintenance] holds the full ritual.

[maintenance]: references/maintenance.md
[troubleshooting]: references/troubleshooting.md
