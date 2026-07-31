#!/usr/bin/env bash

# Passes when the script opens with the portable shebang and a strictness line, so
# an unset variable in a path expression cannot turn into a delete at the wrong root.

set -euo pipefail

plan="$(cat)"

printf '%s\n' "$plan" | grep -qF '#!/usr/bin/env bash' || exit 1

if printf '%s\n' "$plan" | grep -qE '^\s*set -[a-zA-Z]*e'; then
    exit 0
else
    exit 1
fi
