#!/usr/bin/env bash

# Require every mise `pipx:`/`npm:` tool entry to declare its runtime installer via `depends` (`pipx:` needs `aqua:astral-sh/uv`, `npm:` needs `aqua:jdx/aube`) so the installer resolves before the tool builds.

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(realpath "$script_dir"/..)"

failed=0

# dasel expression: over the [tools] table, keep pipx:/npm: entries that do NOT
# declare the required installer in `depends`, and emit their keys (one per YAML
# `- ` line). Nested ternaries rather than `&&` because dasel evaluates `&&`
# eagerly and hard-errors on absent/mistyped fields, so each guard must gate the
# next field access. `depends` membership is exact (`.contains` is array-only),
# so a rare versioned dep entry would be a false positive worth revisiting.
read -r -d '' query <<'DASEL' || true
tools.entries()
  .filter(startsWith($this.key, "pipx:") || startsWith($this.key, "npm:"))
  .filter(
    typeOf($this.value) != "map" ? (true)
    : ($this.value.keys().any($this == "depends")
        ? (typeOf($this.value.depends) != "array" ? (false)
          : (startsWith($this.key, "pipx:")
              ? ($this.value.depends.contains("aqua:astral-sh/uv") ? (false) : (true))
              : ($this.value.depends.contains("aqua:jdx/aube") ? (false) : (true))))
        : (true)))
  .map($this.key)
DASEL

for arg in "$@"; do
  file="$repo_root/$arg"
  [[ -f "$file" ]] || continue

  # Only descend into files that actually declare a pipx/npm tool; this also
  # sidesteps dasel erroring on a `tools`-less (e.g. empty) drop-in file.
  rg --quiet '^[[:space:]]*"(pipx|npm):' "$file" || continue

  while IFS= read -r key; do
    key="${key#- }"
    key="${key#\"}"
    key="${key%\"}"
    case "$key" in
      pipx:*) need="aqua:astral-sh/uv" ;;
      npm:*) need="aqua:jdx/aube" ;;
      *) continue ;;
    esac
    printf '%s: %s tool missing depends on %s\n' "$arg" "$key" "$need"
    failed=1
  done < <(dasel query -i toml -o yaml "$query" < "$file")
done

exit "$failed"
