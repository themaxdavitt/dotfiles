#!/usr/bin/env bash

# Lint using `agnix`, reporting in a condensed style with links to relevant Markdown docs.

set -euo pipefail

version=$(mise ls --json | jq -r '.["github:agent-sh/agnix"][] | select(.active==true) | .version')
# Seems like some rules are only evaluated when run on the whole directory..?
output="$(agnix --format json . || true)"

# Build a JSON array of filenames to filter by (empty array = no filtering).
files_json="$(printf '%s\n' "${@:-}" | jq -R . | jq -s 'map(select(length > 0))')"
filtered="$(echo "$output" | jq --argjson files "$files_json" '
.diagnostics |= (if ($files | length) > 0 then map(select(.file as $f | $files | index($f))) else . end)
')"

if [[ -t 1 ]] ; then
  # shellcheck disable=2016
  link_filter='"\u001b]8;;https://raw.githubusercontent.com/agent-sh/agnix/refs/heads/main/website/versioned_docs/version-\($ver)/rules/generated/\(.rule | ascii_downcase).md\u001b\\\(.rule)\u001b]8;;\u001b\\"'
else
  link_filter='.rule'
fi

diag_count="$(echo "$filtered" | jq '.diagnostics | length')"
if [[ "$diag_count" -gt 0 ]] ; then
  echo take these with a grain of salt:
  echo
fi

echo "$filtered" | jq -r --arg ver "$version" '.diagnostics[] | "\(.file):\(.line): \(.level)(\('"$link_filter"')): \(.message)"'

if [[ ! -t 1 ]] ; then
  if [[ "$diag_count" -gt 0 ]] ; then
    echo
    echo "rule docs: https://raw.githubusercontent.com/agent-sh/agnix/refs/heads/main/website/versioned_docs/version-${version}/rules/generated/<rule-lowercased>.md"
  fi
fi

echo "$filtered" | jq -e '
([.diagnostics[] | select(.level == "error" or .level == "warning")] | length) == 0
' >/dev/null || exit 1
