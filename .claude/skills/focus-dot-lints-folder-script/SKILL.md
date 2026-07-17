---
name: focus-dot-lints-folder-script
description: "Use when asked to write or debug a `.lints/` script."
---

# Philosophy

Read the `guide-to-linting` skill first — it decides whether a `.lints/` script is even the right lane. Each script encodes exactly one repository invariant, produces concise self-documenting failure lines, and stays easy for future agents to inspect, run, and wire into hook config. Templates in `assets/` carry the shared conventions so new scripts start uniform.

# Directives

- NEVER: stop at the first failing file or have `.lints/` scripts modify repo files. Instead, print each failure as exactly one line in `path: reason` (or `path:linenum: reason`) style, and move on (unless the lint can't continue safely), e.g.:
  ```text
  bin/executable_,idea: should be a symlink to a .py source file
  ```
- ALWAYS: start by evaluating and potentially copying one of the following templates to a new file in `.lints/` in priority order (unless the user suggests using a different approach or language):
  1. `arg.sh`: receives relative paths (`pre-commit`-style), pre-filtered by globs defined in hook config.
  2. `scan.sh`: use only when the rule cannot be checked file-by-file from hook arguments.
- ALWAYS: perform a check at exactly one abstraction layer per script — filesystem shape, single-file content, or cross-file consistency; e.g., checking a Python project's directory layout and checking its manifest's content belong in different scripts.
- NEVER: put multiple unrelated checks in the same lint script unless code can be significantly deduplicated. Instead, create several small lint scripts or re-evaluate if `.lints/` scripts are the correct tool.
- ALWAYS: assume modern local tools such as `fd` and `rg` are available; do not add dependency checks, check `mise.toml` and suggest a change there if a useful tool isn't present.
- ALWAYS: attempt to use parsing techniques in this priority order, and ask the user before trying anything else (e.g., no DIY HTML parsers):
  1. `rg --fixed-strings`: for literal markers
  2. `rg`: for regex pattern matching
  3. POSIX `awk`: only for simple, well-defined formats when string matching would accept obvious false positives
- ALWAYS: wire newly-created scripts into hook config unless the user says otherwise, using the narrowest trigger globs needed.
