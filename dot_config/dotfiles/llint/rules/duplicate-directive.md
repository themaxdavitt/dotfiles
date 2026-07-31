---
id: duplicate-directive
title: State each rule in exactly one guidance file
severity: error
scope:
  - agent-guidance
input: directive-pair
# Evidence: this repo's guidance is loaded in layers — AGENTS.md always, skills on
# demand — so a rule written into both layers pays token rent twice and, worse,
# forks. Measured here: the `alerter` rule lived in AGENTS.md and in
# focus-secret-templates, and a narrowing edit to one left the other saying
# "before any chezmoi rendering subcommand" while the owner said "only when
# secrets are actually requested". Both were live, and they disagreed.
why: >-
  Agent guidance is read in layers, and a rule copied across layers drifts the
  moment one copy is edited — leaving two live, disagreeing versions of the same
  requirement with nothing to say which one governs. One rule, one owner; every
  other file points at the owner instead of restating it.
tests:
  # The same requirement spelled out twice — an agent reading either alone acts
  # identically, so the second copy buys nothing and can drift.
  - bad: |
      Directive A — from AGENTS.md:
      - NEVER: commit a secret; instead have templates pull via `rbwFields` (source of truth: Bitwarden → `bwbio` + the `rbw` shim → `fnox`, age-encrypted).

      Directive B — from skills/focus-secret-templates/SKILL.md:
      - ALWAYS: treat Bitwarden as the source of truth, reached as Bitwarden → `bwbio` + the `rbw` shim → `fnox` (age-encrypted).
    good: |
      Directive A — from AGENTS.md:
      - NEVER: commit a secret or read one into the tree; instead activate the `focus-secret-templates` skill, which owns the vault chain, and have templates pull via `rbwFields`.

      Directive B — from skills/focus-secret-templates/SKILL.md:
      - ALWAYS: treat Bitwarden as the source of truth, reached as Bitwarden → `bwbio` + the `rbw` shim → `fnox` (age-encrypted).
  # Drift is duplication caught late: same rule, two live trigger conditions.
  - bad: |
      Directive A — from AGENTS.md:
      - ALWAYS: alert via `alerter` before a step that will actually request secret values.

      Directive B — from skills/focus-secret-templates/SKILL.md:
      - ALWAYS: alert via `alerter` before any chezmoi rendering subcommand while testing a template.
    good: |
      Directive A — from AGENTS.md:
      - ALWAYS: alert via `alerter` before a step that will actually request secret values — a render whose targets reference `rbwFields`, any `fnox exec`, or `,cza`.

      Directive B — from skills/focus-secret-templates/SKILL.md:
      - ALWAYS: warn via `alerter` before rendering a template that resolves `rbwFields` — `AGENTS.md` owns the pattern and the exact trigger condition.
  # A routing directive that names the owning skill and stops there is the fix,
  # not the defect — do not flag a pointer for resembling what it points at.
  - bad: |
      Directive A — from AGENTS.md:
      - ALWAYS: pin + delay everything — use a backend supporting `minimum_release_age`, keep `paranoid` global, give every tool an explicit version, and never run `mise lock` yourself.

      Directive B — from skills/focus-tool-pinning/SKILL.md:
      - ALWAYS: pin + delay everything: use a backend that supports `minimum_release_age`, keep `paranoid` + `minimum_release_age` global, and give every tool an explicit version.
    good: |
      Directive A — from AGENTS.md:
      - ALWAYS: pin + delay everything (supply chain) — this is the point of the repo. Activate the `focus-tool-pinning` skill for any tool, runtime, or dependency change; the `mise`/`brew`/PEP 723/vendoring rules live there.

      Directive B — from skills/focus-tool-pinning/SKILL.md:
      - ALWAYS: pin + delay everything: use a backend that supports `minimum_release_age`, keep `paranoid` + `minimum_release_age` global, and leave `locked` unset.
  # Shared vocabulary is not a shared rule: these govern different decisions and
  # both must be followed. Flagging either would delete a real requirement.
  - bad: |
      Directive A — from skills/focus-tool-pinning/SKILL.md:
      - ALWAYS: give PEP 723 scripts `exclude-newer = <UTC>` so dependency resolution is pinned and delayed.

      Directive B — from skills/focus-comma-scripts/SKILL.md:
      - ALWAYS: give PEP 723 scripts an `exclude-newer` UTC timestamp under `[tool.uv]` so their dependencies are pinned and delayed.
    good: |
      Directive A — from skills/focus-tool-pinning/SKILL.md:
      - ALWAYS: keep lockfiles for the global config; give every tool an explicit version.

      Directive B — from skills/focus-comma-scripts/SKILL.md:
      - ALWAYS: write Python utilities as PEP 723 `uv run --script` files with `exclude-newer = <UTC timestamp>` under `[tool.uv]`.
---

You are given two directives drawn from different agent-guidance files. Decide whether they state the same rule.

Flag the pair when both directives independently impose the same requirement — when an agent that read only A and an agent that read only B would take the same action, so the second copy adds no instruction the first did not already carry. Flag it just as firmly when the two copies have drifted apart: differing scopes, triggers, or thresholds for one requirement is the failure this rule exists to catch, not evidence that they are separate rules.

Do not flag a pair merely because the wording overlaps. Two things that look alike here but must NOT be flagged. First, a routing directive: one file names the other file (or the skill that owns the detail) and delegates rather than restating the mechanism — that is the correct shape, and a pointer necessarily echoes the vocabulary of what it points at. Second, sibling rules that share a topic while governing different decisions; if following A leaves B's requirement unmet, they are distinct and both must survive.

Judge only redundancy between these two directives. Wording quality, formatting, and whether either directive is a good rule are out of scope.
