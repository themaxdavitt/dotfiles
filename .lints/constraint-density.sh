#!/usr/bin/env bash

# Warn when a guidance file has more than 15 top-level ALWAYS:/NEVER: directive bullets — beyond that threshold the constraint density risks exceeding reliable recall.

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(realpath "$script_dir"/..)"

failed=0
THRESHOLD=15

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
  [[ "$relpath" == *.md ]] || continue
  file="$repo_root/$relpath"
  [[ -f "$file" ]] || continue

  # Count lines matching top-level ALWAYS:/NEVER: directive bullet pattern
  count="$(rg --count '^- (ALWAYS|NEVER):' "$file" 2>/dev/null || echo 0)"

  if [[ "$count" -gt "$THRESHOLD" ]]; then
    report "$relpath" "constraint density too high: $count top-level ALWAYS/NEVER directives (threshold $THRESHOLD)"
  fi
done

exit "$failed"
