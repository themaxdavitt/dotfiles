#!/usr/bin/env bash

# Require every `refs/tags/<tag>` documentation link in a guidance file to cite the version its tool is pinned to in mise, so an agent that fetches the link reads the docs for the version actually installed.

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(realpath "$script_dir"/..)"

failed=0

report() {
  printf '%s: %s\n' "$1" "$2"
  failed=1
}

# Cross-file rule: a version bump and the link citing it live in different files, so
# this scans the whole corpus itself rather than trusting hook arguments — handed only
# the bumped config, an argument-driven lint would never look at the guidance.
declare -A pins=()

# dasel rather than a regex: both the scalar form ("aqua:o/r" = "1.2.3") and the
# inline-table form ({ version = "1.2.3", … }) are real here. Two queries because a
# ternary parses inside `.filter()` but not inside `.map()`, and `&&` is evaluated
# eagerly — so the map-form filter must gate `.keys()` behind a ternary rather than
# `&&`, or a scalar entry hard-errors the whole query.
collect_pins() {
  local file="$1" filter="$2" value_expr="$3"
  local line

  [[ -f "$file" ]] || return 0
  rg --quiet '^\[tools' "$file" || return 0

  while IFS= read -r line; do
    line="${line#- }"
    [[ "$line" == *\|* ]] || continue
    # Drop the backend prefix: a doc link carries only `owner/repo`.
    pins["${line%%\|*}"]="${line#*\|}"
  done < <(
    dasel query -i toml -o yaml \
      "tools.entries().filter($filter).map(\$this.key + \"|\" + toString($value_expr))" \
      <"$file" 2>/dev/null || true
  )
}

# Every mise config this repo owns: its own dev tools, plus the chezmoi-managed
# user-level config and its drop-ins, since a cited tool may be pinned in either.
pin_files=("$repo_root/mise.toml" "$repo_root/dot_config/mise/config.toml")
while IFS= read -r -d '' pin_file; do
  pin_files+=("$pin_file")
done < <(fd -0 --type f --glob '*.toml' "$repo_root/dot_config/mise/conf.d" 2>/dev/null || true)

# shellcheck disable=2016 # `$this` is dasel selector syntax, not a shell expansion
for pin_file in "${pin_files[@]}"; do
  collect_pins "$pin_file" 'typeOf($this.value) != "map"' '$this.value'
  collect_pins "$pin_file" \
    'typeOf($this.value) != "map" ? (false) : ($this.value.keys().any($this == "version"))' \
    '$this.value.version'
done

# Strip the backend prefix once the table is built, so `aqua:` and `github:` entries
# for the same repo collapse to the one key a doc link can name.
for key in "${!pins[@]}"; do
  [[ "$key" == *:* ]] || continue
  pins["${key#*:}"]="${pins[$key]}"
done

while IFS= read -r hit; do
  [[ -n "$hit" ]] || continue

  location="${hit%%$'\t'*}"
  tag="${hit##*$'\t'}"
  relpath="${location%%:*}"
  relpath="${relpath#"$repo_root"/}"
  linenum="${location#*:}"
  linenum="${linenum%%:*}"
  repo="${location##*:}"

  pinned="${pins["$repo"]:-}"
  # Not a tool this repo pins, so there is no version to hold the tag against.
  [[ -n "$pinned" ]] || continue
  # Accept a bare version or any `v`-style prefix (mise `version_prefix` tools).
  [[ "$tag" == "$pinned" || "$tag" == *v"$pinned" ]] && continue

  report "$relpath:$linenum" "doc link cites $repo $tag but mise pins $pinned; change the tag to refs/tags/v$pinned"
done < <(
  rg --line-number --with-filename --only-matching \
    --replace '$1'$'\t''$2' \
    --hidden \
    --glob '**/AGENTS.md' \
    --glob '**/AGENTS.local.md' \
    --glob '**/AGENTS.override.md' \
    --glob '**/SKILL.md' \
    --glob '**/CLAUDE.md' \
    'raw\.githubusercontent\.com/([^/]+/[^/]+)/refs/tags/([^/]+)/' \
    "$repo_root" 2>/dev/null || true
)

exit "$failed"
