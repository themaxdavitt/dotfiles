#!/usr/bin/env bash

# Hold guidance-file directive counts inside the band where they stay useful: above 15 constraint density risks exceeding reliable recall, and a skill below 5 is not carrying its own routing overhead.

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(realpath "$script_dir"/..)"

failed=0
THRESHOLD=15
# Floor applies to SKILL.md only: a skill costs a routable trigger and a load
# decision, so too few directives means the content belongs in a sibling that the
# model already reaches for. AGENTS.md/CLAUDE.md are not the proliferation risk —
# they are per-tree, and a CLAUDE.md that only imports AGENTS.md holds none at all.
FLOOR=5

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

  if [[ "$(basename "$relpath")" == "SKILL.md" && "$count" -lt "$FLOOR" ]]; then
    report "$relpath" "too thin to be its own skill: $count top-level ALWAYS/NEVER directives (floor $FLOOR); merge it into the skill that already owns the topic, or give it the directives it is missing"
  fi
done

exit "$failed"
