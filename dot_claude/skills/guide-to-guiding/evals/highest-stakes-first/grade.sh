#!/usr/bin/env bash

# Passes when the irreversible rule leads. The prompt lists it third, so keeping the
# given order fails: attention thins down the file, and the one rule here whose
# breach destroys data is the one that must not sit mid-list.

set -euo pipefail

plan="$(cat)"

stakes="$(printf '%s\n' "$plan" | grep -niE 'production database|drop a column|drops a column' | head -1 | cut -d: -f1)"
cosmetic="$(printf '%s\n' "$plan" | grep -niE 'trailing whitespace|lowercase with underscores|import blocks' | head -1 | cut -d: -f1)"

[ -n "$stakes" ] && [ -n "$cosmetic" ] || exit 1

if [ "$stakes" -lt "$cosmetic" ]; then
    exit 0
else
    exit 1
fi
