#!/usr/bin/env bash

# Require Python comma scripts (`bin/.src/,*.py`) that build a typer CLI to pass their deployed comma name as `prog_name=",NAME"`, so `--help` shows `,NAME` no matter how the script is invoked (deployed, source, or `executable_` symlink).

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

  stem="${base%.py}"
  if ! rg --quiet --fixed-strings "prog_name=\"$stem\"" "$file"; then
    report "$arg" "pass prog_name=\"$stem\" when invoking the typer app so --help shows the deployed name"
  fi
done

exit "$failed"
