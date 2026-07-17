#!/usr/bin/env bash

# Require passed `.lints/` files to have exactly one leading description comment line after the shebang.

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

description_line_count() {
  local file="$1"

  awk '
    NR == 1 && /^#!/ {
      next
    }
    !in_description && /^[[:space:]]*$/ {
      next
    }
    /^[[:space:]]*#/ {
      in_description = 1
      count++
      next
    }
    {
      print count + 0
      found_end = 1
      exit
    }
    END {
      if (!found_end) {
        print count + 0
      }
    }
  ' "$file"
}

for arg in "$@"; do
  relpath="$(arg_to_relpath "$arg")" || continue

  case "$relpath" in
    .lints/*) ;;
    *) continue ;;
  esac

  file="$repo_root/$relpath"
  [[ -f "$file" ]] || continue

  count="$(description_line_count "$file")"
  if [[ "$count" != 1 ]]; then
    printf '%s: expected exactly one leading description comment line, found %s\n' "$relpath" "$count"
    failed=1
  fi
done

exit "$failed"
