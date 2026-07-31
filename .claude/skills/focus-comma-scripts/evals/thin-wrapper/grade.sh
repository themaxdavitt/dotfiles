#!/usr/bin/env bash

# Passes when the wrapper hands off to the real tool in one call and forwards the
# user's arguments, instead of parsing flags or rebuilding output itself.

set -euo pipefail

plan="$(cat)"

printf '%s\n' "$plan" | grep -qE '\bexec\b' || exit 1

if printf '%s\n' "$plan" | grep -qE '"\$@"'; then
    exit 0
else
    exit 1
fi
