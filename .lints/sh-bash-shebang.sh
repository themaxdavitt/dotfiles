#!/usr/bin/env bash

# Require `.sh` files to be directly executable as `bash`, and reject `.bash` files that also have a bash shebang because those should just be `.sh`.

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(realpath "$script_dir"/..)"
bash_shebang_re='^#!.*[[:space:]/]bash([[:space:]]|$)'

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

for arg in "$@"; do
  relpath="$(arg_to_relpath "$arg")" || continue

  case "$relpath" in
    *.sh | *.bash) ;;
    *) continue ;;
  esac

  file="$repo_root/$relpath"
  [[ -f "$file" ]] || continue

  first_line=""
  if ! IFS= read -r first_line <"$file"; then
    first_line=""
  fi

  case "$relpath" in
    *.sh)
      if [[ ! "$first_line" =~ $bash_shebang_re ]]; then
        printf '%s: first line must be a bash shebang\n' "$relpath"
        failed=1
      fi
      ;;
    *.bash)
      if [[ "$first_line" =~ $bash_shebang_re ]]; then
        printf '%s: bash executables should use a .sh extension\n' "$relpath"
        failed=1
      fi
      ;;
  esac
done

exit "$failed"
