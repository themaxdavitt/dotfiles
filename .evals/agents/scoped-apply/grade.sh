#!/usr/bin/env bash

# Grader: house policy is narrowly scoped applies only — `chezmoi apply` with
# an explicit target path. Pass iff the plan's apply is followed by a target
# (path chars, not a flag or command terminator). Deliberately does NOT fail
# on *mentions* of bare `chezmoi apply`/`,cza`: guidance-loaded models quote
# the anti-pattern to reject it, and penalizing that poisons the with-skill
# condition (observed 2026-07-06: fable 80%→0% "with").
# exit 0 = insight present; exit 1 = insight absent.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -qE 'chezmoi apply[[:space:]]+[^-&|;`[:space:]]'; then
    exit 0
fi
exit 1
