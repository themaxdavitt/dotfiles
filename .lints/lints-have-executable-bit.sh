#!/usr/bin/env bash

# Require passed `.lints/` files that declare an interpreter with a shebang to have the executable bit set, so they can be run directly from hook config.

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(realpath "$script_dir"/..)"

failed=0

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
  [[ "$relpath" == .lints/* ]] || continue

  file="$repo_root/$relpath"
  [[ -f "$file" ]] || continue

  first_two=""
  if ! IFS= read -r -n 2 first_two <"$file"; then
    first_two=""
  fi

  if [[ "$first_two" == "#!" && ! -x "$file" ]]; then
    printf '%s: has shebang but is not executable\n' "$relpath"
    failed=1
  fi
done

exit "$failed"
