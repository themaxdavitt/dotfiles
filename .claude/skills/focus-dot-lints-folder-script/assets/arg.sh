#!/usr/bin/env bash

# TODO: write a concise one-line description of the invariant this lint enforces. Multiple sentences on that single line are OK.

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(realpath "$script_dir"/..)"

failed=0

# shellcheck disable=2329  # TODO: remove, called from the TODO block below once the rule is filled in
report() {
  printf '%s: %s\n' "$1" "$2"
  failed=1
}

for arg in "$@"; do
  file="$repo_root/$arg"
  [[ -f "$file" ]] || continue

  # TODO: enforce the invariant, e.g.:
  # if ! rg --quiet --fixed-strings 'set -euo pipefail' "$file"; then
  #   report "$arg" "missing set -euo pipefail"
  # fi
done

exit "$failed"
