#!/usr/bin/env bash

# Require SKILL.md frontmatter values to satisfy the Agent Skills spec and this repo's naming pattern: `name` matches the skill directory (1-64 chars, lowercase alphanumeric/hyphens), `description` is a single non-empty line of at most 1024 characters, `guide-*` descriptions start with "ALWAYS: use when", and `focus-*` descriptions start with "Use when asked to".

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

frontmatter() {
  awk 'NR == 1 { if ($0 != "---") exit 1; next } /^---[[:space:]]*$/ { exit } { print }' "$1"
}

scalar_value() {
  # Print the single-line YAML scalar for key $2 from frontmatter text $1, outer quotes stripped.
  printf '%s\n' "$1" | awk -v key="$2" '
    index($0, key ": ") == 1 {
      value = substr($0, length(key) + 3)
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      if (value ~ /^".*"$/ || value ~ /^'\''.*'\''$/) value = substr(value, 2, length(value) - 2)
      print value
      exit
    }
  '
}

for arg in "$@"; do
  relpath="$(arg_to_relpath "$arg")" || continue
  [[ "$(basename "$relpath")" == "SKILL.md" ]] || continue
  file="$repo_root/$relpath"
  [[ -f "$file" ]] || continue

  if ! fm="$(frontmatter "$file")"; then
    report "$relpath" "missing YAML frontmatter"
    continue
  fi

  dir_name="$(basename "$(dirname "$relpath")")"

  name="$(scalar_value "$fm" name)"
  if [[ -z "$name" ]]; then
    report "$relpath" "frontmatter must set name on a single line"
  elif [[ "$name" != "$dir_name" ]]; then
    report "$relpath" "name '$name' must match skill directory '$dir_name'"
  elif ! [[ "$name" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ && "${#name}" -le 64 ]]; then
    report "$relpath" "name '$name' must be 1-64 lowercase alphanumeric/hyphen characters"
  fi

  description="$(scalar_value "$fm" description)"
  if [[ -z "$description" || "$description" =~ ^[\>\|] ]]; then
    report "$relpath" "frontmatter must set description as a single plain or quoted line"
    continue
  fi
  if ((${#description} > 1024)); then
    report "$relpath" "description exceeds 1024 characters (${#description})"
  fi
  case "$dir_name" in
    guide-*)
      [[ "$description" == "ALWAYS: use when "* ]] ||
        report "$relpath" "guide-* description must start with 'ALWAYS: use when '"
      ;;
    focus-*)
      [[ "$description" == "Use when asked to "* ]] ||
        report "$relpath" "focus-* description must start with 'Use when asked to '"
      ;;
  esac
done

exit "$failed"
