---
name: focus-comma-scripts
description: "Use when asked to add, change, or wrap a personal `,`-command in `bin/` (comma scripts, `.src/` layout, thin wrappers, PEP 723 Python utilities)."
---

# Philosophy

Personal commands are comma-prefixed so they sort together and never collide with real tools. Code lives in `bin/.src/`; the deployed name is a chezmoi symlink that becomes a real executable in `~/bin`. Wrappers stay thin, Python utilities arrive pinned through PEP 723, and every script survives `shellcheck`.

# Core Directives

- ALWAYS: put the code in `bin/.src/,NAME.sh` (or `.py`/`.js`) and make `bin/executable_,NAME` a relative symlink to it — chezmoi reads through the link and deploys a real file with the exec bit at `~/bin/,NAME`.
- ALWAYS: start a new command by copying the matching template — [Python][tmpl-py], [bash][tmpl-sh], or [Deno JS][tmpl-js] — then fill the `,NAME` and description placeholders and stamp the pinning date with `date -u +"%Y-%m-%dT%H:%M:%SZ"`. The Python template encodes the CLI house rules, all lint-enforced: typer only (no argparse/click), `prog_name=",NAME"`, and a module docstring passed as `help=__doc__`.
- ALWAYS: write `--help` so it explains the process a command runs rather than naming it — a `,`-command ships no README, so its help text is the only documentation, and a later session has to reconstruct the pipeline from that alone. Give the stages in order, mark which ones spend money or touch the network, and say which ones write files; keep the first docstring line a single-sentence summary, since that line is what the command list shows.
- ALWAYS: write Python utilities as PEP 723 `uv run --script` files with `exclude-newer = <UTC timestamp>` under `[tool.uv]` (the `focus-tool-pinning` skill owns the dependency rules); keep sources mode 644 — the `executable_` prefix adds the bit on deploy.
- ALWAYS: wrap an already-installed tool as a thin bash `exec` passthrough instead of re-implementing behavior (pattern: `bin/executable_brew`, `bin/executable_gh`).
- ALWAYS: keep a script in one file, splitting only once complexity forces it rather than because the upstream it came from was split — porting code in is the moment to collapse it and drop whatever the new home does not use (`.colors/generate.js` is ~600 lines in one file, having shed the exporters this machine does not render).
- ALWAYS: start bash sources with `#!/usr/bin/env bash` and a `set -e`-style strictness line right after the shebang (`.lints/bin-bash-set-line.sh` enforces this), and run `shellcheck` before finishing.
- ALWAYS: land changes with `chezmoi apply ~/bin`; `AGENTS.md` owns the scoped-apply and unlock-warning rule that target satisfies.

[tmpl-py]: assets/tmpl.py
[tmpl-sh]: assets/tmpl.sh
[tmpl-js]: assets/tmpl.js
