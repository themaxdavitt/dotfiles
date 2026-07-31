# Agent guidelines — session-planner extension

This directory is a [Pi](https://github.com/earendil-works/pi) extension, split out of the gatekeeper extension on 2026-07-29. It splits planning from implementation across two Pi runs: `bin/session-plan.js` launches a read-only planning Pi under its own nono profile, that Pi submits a markdown plan through `submit_session_plan` for Plannotator review, and once approved the implementing Pi loads it with `--approved-session-plan <id>`. Pi packages resolve only when the extension runs inside Pi, so type-checking is limited to the esbuild check below.

**This workflow is currently inert**: the `pi-session-planner` nono profile the CLI defaults to does not exist in `dot_config/nono/profiles/`. Creating it is a separate decision — ask Max before adding one, and keep the read-only posture intact rather than relaxing it to make the launcher run.

## Verify

- ALWAYS: run `mise run ci` from this directory before claiming a change works — that is `mise run test` (unit tests, `node:test` via `tsx`) plus `mise run bundle` (the esbuild check), each runnable alone. Run `mise run deps` (`aube ci`) after a manifest edit. The aggregate is deliberately not called `check`: the repo root's `check = "hk check"` would be shadowed for every command run from here.
- ALWAYS: keep the launch contract asserted in `test/cli.test.ts` — the planning Pi's confinement is nothing but the nono profile and the `--tools`/`--exclude-tools` lists those builders emit, so a dropped flag silently hands a planning agent write access.

## Boundaries

- NEVER: import anything from the gatekeeper extension, or have gatekeeper import from here; instead publish over `pi.events`. Gatekeeper subscribes to `session-planner:approved-plan` for its Bash auditor's context and holds only the text — so deleting this whole directory removes the workflow cleanly, which is the point of the split.
- ALWAYS: rename this extension's own names all the way through when you rename one — the tool `submit_session_plan`, the `--session-planner` / `--approved-session-plan` flags, the `SESSION_PLANNER_*` env vars (one of which `bin/.src/pi.sh` exports), the plan layout under `~/.pi/agent/session-planner/`, and the `session-plan` binary are one contract with no external consumers, so a half-rename is the only way to break it. Leave `--gatekeeper-mode` and `--gatekeeper-ask` in `src/cli.js` alone: those are the gatekeeper extension's flags, passed to the planning Pi.
- ALWAYS: keep `src/store.js` and `src/cli.js` plain ESM JavaScript with JSDoc types, not TypeScript. `bin/session-plan.js` runs under bare `node` from the deployed target, which has no `node_modules` and therefore no `tsx`. Before the split the CLI carried its own copy of the store, so the tested code and the running code were different code.
- ALWAYS: put CLI logic in `src/cli.js` and keep `bin/executable_session-plan.js` a thin wrapper — the `executable_` chezmoi prefix means the source filename is not the target filename, so tests would otherwise have to import the prefixed name.
- ALWAYS: treat `test/`, `mise.toml`, `AGENTS.md`, and `CLAUDE.md` as dev-only; `.chezmoiignore` keeps them out of the deployed target. This extension has no runtime dependencies, so unlike gatekeeper it needs no `run_onchange` deps script.
