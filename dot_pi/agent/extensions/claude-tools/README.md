# Claude Tools

A [Pi](https://github.com/earendil-works/pi) extension providing tools that
Claude-trained models reach for but Pi does not ship.

Right now that is exactly one: `AskUserQuestion`, vendored 2026-07-29 from
`~/Projects/2026-pi-claude-p`, which adapted Pi's
`examples/extensions/questionnaire.ts` and added multi-select, previews, and
notes.

## AskUserQuestion

Mirrors Claude Code's native contract, so a Claude-trained model already knows
how to call it: 1–4 questions, each with a short header (≤12 chars, shown as a
tab chip), 2–4 options carrying a label and a description, and an optional
`multiSelect`. An option may carry a `preview`, rendered in a side-by-side pane
on single-select questions when the terminal is wide enough.

Two extras beyond picking an option:

- **"Other"** is always present as the last choice and opens a free-text editor.
- **`n`** attaches a free-text note ("yes-and") to the current question, which
  travels alongside the selection rather than replacing it.

| Key | Action |
|-----|--------|
| `↑` `↓` | Move between options |
| `Enter` | Select (single) / confirm the question (multi) |
| `Space` | Toggle an option (multi-select only) |
| `Tab` `←` `→` | Move between questions and the Submit tab |
| `n` | Attach a note to this question |
| `Esc` | Cancel |

The tool requires TUI mode; in print, JSON, or RPC sessions it returns an error
rather than silently answering for the user.

## Scope

This extension registers only tool names Pi does **not** already have.
Claude-shaped compatibility for Pi's *built-in* tools — `read`/`write`/`edit`
accepting `file_path`, `old_string`/`new_string`, and `replace_all`, and `bash`
refusing `run_in_background` rather than silently running in the foreground —
lives in the `gatekeeper` extension's `src/tools/builtins.ts` instead.

That split is not cosmetic. Registering a built-in tool name overrides it, and
the last registration wins. Gatekeeper's `bash` registration is what installs
the `nono` sandbox spawn hook, so a second extension claiming `bash` would let
directory sort order decide whether OS confinement survives.

## Install

Deployed by chezmoi from `dot_pi/agent/extensions/claude-tools` to
`~/.pi/agent/extensions/claude-tools`, where Pi discovers it automatically.
There are no runtime dependencies, so the deployed target needs no
`node_modules`.
