# Agent guidelines — claude-tools extension

This directory is a [Pi](https://github.com/earendil-works/pi) extension holding tools that Claude-trained models reach for but Pi does not ship. Right now that is exactly one: `AskUserQuestion`, vendored 2026-07-29 from `~/Projects/2026-pi-claude-p` (which adapted Pi's `examples/extensions/questionnaire.ts`). Pi packages resolve only when the extension runs inside Pi, so type-checking is limited to the esbuild check below.

## Verify

- ALWAYS: run `mise run ci` from this directory before claiming a change works — that is `mise run test` (unit tests, `node:test` via `tsx`) plus `mise run bundle` (the esbuild check), each runnable alone. Run `mise run deps` (`aube ci`) after a manifest edit. The aggregate is deliberately not called `check`: the repo root's `check = "hk check"` would be shadowed for every command run from here.
- ALWAYS: ask Max to drive a TUI session for anything the suite cannot reach — keyboard handling, tab navigation, the preview pane, and the editor overlay are all untested code, and the upstream this came from was never runtime-tested at all. Use `"$(mise which pi)"` rather than the `~/bin/pi` wrapper.

## Boundaries

- NEVER: register a Pi built-in tool name (`bash`, `read`, `write`, `edit`, …) here; instead put it in the gatekeeper extension's `src/tools/builtins.ts`. Registering a built-in name overrides it and the last registration wins, so claiming `bash` here would decide by directory sort order whether gatekeeper's nono spawn hook — i.e. all OS confinement — survives. This extension registers only names Pi does not already have.
- NEVER: put logic worth testing in a module that value-imports `@earendil-works/*` or `typebox`; instead keep it in `src/answers.ts`, which has no Pi imports and therefore can be reached from the suite. `src/ask-user-question.ts` is the rendering half and cannot be imported outside Pi.
- ALWAYS: keep `AskUserQuestion`'s schema and behavior matching Claude Code's native contract (1-4 questions, 2-4 options each, a short header, an always-present free-text "Other", previews on single-select only) — the point of the tool is that a Claude-trained model already knows how to call it.
- ALWAYS: treat `test/`, `mise.toml`, `AGENTS.md`, and `CLAUDE.md` as dev-only; `.chezmoiignore` keeps them out of the deployed target. This extension has no runtime dependencies, so it needs no `run_onchange` deps script.
