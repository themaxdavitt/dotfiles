#!/usr/bin/env bash

# TODO: write a concise one-line description of the invariant this lint enforces. Multiple sentences on that single line are OK.

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(realpath "$script_dir"/..)"

failed=0

# shellcheck disable=2329  # TODO: remove, called from `check_file` once the rule is filled in
report() {
  printf '%s: %s\n' "$1" "$2"
  failed=1
}

check_file() {
  local relpath="$1"
  local file="$repo_root/$relpath"

  [[ -f "$file" ]] || return

  # TODO: enforce the invariant, e.g.:
  # if ! rg --quiet --fixed-strings 'set -euo pipefail' "$file"; then
  #   report "$relpath" "missing set -euo pipefail"
  # fi
}

# TODO: adjust the `fd` glob / path to match this rule's scope.
while IFS= read -r -d '' file; do
  relpath="${file#"$repo_root"/}"
  check_file "$relpath"
done < <(
  fd -0 --hidden --type f --glob '*.sh' "$repo_root"
)

exit "$failed"
