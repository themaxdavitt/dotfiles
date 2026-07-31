#!/usr/bin/env bash

# Passes when a deterministic text match is the answer. Reaching for a model to
# judge something a pattern already decides makes every eval run slower, paid, and
# non-reproducible.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -qiE '\b(grep|rg|ripgrep|ast-grep|regex|regular expression|pattern match)\b'; then
    exit 0
else
    exit 1
fi
