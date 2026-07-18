---
name: focus-comma-scripts
description: "Use when asked to add, change, or wrap a personal `,`-command in `bin/` (comma scripts, `.src/` layout, thin wrappers, PEP 723 Python utilities)."
---

# Philosophy

Personal commands are comma-prefixed so they sort together and never collide with real tools. Code lives in `bin/.src/`; the deployed name is a chezmoi symlink that becomes a real executable in `~/bin`. Wrappers stay thin, Python utilities arrive pinned through PEP 723, and every script survives `shellcheck`.

# Core Directives

- ALWAYS: put the code in `bin/.src/,NAME.sh` (or `.py`/`.js`) and make `bin/executable_,NAME` a relative symlink to it — chezmoi reads through the link and deploys a real file with the exec bit at `~/bin/,NAME`.
- ALWAYS: start a new command by copying the matching template — [Python][tmpl-py], [bash][tmpl-sh], or [Deno JS][tmpl-js] — then fill the `,NAME` and description placeholders and stamp the pinning date with `date -u +"%Y-%m-%dT%H:%M:%SZ"`. The Python template encodes the CLI house rules, all lint-enforced: typer only (no argparse/click), `prog_name=",NAME"`, and a module docstring passed as `help=__doc__`.
- ALWAYS: write Python utilities as PEP 723 `uv run --script` files with `exclude-newer = <UTC timestamp>` under `[tool.uv]` (the `focus-tool-pinning` skill owns the dependency rules); keep sources mode 644 — the `executable_` prefix adds the bit on deploy.
- ALWAYS: wrap an already-installed tool as a thin bash `exec` passthrough instead of re-implementing behavior (pattern: `bin/executable_brew`, `bin/executable_gh`).
- ALWAYS: start bash sources with `#!/usr/bin/env bash` and a `set -e`-style strictness line right after the shebang (`.lints/bin-bash-set-line.sh` enforces this), and run `shellcheck` before finishing.
- ALWAYS: land changes with a scoped `chezmoi apply ~/bin` — `bin/` renders no secrets, so no unlock warning is needed.

[tmpl-py]: assets/tmpl.py
[tmpl-sh]: assets/tmpl.sh
[tmpl-js]: assets/tmpl.js
