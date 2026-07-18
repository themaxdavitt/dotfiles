#!/usr/bin/env bash

# Require `bin/.src/*.py` scripts that parse CLI arguments to use typer, not argparse/click/optparse/getopt directly.

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

  while IFS=: read -r lineno line; do
    [[ -n "$lineno" ]] || continue
    report "$arg:$lineno" "use typer for CLI arg parsing instead of '${line#"${line%%[![:space:]]*}"}'"
  done < <(rg --line-number '^[[:space:]]*(import|from)[[:space:]]+(argparse|click|optparse|getopt)\b' "$file" || true)
done

exit "$failed"
