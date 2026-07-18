#!/usr/bin/env bash

# Require Python comma scripts (`bin/.src/,*.py`) that build a typer CLI to open with a module docstring and pass it as `help=__doc__` (on `@app.command` for single-command apps, on `typer.Typer` for groups), so `--help` shows a description instead of bare args.

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(realpath "$script_dir"/..)"

failed=0

report() {
  printf '%s: %s\n' "$1" "$2"
  failed=1
}

for arg in "$@"; do
  file="$repo_root/$arg"
  [[ -f "$file" ]] || continue

  base="$(basename "$arg")"
  [[ "$base" == ,*.py ]] || continue
  rg --quiet '^(import|from) typer\b' "$file" || continue

  first_statement="$(awk 'NR == 1 && /^#!/ { next } /^[[:space:]]*#/ { next } /^[[:space:]]*$/ { next } { print; exit }' "$file")"
  if [[ "$first_statement" != '"""'* ]]; then
    report "$arg" "start with a module docstring — it doubles as the --help description"
  fi
  if ! rg --quiet --fixed-strings 'help=__doc__' "$file"; then
    report "$arg" "pass help=__doc__ to @app.command (single command) or typer.Typer (group) so --help shows a description"
  fi
done

exit "$failed"
