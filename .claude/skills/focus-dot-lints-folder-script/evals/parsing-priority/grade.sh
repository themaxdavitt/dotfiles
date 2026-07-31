#!/usr/bin/env bash

# Passes when a literal marker is matched literally. The parentheses in `TODO(remove)`
# are regex metacharacters, so a regex search either quietly matches the wrong thing
# or needs escaping nobody will maintain — the cheapest correct tool is a fixed-string
# search, which is the top of the ladder for exactly this reason.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -qE '(rg|grep)[^|]*(-F|--fixed-strings)'; then
    exit 0
else
    exit 1
fi
