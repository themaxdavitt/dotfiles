#!/usr/bin/env bash

# Require all passed files to contain a mode line (specifically an Emacs file variable, chosen for wide support, but also shallow aesthetic reasons over Vim's equivalent feature) unless their path matches an entry in `excluded_patterns`.

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

# ERE patterns matched against the repo-relative path; a match exempts the file.
# Path prefix:          '^bin/'
# Filename prefix:      '(^|/)empty_'
# Extension / suffix:   '\.sh$'
excluded_patterns=(
  '(^|/)symlink_'
  '(^|/)empty_'
  'Brewfile$'
  '\.sh$'
  '\.toml$'
  '\.py$'
  '\.mjs$'
  '\.js$'
  '\.ts$'
  '\.gitignore$'
  '\.yml$'
  '\.jsonc$'
  '\.ini$'
  '\.txt$'
  '\.md$'
  '\.editorconfig$'
  'LICENSE$'
  '\.yaml$'
  '\.json$'
  '\.pkl$'
  '\.gitattributes$'

  # Renders to a bare age private key (fnox `key_file`); the deployed target
  # must contain the key and nothing else, so it can carry no comment.
  'private_age\.txt\.tmpl$'

  # Generated, will likely be overwritten if added
  'dot_config/mise/mise.lock$'
)

excluded() {
  local relpath="$1"
  local p
  if (( ${#excluded_patterns[@]} )); then
    for p in "${excluded_patterns[@]}"; do
      [[ "$relpath" =~ $p ]] && return 0
    done
  fi
  return 1
}

for arg in "$@"; do
  relpath="$(arg_to_relpath "$arg")" || continue

  file="$repo_root/$relpath"
  [[ -f "$file" ]] || continue

  excluded "$relpath" && continue

  if ! rg --quiet -- '-\*-.*mode:.*-\*-' "$file"; then
    report "$relpath" 'missing -*- mode: ... -*- line'
  fi
done

exit "$failed"
