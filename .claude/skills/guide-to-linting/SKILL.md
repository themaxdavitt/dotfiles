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
  4. `,llint check` rules (`dot_config/dotfiles/llint/rules/`): semantic residue a judge must model — unverifiable, off-topic, unroutable, persona-as-capability, mis-tiered. Every rule declares the `input:` shape it reads, and one command assembles all of them: `file` (one guidance document), `directive-pair` (two directives from different files, shortlisted by embedding), `coverage` (a target's directives against the eval cases measuring them), `eval-prompt` (a case's `prompt.md`).
  5. `,llint improve`: behavioral ablation — run the consumer model once with and once without the skill text, grade both outputs with the case's `grade.sh`, and compare; that difference (not anyone's opinion) decides redundant/effective/ineffective. `--dry-run` reports without rewriting the file.
- NEVER: write a `,llint` rule for something Vale or `.lints` can express deterministically; instead reserve judge rules for meaning, and prefer false negatives over false positives — noisy lints erode trust in the whole pipeline.
- NEVER: design a `,llint` check that asks a model to introspect on its own reasoning ("would I already know this?"); instead design cross-review, where a separate judge grades an artifact or behavior some other model produced — for redundancy questions, that means comparing graded runs with vs. without the guidance under test.
- ALWAYS: run new or changed lints with representative file arguments before finishing, and report which current repo failures they produce. Expected failures are acceptable when the user said existing files may violate the new rule.
- ALWAYS: when a red `hk` run shows several simultaneous failures, read [troubleshooting][troubleshooting] before chasing any of them — hk kills in-flight steps when one fails, so most `ERROR`/`aborted` lines are phantoms of a single real failure.
- ALWAYS: wire every new check into `hk.pkl` in the same change, using the narrowest trigger globs that cover the rule (`dotfiles-unused-custom-lint` enforces this for `.lints/`). Going the other way — exempting a file an application rewrites for itself, such as `dot_pi/agent/settings.json` — reach for the tool's own ignore mechanism instead of an `exclude` in `hk.pkl`: `.prettierignore` for `oxfmt` (it has no ignore file of its own; `--ignore-path` defaults to `.gitignore` and `.prettierignore`), a path section in `.editorconfig` for the `ec` lane. Those bind editors-on-save and direct CLI runs too, where an hk `exclude` reaches only batches arriving through hk, so formatting the file gets reintroduced by whichever route was left uncovered. Expect one exemption per lane that touches it, and reserve `exclude` for lanes with no ignore file at all. Also, update `.gitattributes` so `git check-attr linguist-generated -- <path>` reports the expected values for every touched path.
- ALWAYS: when adding or tightening a check on guidance, confirm the author is told somewhere what the check now demands — either a guidance file states it, or, for a rule deliberately demoted out of guidance so that the check can own it, the failure message itself carries the remedy. A check whose violation explains nothing fails work nobody was told how to pass, so write that directive in the same change, make the message teach, or drop the check.

# Application: `,llint` lanes

- ALWAYS: raise that `OPENROUTER_API_KEY` is required before running `,llint`, and reach it through the dedicated `llint` `fnox` profile (`fnox exec --profile llint -- …`) rather than a shared key — the judge and ablation lanes are the only high-volume paid consumers here, and a shared key hides which of them burned the month's budget.
- ALWAYS: run `,llint check` through the `llm` hk profile (`mise run check-llm`); results are cached in `~/.cache/llint/cache.db` by content hash, so re-runs on unchanged files are free — but editing a rule's own definition invalidates every vote it cast, so expect a full re-pay after touching one. A run over the whole corpus then sweeps the votes no current rule-and-file pair can reach; a run narrowed by `--rule`, `--shape`, or explicit paths sees only part of the corpus and leaves the cache alone. Reach for the narrowed form while iterating and save the whole-corpus run for landing — each edit re-pays that file against every rule, judge model, and run, which is how one day of guidance authoring reached $53 on 2026-07-25. Check for a run already in flight before editing anything it judges: content is snapshotted up front so an edit cannot corrupt it, but any verdict for a file you touch is keyed to text that no longer exists and dies on arrival.
- NEVER: wire `,llint improve` as a commit gate — it is slow, paid, and rewrites the file; instead run it on demand when authoring or reviewing a skill, per the [maintenance ritual][maintenance].
- ALWAYS: let the hook glob decide *when* a check runs and the check itself decide *what* it reads, rather than splitting that judgment across both — a check whose inputs arrive as `{{ files }}` can only ever see one file at a time, so cross-file defects hide in whichever half was not edited.
- ALWAYS: keep eval graders (`skills/*/evals/*/grade.sh`) simple and executable — `grep`/`ast-grep` first, LLM cross-judge only when grep is insufficient.
- NEVER: let an eval `prompt.md` paraphrase the directive under test or its rationale, or let `grade.sh` accept phrasings guessable without the skill; instead give the prompt only task-giver context (the request plus environment facts, e.g. "tools are managed with `mise`") and grep for house-specific tokens — leaked guidance reaches the without-skill run and zeroes the ablation.
- NEVER: fail a grader on a mere *mention* of an anti-pattern; instead grep for the presence of the desired behavior — guidance-loaded consumers quote the forbidden form to reject it ("never run bare `chezmoi apply`; instead `chezmoi apply ~/bin`"), so a negative match punishes exactly the runs that absorbed the directive.

# Application: maintaining guidance over time

- ALWAYS: after a model or tooling change, re-run each skill's ablation evals (`,llint improve --dry-run <skill-dir>`) and delete guidance every deployed consumer model already follows unaided — [`references/maintenance.md`][maintenance] holds the full ritual.

[maintenance]: references/maintenance.md
[troubleshooting]: references/troubleshooting.md
