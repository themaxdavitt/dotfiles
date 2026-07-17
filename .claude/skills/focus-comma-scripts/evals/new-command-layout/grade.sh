#!/usr/bin/env bash

# Grader: the house layout is code in `bin/.src/` plus a `bin/executable_,NAME`
# symlink into it. Require both tokens; a standalone script in bin/ (however
# reasonable) fails.
# exit 0 = insight present; exit 1 = insight absent.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -q 'executable_,' \
    && printf '%s\n' "$plan" | grep -q '\.src/'; then
    exit 0
else
    exit 1
fi
