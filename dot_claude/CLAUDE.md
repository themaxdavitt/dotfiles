# Agent guidelines — user level

This file guides AI agents working with Max in every project; repo-level guidance adds to it and wins conflicts. The core of the collaboration: Max designs by filtering — present concrete options and evidence, he picks. These directives encode the workflow, the decision points, and the standards that make that delegation work.

## Verify

- ALWAYS: show evidence before claiming work is done — run the check that owns the change and report its output; an unverified assertion doesn't count as done. Which checks those are is the repo's to say, so read its guidance rather than assuming a test suite exists.

## Workflow

- ALWAYS: work in phases on nontrivial tasks (skip phases only for single-file changes or literal instructions like "rename X to Y"):
  1. Explore: read the relevant code; present 2–3 approaches with tradeoffs argued *for* each.
  2. Plan: concrete tasks with files, steps, verification commands, and done criteria.
  3. Build: implement; commit atomically per task.
  4. Verify: run the verification commands from the plan.
- ALWAYS: ask design questions at decision points — approach selection, plan approval, real tradeoffs — via the harness's structured question tool when one exists (e.g. AskUserQuestion), and keep asking until told to move on; leave out options that duplicate a built-in free-text "Other".
- NEVER: make design decisions autonomously; instead present the options and let Max filter — autonomy is for implementation details inside an approved design.
- ALWAYS: delegate broad fan-out investigation (many-file searches, unfamiliar-codebase surveys) to read-only subagents when the harness provides them — a summary in the main context beats a raw exploration transcript.
- ALWAYS: commit atomically per task, conventional format `type(scope): description`.
- ALWAYS: after two failures with the same approach, switch to a different strategy instead of retrying variations.
- ALWAYS: record a durable fact about a repo in that repo's own guidance, never in agent-private memory — a private store is invisible to Max's other checkouts, to other agents in the tree, and to the duplicate-detection that guards the guidance itself. Reserve memory for what the repo cannot hold: work in flight, state outside the tree, and cross-project preferences. Read the repo's guidance before recording anything, since a fact already stated there wants a pointer rather than a second copy.

## Judgment

- ALWAYS: treat this section's directives as strong defaults rather than mandates — argue for an exception explicitly instead of silently deviating.
- ALWAYS: distinguish rules from expectations — when a documented requirement blocks the better design, ask Max whether it's negotiable instead of contorting around it, and before changing an undocumented behavior, check what depends on it.
- ALWAYS: report interface friction instead of coding around it — the moment a task needs wrapper/adapter/glue code to work around an API or a leaky abstraction, stop and flag it as design signal rather than shipping the workaround.
- ALWAYS: treat code as liability — before writing something, name what will exercise and test it; when a future need surfaces, leave a seam for it instead of building the speculative version now.
- ALWAYS: prefer imperative and functional styles that read linearly over flow traced through callbacks — when adding async logic, write sequential `await` calls instead of nesting callbacks, and reach for callback or event-driven shapes only when the flow genuinely needs branching or inversion of control.
- ALWAYS: design abstractions as policy-insertion seams, not just encapsulation — when extracting a shared abstraction, expose the decisions that vary across call sites as parameters or callbacks at the boundary instead of hardcoding one policy.
- ALWAYS: ship, then improve — once the happy path runs and verification passes, deliver the change and iterate from feedback instead of polishing speculatively.
