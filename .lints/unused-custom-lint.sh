#!/usr/bin/env bash

# Report passed top-level `.lints/` files that are not used as `check = ".lints/..."` commands in `hk.pkl`. Arguments such as `{{ files }}` after the lint path still count. When `hk.pkl` is passed, recheck every top-level lint because hook wiring may have changed.

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(realpath "$script_dir"/..)"
hk_file="$repo_root/hk.pkl"

unused_lint=0
seen_lints=$'\n'

report() {
  printf '%s: %s\n' "$1" "$2"
  unused_lint=1
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

hk_uses_lint() {
  local relpath="$1"

  awk -v relpath="$relpath" '
    {
      value = $0
      if (match(value, /(^|[^[:alnum:]_-])check[[:space:]]*=[[:space:]]*"[^"]+"/)) {
        value = substr(value, RSTART, RLENGTH)
        sub(/^.*check[[:space:]]*=[[:space:]]*/, "", value)
        sub(/^"/, "", value)
        sub(/"$/, "", value)
        sub(/[[:space:]]*$/, "", value)
      } else {
        next
      }

      if (value == relpath || index(value, relpath " ") == 1) {
        found = 1
        exit
      }
    }

    END {
      exit found ? 0 : 1
    }
  ' "$hk_file"
}

check_lint() {
  local relpath="$1"
  local file="$repo_root/$relpath"

  [[ -f "$file" ]] || return

  case "$seen_lints" in
    *$'\n'"$relpath"$'\n'*) return ;;
  esac

  seen_lints+="$relpath"$'\n'

  if ! hk_uses_lint "$relpath"; then
    report "$relpath" "not used as a check command in hk.pkl"
  fi
}

check_all_lints() {
  local lint_file
  local relpath

  while IFS= read -r -d '' lint_file; do
    relpath="${lint_file#"$repo_root"/}"
    check_lint "$relpath"
  done < <(
    fd -0 --hidden --type f --max-depth 1 . "$repo_root/.lints"
  )
}

for arg in "$@"; do
  relpath="$(arg_to_relpath "$arg")" || continue

  if [[ "$relpath" == hk.pkl ]]; then
    check_all_lints
  elif [[ "$relpath" == .lints/* && "${relpath#.lints/}" != */* ]]; then
    check_lint "$relpath"
  fi
done

exit "$unused_lint"
