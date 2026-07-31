#!/usr/bin/env bash

# Require chezmoi `run_` scripts that reach into their own deployed directory to also reference `.chezmoi.sourceDir`, since `after_` orders a script against its containing directory rather than its sibling entries.

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

# Map a source directory to the target path it deploys to, undoing the source-state
# attribute prefixes chezmoi strips: dot_local/share/x -> .local/share/x.
source_dir_to_target() {
  local source_dir="$1" segment out=""
  local IFS=/
  for segment in $source_dir; do
    while :; do
      case "$segment" in
        dot_*) segment=".${segment#dot_}" ;;
        private_* | readonly_* | exact_* | encrypted_* | executable_* | symlink_* | empty_*)
          segment="${segment#*_}"
          ;;
        *) break ;;
      esac
    done
    out="${out:+$out/}$segment"
  done
  printf '%s\n' "$out"
}

for arg in "$@"; do
  relpath="$(arg_to_relpath "$arg")" || continue

  base="${relpath##*/}"
  [[ "$base" == run_* ]] || continue

  file="$repo_root/$relpath"
  [[ -f "$file" ]] || continue

  source_dir="${relpath%/*}"
  [[ "$source_dir" != "$relpath" ]] || continue

  target_dir="$(source_dir_to_target "$source_dir")"
  [[ -n "$target_dir" ]] || continue

  # A script that names its own deployed directory is reading (or writing) entries
  # chezmoi may not have applied yet: within a directory chezmoi applies entries in
  # lexical order, and `after_` orders the script against that directory rather than
  # against its siblings. Referencing `.chezmoi.sourceDir` is the signal that the
  # script sources from the source tree, or deliberately seeds the target first.
  if grep -qF -- "$target_dir" "$file" && ! grep -qF -- ".chezmoi.sourceDir" "$file"; then
    report "$relpath" "reads its own deployed dir ($target_dir) without using .chezmoi.sourceDir; it races the sibling entries it needs"
  fi
done

exit "$failed"
