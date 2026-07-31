#!/usr/bin/env bash

# Report chezmoi `.tmpl` files that render a secret — a `{{ … }}` action calling `(bitwarden…`/`(rbw…` (the `{{` anchor keeps prose that merely mentions `(rbw`, e.g. "the rbw/bwbio shims", from tripping this) — but whose base name lacks the `private_` attribute prefix, so the deployed target would be created world-readable (0644) instead of restricted (0600). Only `encrypted_` may legitimately precede `private_`, and its source is ciphertext that never matches these plaintext markers, so requiring the base name to start with `private_` is sufficient.

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(realpath "$script_dir"/..)"

failed=0

report() {
  printf '%s: %s\n' "$1" "$2"
  failed=1
}

for arg in "$@"; do
  case "$arg" in
    *.tmpl) ;;
    *) continue ;;
  esac

  file="$repo_root/$arg"
  [[ -f "$file" ]] || continue

  # Match the markers only inside a `{{ … }}` action, so prose mentioning `(rbw` is ignored.
  rg --quiet -e '\{\{[^}]*\((bitwarden|rbw)' -- "$file" || continue

  base="${arg##*/}"
  if [[ "$base" != private_* ]]; then
    report "$arg" 'renders a secret but base name lacks the private_ prefix'
  fi
done

exit "$failed"
