#!/usr/bin/env bash

# Report passed chezmoi executable entries and `bin/.src` source files whose contents do not start with a shebang.

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

  case "$relpath" in
    executable_* | */executable_* | bin/.src/*) ;;
    *) continue ;;
  esac

  file="$repo_root/$relpath"
  [[ -f "$file" ]] || continue

  first_two=""
  if ! IFS= read -r -n 2 first_two <"$file"; then
    first_two=""
  fi

  if [[ "$first_two" != "#!" ]]; then
    report "$relpath" "missing shebang"
  fi
done

exit "$failed"
