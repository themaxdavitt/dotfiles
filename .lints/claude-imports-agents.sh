#!/usr/bin/env bash

# Require every CLAUDE.md to contain exactly the single line "@AGENTS.md", enforcing AGENTS.md as the single authoritative guidance file.

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(realpath "$script_dir"/..)"

failed=0

report() {
  printf '%s: %s\n' "$1" "$2"
  failed=1
}

arg_to_relpath() {
  local arg="$1"

  case "$arg" in
    "$repo_root"/*) printf '%s\n' "${arg#"$repo_root"/}" ;;
    /*) return 1 ;;
    ./*) printf '%s\n' "${arg#./}" ;;
    *) printf '%s\n' "$arg" ;;
  esac
}

for arg in "$@"; do
  relpath="$(arg_to_relpath "$arg")" || continue
  # Match any CLAUDE.md, not just the repo root one
  [[ "$relpath" == *CLAUDE.md ]] || continue
  file="$repo_root/$relpath"
  [[ -f "$file" ]] || continue

  # Strip trailing newline then check for exact content
  content="$(tr -d '\n' < "$file")"

  if [[ "$content" != "@AGENTS.md" ]]; then
    report "$relpath" "must contain exactly '@AGENTS.md' (single source-of-truth pointer to AGENTS.md)"
  fi
done

exit "$failed"
