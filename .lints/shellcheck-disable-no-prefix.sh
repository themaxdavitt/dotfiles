#!/usr/bin/env bash

# Require ShellCheck `disable` directives to omit redundant `SC` rule-code prefixes.

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(realpath "$script_dir"/..)"

failed=0

report() {
  printf '%s:%s: %s\n' "$1" "$2" "$3"
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
    *.sh | *.zsh | *.bash | .shellcheckrc | shellcheckrc | */.shellcheckrc | */shellcheckrc) ;;
    *) continue ;;
  esac

  file="$repo_root/$relpath"
  [[ -f "$file" ]] || continue

  case "$relpath" in
    .shellcheckrc | shellcheckrc | */.shellcheckrc | */shellcheckrc)
      pattern='^[[:space:]]*disable=[^[:space:]#]*SC[[:digit:]]{4}'
      ;;
    *)
      pattern='^[[:space:]]*#[[:space:]]*shellcheck[[:space:]]+disable=[^[:space:]#]*SC[[:digit:]]{4}'
      ;;
  esac

  while IFS=: read -r line_number _; do
    report "$relpath" "$line_number" "remove the redundant SC prefix from ShellCheck disable codes"
  done < <(rg --line-number --no-heading --color=never "$pattern" "$file" || true)
done

exit "$failed"
