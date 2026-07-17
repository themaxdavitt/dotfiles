#!/usr/bin/env bash

# Grader: the skill says never to present alternatives without a rule for
# picking between them — one recommendation plus the criterion for deviating.
# Desired behavior: a directive committing to esbuild as the default (the
# prompt says CI uses it), rather than describing both tools neutrally.
# Positive grep only; mentioning tsc as the deviation path is expected.
# exit 0 = insight present; exit 1 = insight absent.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -qiE '^[[:space:]]*- (ALWAYS|NEVER):.*esbuild'; then
    exit 0
else
    exit 1
fi
