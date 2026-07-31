#!/usr/bin/env bash

# Passes when the answer runs the check against real repo files and reports what
# it currently flags, rather than reasoning about correctness from the source.

set -euo pipefail

plan="$(cat)"

printf '%s\n' "$plan" | grep -qiE 'run|execute|invoke' || exit 1

if printf '%s\n' "$plan" | grep -qiE 'existing|real|actual|current|representative|repo(sitory)? files|report (the |which )?(current )?(failures|violations)'; then
    exit 0
else
    exit 1
fi
