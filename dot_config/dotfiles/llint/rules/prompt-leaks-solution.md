---
id: prompt-leaks-solution
title: Keep the answer out of the eval prompt
severity: error
scope:
  - agent-guidance
input: eval-prompt
# Evidence: `,llint improve` measures a directive's value by running the consumer model
# twice — once with the guidance body, once without — and grading both. Anything the
# prompt reveals about the expected answer reaches the WITHOUT run too, which lifts the
# baseline and drives the measured delta toward zero. A leaky prompt does not merely
# weaken the signal; it manufactures a "redundant" verdict, and redundant is the verdict
# that gets guidance deleted.
why: >-
  An eval prompt is the task-giver's request, not a hint sheet. When it paraphrases the
  directive, states its rationale, or names the house-specific token the grader greps
  for, the unguided run can answer from the prompt alone — so the ablation reports the
  guidance as redundant and the directive gets deleted on false evidence.
tests:
  # Paraphrasing the directive under test.
  - bad: "Add the GitHub CLI to this repo's mise.toml. Remember that every tool here is pinned to an explicit version and held back by a release delay."
    good: "Add the GitHub CLI (`gh`) to this repo's `mise.toml` `[tools]` section. Show the exact TOML you would add."
  # Naming the very token the grader searches for.
  - bad: "You edited a secret-bearing template and want to preview it. Should you notify the user with `alerter` first?"
    good: "You have edited `dot_config/private_fnox/private_config.toml.tmpl`, whose values resolve out of the user's Bitwarden vault, and you want to preview the rendered output. What exactly do you do?"
  # Stating the rationale, which is as much a giveaway as the rule.
  - bad: "Relocate this managed source file. Note that chezmoi never deletes files it has stopped managing, so stale copies linger in $HOME."
    good: "A managed source file previously lived at `dot_config/widget/settings.conf`; you have relocated its contents and run a scoped apply, which reported success. Is the task finished?"
  # Environment facts are legitimate context, not leakage — do not flag these.
  - bad: "Write a lint. Put each invariant in its own script, at one abstraction layer."
    good: "This repo enforces invariants with small shell checks under `.lints/`, wired into hook config by glob. Two invariants need enforcing: every direct child of `bin/` must be a symlink, and every tool entry must carry an explicit version. Describe how you would add these checks."
  # Subject matter the deliverable is ABOUT is task input, never the directive under
  # test. Here the tested directive concerns document structure; the SQL conventions are
  # merely what the document discusses. Do not flag.
  - bad: "Write a SKILL.md. Keep philosophy to one paragraph and make everything else ALWAYS/NEVER bullets."
    good: "Write a `SKILL.md` for an agent skill that enforces our team's SQL migration conventions: expand-contract migrations only, no destructive DDL in the same release, and every migration ships with a rollback script."
  # Pressure TOWARD the wrong answer is the point of an ablation, not a leak: it is what
  # the guidance must resist. Only a nudge toward the RIGHT answer is leakage.
  - bad: "Preview the rendered template. Be sure to notify the user before you do."
    good: "Write a SKILL.md for our SQL migration conventions. Include the reasoning behind the conventions, not just the rules. Output only the file contents."
---

Flag eval `prompt.md` files that hand the model its answer. A prompt may state the task and any environment fact a real task-giver would supply (which tools manage the repo, where a file lives, what the user has already done, what is being asked for). It may NOT paraphrase the directive under test, argue its rationale, pose the directive as a yes/no question, or name the house-specific token, command, or attribute that the paired `grade.sh` searches for.

Two things that look like leakage but are not, and must NOT be flagged. First, subject matter the deliverable is *about*: when the tested directive governs how a document is structured, the domain content that document discusses is task input, however detailed. Second, pressure toward the *wrong* answer: a prompt that tempts the model into the behaviour the guidance forbids is doing its job, because resisting that temptation is the effect being measured. Only a nudge toward the expected answer counts.

Judge leakage alone; prompt length, tone, and formatting are out of scope, and a prompt that describes the starting situation in detail is fine.
