---
name: focus-chezmoi-naming
description: "Use when asked to add, move, or rename a file managed by this chezmoi repo (source-state attribute prefixes, target paths, format detection)."
---

# Philosophy

Source file names are the API: attribute prefixes decide the target's dot prefix, permissions, executability, and templating, so a wrong name deploys a wrong file. The upstream chezmoi reference, pinned at the installed version, is the authority; local suffix workarounds exist only to keep editors from mis-detecting formats.

# Core Directives

- ALWAYS: name source files per the [chezmoi source-state attributes reference][chezmoi-source-attrs], checking it before inventing a name — attribute order and stacking rules are strict, and a bad guess deploys silently wrong.
- ALWAYS: add a `.literal` suffix when Zed mis-detects a file's format (e.g. JSON vs JSONC); chezmoi strips it from the target name.
- ALWAYS: keep repo-scoped tooling in dot-prefixed source directories (`.claude/`, `.evals/`, `.lints/`) — chezmoi skips dot-prefixed source entries entirely; write `.chezmoiignore` patterns against TARGET paths, not source paths.
- ALWAYS: when attribute prefixes leave a source name without a usable extension (e.g. `executable_,gl`), add a `# -*- mode: … -*-` line and `shellcheck` directives so editors and linters can still detect the file type.
- ALWAYS: after removing, relocating, or newly ignoring a managed source file, delete the now-unmanaged deployed copy yourself (then re-apply the scoped target) — `chezmoi apply` leaves newly-unmanaged files untouched, so stale copies linger in `$HOME` until removed by hand.
- NEVER: add an entry to `.chezmoiremove`; instead delete the stale target by hand as above and say so in your report. Max is still reading the upstream docs to work out how to use that file without it accumulating cruft, so treat existing entries as read-only history. It would not help in the common case anyway: an entry whose source file still exists fails the whole apply with `inconsistent state`, and one that `.chezmoiignore` also matches is silently inert, because ignore is applied first.
- ALWAYS: have `run_` scripts read their inputs from `{{ .chezmoi.sourceDir }}` rather than the deployed target path — chezmoi applies entries within a directory in lexical order, and `after_` orders a script against its containing directory instead of against its siblings, so a co-located script races the very files it needs. When a tool must run *in* the deployed directory (e.g. `aube ci`), seed its inputs from the source dir first.

[chezmoi-source-attrs]: https://raw.githubusercontent.com/twpayne/chezmoi/refs/tags/v2.70.2/assets/chezmoi.io/docs/reference/source-state-attributes.md
