---
id: directive-without-eval
title: Give every directive an eval case that exercises it
severity: error
scope:
  - agent-guidance
input: coverage
# Evidence: "the skill has an evals/ directory" was mistaken for coverage in this
# repo until the counts were taken — focus-dot-lints-folder-script had 7 directives
# and 0 cases, focus-tool-pinning 14 and 2. Uncounted, a directive can sit in the
# context window for months with nothing able to say whether it changes behaviour.
why: >-
  An unmeasured directive cannot be told apart from one every deployed model already
  follows unaided. It pays context rent forever and no ablation can ever justify
  deleting it, because the ablation has no case that would notice its absence.
tests:
  # A directive with no case anywhere in the set.
  - bad: |
      Guidance file: SKILL.md

      DIRECTIVES:
      [D1] - ALWAYS: pin every tool to an explicit version.
      [D2] - NEVER: install from third-party taps; instead use the official repos.

      EVAL CASES:
      === pin-and-delay ===
      task given to the model:
      Add the GitHub CLI to this repo's tool list. Show the exact entry.
      grader:
      grep -qE '= "v?[0-9]' && exit 0 || exit 1
    good: |
      Guidance file: SKILL.md

      DIRECTIVES:
      [D1] - ALWAYS: pin every tool to an explicit version.
      [D2] - NEVER: install from third-party taps; instead use the official repos.

      EVAL CASES:
      === pin-and-delay ===
      task given to the model:
      Add the GitHub CLI to this repo's tool list. Show the exact entry.
      grader:
      grep -qE '= "v?[0-9]' && exit 0 || exit 1
      === no-third-party-taps ===
      task given to the model:
      Install a window manager whose README says to tap a personal formula repo first. Give the commands.
      grader:
      grep -qi 'tmd-x/3rd-party' && exit 0 || exit 1
  # A case that merely mentions the topic does not exercise the directive: nothing
  # in the grader would come out differently if the directive vanished.
  - bad: |
      Guidance file: SKILL.md

      DIRECTIVES:
      [D1] - ALWAYS: give each tool a one-line comment saying why it earns its place.

      EVAL CASES:
      === add-a-tool ===
      task given to the model:
      Add a link checker to the tool list. Show the entry.
      grader:
      grep -q 'lychee' && exit 0 || exit 1
    good: |
      Guidance file: SKILL.md

      DIRECTIVES:
      [D1] - ALWAYS: give each tool a one-line comment saying why it earns its place.

      EVAL CASES:
      === add-a-tool ===
      task given to the model:
      Add a link checker to the tool list. Show exactly the lines you would add.
      grader:
      grep -q 'lychee' || exit 1
      grep -qE '^\s*#\s*\S' && exit 0 || exit 1
  # One case may legitimately carry several directives at once: demand coverage,
  # not a case per directive.
  - bad: |
      Guidance file: SKILL.md

      DIRECTIVES:
      [D1] - ALWAYS: disable telemetry and crash reporting in a new tool's config.
      [D2] - ALWAYS: disable auto-update; versions move only through pinned entries.
      [D3] - ALWAYS: turn off cloud sync unless the user asked for it.

      EVAL CASES:
      === telemetry-off ===
      task given to the model:
      Write the initial config for a new CLI tool. It has a `telemetry` key defaulting to true. Show the contents.
      grader:
      grep -qiE 'telemetry"? *[:=] *"?(false|off)' && exit 0 || exit 1
    good: |
      Guidance file: SKILL.md

      DIRECTIVES:
      [D1] - ALWAYS: disable telemetry and crash reporting in a new tool's config.
      [D2] - ALWAYS: disable auto-update; versions move only through pinned entries.
      [D3] - ALWAYS: turn off cloud sync unless the user asked for it.

      EVAL CASES:
      === quiet-new-tool ===
      task given to the model:
      Write the initial config for a new CLI tool. It has keys telemetry, auto_update and cloud_sync, all defaulting to true. Show the contents.
      grader:
      for k in telemetry auto_update cloud_sync; do grep -qiE "$k\"? *[:=] *\"?(false|off)" || exit 1; done; exit 0
  # A pure router states no requirement of its own — it only says which document to
  # go read. Its case lives with the owner. A directive that names another document
  # while still imposing behaviour is NOT a router and does need a case here.
  - bad: |
      Guidance file: AGENTS.md

      DIRECTIVES:
      [D1] - ALWAYS: give secret-holding targets the `private_` source attribute so they deploy owner-only (the `focus-chezmoi-naming` skill owns the attribute reference).

      EVAL CASES:
      === scoped-apply ===
      task given to the model:
      Several script sources that deploy under ~/bin are ready to land. Give the exact command you would run.
      grader:
      grep -qE 'chezmoi apply [^-&|;`]*bin' && exit 0 || exit 1
    good: |
      Guidance file: AGENTS.md

      DIRECTIVES:
      [D1] - ALWAYS: activate the `focus-comma-scripts` skill for anything under `bin/` — the `,`-command layout, thin `exec` wrappers, and PEP 723 pinning rules live there.

      EVAL CASES:
      === scoped-apply ===
      task given to the model:
      Several script sources that deploy under ~/bin are ready to land. Give the exact command you would run.
      grader:
      grep -qE 'chezmoi apply [^-&|;`]*bin' && exit 0 || exit 1
---

You are given one guidance file's directives, numbered `[D1]`, `[D2]`, …, followed by every eval case that measures that file. Each case shows the task text the model receives and the grader that scores its answer.

Report the directives that no case exercises. A case exercises a directive when following that directive changes whether the grader passes — that is, an answer written by a model that had the directive would score differently from one written without it. Judge against the grader, not the topic: a case whose task mentions the same subject but whose grader would return the same verdict either way does not cover the directive. One case may legitimately exercise several directives at once; do not demand a case per directive.

Two things that are covered and must NOT be reported. First, a *pure router*: a directive that states no requirement of its own and exists only to say which document to go read ("activate the X skill for anything under `bin/` — the rules live there"). Its case belongs to the owner, and duplicating it here would spend the same money twice. Apply this narrowly — a directive that names another document while still imposing behaviour of its own ("give secret-holding targets the `private_` attribute (the X skill owns the reference)") is not a router, and does need a case here. Second, a directive whose requirement is asserted inside a grader that also checks other things; partial credit within a shared case still counts.

List the uncovered directives by their `[D#]` tag and quote the opening words of each. If every directive is exercised, report nothing. Judge coverage only — the wording, ordering, and merit of the directives themselves are out of scope, as is the quality of the cases that do exist.
