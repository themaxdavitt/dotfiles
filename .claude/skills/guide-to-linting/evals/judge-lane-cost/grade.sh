#!/usr/bin/env bash

# Passes when the answer names the credential the judge lane needs and the fact
# that the lane is opt-in rather than part of the default run.

set -euo pipefail

plan="$(cat)"

printf '%s\n' "$plan" | grep -qiE 'OPENROUTER_API_KEY|api key' || exit 1

if printf '%s\n' "$plan" | grep -qiE 'profile|opt-in|separate (lane|task|command)|check-llm|cache'; then
    exit 0
else
    exit 1
fi
