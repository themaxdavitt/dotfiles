#!/usr/bin/env bash

# Require direct child files in `bin/` to be `executable_*` symlinks with relative targets under `bin/.src/`, keeping real implementation filenames out of the command name.

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

  # TODO: remove, `hk` should handle this filtering for us
  case "$relpath" in
    bin/*/*) continue ;;
    bin/*) ;;
    *) continue ;;
  esac

  file="$repo_root/$relpath"
  [[ -e "$file" || -L "$file" ]] || continue
  [[ -d "$file" && ! -L "$file" ]] && continue

  name="${relpath#bin/}"

  if [[ "$name" != executable_* ]]; then
    report "$relpath" "direct child files in bin must be named executable_*"
  fi

  if [[ ! -L "$file" ]]; then
    report "$relpath" "direct child files in bin must be symlinks into bin/.src"
    continue
  fi

  target="$(readlink "$file")"
  command_name="${name#executable_}"
  target_base="${target##*/}"

  case "$target" in
    .src/*) ;;
    *) report "$relpath" "symlink target must be a relative bin/.src/ path" ;;
  esac

  case "$target" in
    /* | *../*) report "$relpath" "symlink target must not be absolute or parent-relative" ;;
  esac

  if [[ ! -f "$repo_root/bin/$target" ]]; then
    report "$relpath" "symlink target must be an existing file: $target"
  fi

  if [[ "$name" == executable_* && "$target_base" != "$command_name"* ]]; then
    report "$relpath" "source filename should start with command name ($command_name)"
  fi

  if [[ "$target_base" != *.* ]]; then
    report "$relpath" "source filename should keep a real extension"
  fi
done

exit "$failed"
