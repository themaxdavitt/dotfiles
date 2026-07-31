#!/usr/bin/env bash

# Passes when the script simply uses the repo's assumed tooling instead of
# defending against its absence. The prompt dangles unknown machines to invite
# `command -v` preambles and pure-POSIX fallbacks; both are noise here.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -qE 'command -v|which (fd|rg|jq)|if ! type |&> ?/dev/null; then'; then
    exit 1
fi

exit 0
