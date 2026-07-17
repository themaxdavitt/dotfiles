#!/usr/bin/env bash

# Require passed `.zsh` files to opt shellcheck into its closest supported parser and editor tooling into `bash`-like highlighting.

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(realpath "$script_dir"/..)"

failed=0

report() {
  printf '%s: %s\n' "$1" "$2"
  failed=1
}

leading_header_contains() {
  local file="$1"
  local needle="$2"

  awk -v needle="$needle" '
    NR == 1 && /^#!/ {
      next
    }
    /^[[:space:]]*$/ {
      next
    }
    /^[[:space:]]*#/ {
      if (index($0, needle)) {
        found = 1
        exit
      }
      next
    }
    {
      exit
    }
    END {
      exit found ? 0 : 1
    }
  ' "$file"
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
  [[ "$relpath" == *.zsh ]] || continue

  file="$repo_root/$relpath"
  [[ -f "$file" ]] || continue

  if ! leading_header_contains "$file" '# shellcheck shell=ksh'; then
    report "$relpath" "missing # shellcheck shell=ksh"
  fi

  if ! leading_header_contains "$file" '# -*- mode: bash -*-'; then
    report "$relpath" "missing # -*- mode: bash -*-"
  fi
done

exit "$failed"
