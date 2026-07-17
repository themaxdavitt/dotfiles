#!/usr/bin/env bash

# Require GitHub file links in guidance files to be agent-fetchable and immutable: raw.githubusercontent.com (not the /blob/ web UI, which serves HTML) pinned to refs/tags/<tag> or a 40-hex commit SHA (branches drift after the guidance is written; tag overwrites are an accepted risk).

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(realpath "$script_dir"/..)"

failed=0

report() {
  printf '%s: %s\n' "$1" "$2"
  failed=1
}

url_re='https://(github\.com/[^/\s)>]+/[^/\s)>]+/blob/[^\s)>]+|raw\.githubusercontent\.com/[^\s)>]+)'

for arg in "$@"; do
  file="$repo_root/$arg"
  [[ -f "$file" ]] || continue

  while IFS=: read -r linenum url; do
    [[ -n "$url" ]] || continue

    if [[ "$url" == https://github.com/* ]]; then
      report "$arg:$linenum" "GitHub web-UI link ($url): use https://raw.githubusercontent.com/<org>/<repo>/refs/tags/<tag>/<path> so agents fetch file content, not HTML"
      continue
    fi

    rest="${url#https://raw.githubusercontent.com/}"
    IFS=/ read -r _org _repo seg1 seg2 _rest <<<"$rest"
    if [[ "$seg1" == refs && "$seg2" == tags ]]; then
      continue
    fi
    if [[ "$seg1" =~ ^[0-9a-f]{40}$ ]]; then
      continue
    fi
    report "$arg:$linenum" "GitHub link not pinned to an immutable ref ($url): use refs/tags/<tag> or a 40-hex commit SHA, not a branch"
  done < <(rg --only-matching --line-number "$url_re" "$file" || true)
done

exit "$failed"
