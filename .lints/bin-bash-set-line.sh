#!/usr/bin/env bash

# Require bash scripts under `bin/` to put the repository's normal errexit-enabling `set` line before executable code.

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

first_code_line() {
  local file="$1"

  awk '
    NR == 1 {
      next
    }
    /^[[:space:]]*$/ {
      next
    }
    /^[[:space:]]*#/ {
      next
    }
    {
      print
      exit
    }
  ' "$file"
}

for arg in "$@"; do
  relpath="$(arg_to_relpath "$arg")" || continue

  case "$relpath" in
    bin/executable_* | bin/.src/*) ;;
    *) continue ;;
  esac

  file="$repo_root/$relpath"
  [[ -f "$file" ]] || continue

  first_line=""
  if ! IFS= read -r first_line <"$file"; then
    first_line=""
  fi

  [[ "$first_line" == "#!"*"bash"* ]] || continue

  set_line="$(first_code_line "$file")"
  case "$set_line" in
    "set -e" | "set -eo pipefail" | "set -euo pipefail") ;;
    "") report "$relpath" "missing set line before executable code" ;;
    *) report "$relpath" "first non-comment line after shebang must be set -e, set -eo pipefail, or set -euo pipefail" ;;
  esac
done

exit "$failed"
