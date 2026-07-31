---
id: description-not-procedure
title: Keep process steps out of skill descriptions
severity: error
scope:
  - skill-definition
# Evidence: observed routing failure mode — when a description enumerates the
# skill's process ("exports assets, generates specs, creates tasks"), models
# sometimes execute those steps directly from the description and never load
# the skill body, skipping every directive and safeguard that lives there.
why: >-
  The description is a router, not a summary of the procedure. A description that
  reads as a step list invites the model to follow it verbatim instead of loading
  the skill, so the body's directives silently never apply. Descriptions should
  say when to invoke the skill — triggers, inputs, verbs the user would use —
  and leave what the skill does to the body.
tests:
  - bad: "Exports assets, generates specs, and creates implementation tasks for a design handoff."
    good: "Use when asked to hand off a design for implementation; triggers on: Figma link, design spec, asset export."
  - bad: "Reruns the failing test, bisects the history, and reports the offending commit."
    good: "Use when a test failure needs root-causing; triggers on: flaky test, regression, CI failure, git bisect."
  - bad: "Reads the changelog, bumps the version pin, and regenerates the lockfile."
    good: "Use when asked to add, bump, pin, or remove a tool, runtime, or script dependency."
---

Flag descriptions that enumerate the skill's internal workflow — chained verb phrases that read as an ordered recipe of what the skill will do ("exports X, generates Y, creates Z"). Naming the skill's domain, outcome, or trigger conditions is fine; describing the procedure step by step is not, because a model can follow those steps straight from the description without ever loading the body. Judge whether an agent seeing only the description could mistake it for the instructions themselves.
