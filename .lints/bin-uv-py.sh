#!/usr/bin/env bash

# Require passed `bin/.src/*.py` scripts to use `uv run --script` with pinned PEP 723 metadata.

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(realpath "$script_dir"/..)"

failed=0
pep_723_shebang="#!/usr/bin/env -S uv run --script"
mise_python_shebang="#!/usr/bin/env -S mise x python"

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

script_block_contains() {
  local file="$1"
  local needle="$2"

  awk -v needle="$needle" '
    NR == 1 && /^#!/ {
      next
    }
    !in_script_block && /^[[:space:]]*$/ {
      next
    }
    /^[[:space:]]*#?[[:space:]]*\/\/\/ script[[:space:]]*$/ {
      in_script_block = 1
      if (needle == "") {
        found = 1
        exit
      }
      next
    }
    in_script_block && /^[[:space:]]*#?[[:space:]]*\/\/\/[[:space:]]*$/ {
      exit
    }
    in_script_block && needle != "" && index($0, needle) {
      found = 1
      exit
    }
    in_script_block {
      next
    }
    /^[[:space:]]*#/ {
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

for arg in "$@"; do
  relpath="$(arg_to_relpath "$arg")" || continue

  # TODO: remove, `hk` should handle this filtering for us
  case "$relpath" in
    bin/.src/*.py) ;;
    *) continue ;;
  esac

  file="$repo_root/$relpath"
  [[ -f "$file" ]] || continue

  first_line=""
  if ! IFS= read -r first_line <"$file"; then
    first_line=""
  fi

  # TODO: `$mise_python_shebang` should be used as a _prefix_, because usually you will use `python@whatever`
  if [[ "$first_line" == "$mise_python_shebang"* ]]; then
    report "$relpath" "use uv run --script with PEP 723 metadata instead of mise x python"
    continue
  fi

  if [[ "$first_line" != "$pep_723_shebang" ]]; then
    report "$relpath" "expected $pep_723_shebang"
    continue
  fi

  if ! script_block_contains "$file" ""; then
    report "$relpath" "missing PEP 723 /// script block"
    continue
  fi

  if ! script_block_contains "$file" "requires-python"; then
    report "$relpath" "PEP 723 /// script block is missing requires-python"
  fi

  if ! script_block_contains "$file" "exclude-newer"; then
    report "$relpath" "PEP 723 /// script block is missing exclude-newer"
  fi
done

exit "$failed"
