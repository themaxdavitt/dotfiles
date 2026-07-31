#!/usr/bin/env bash

# Passes when the check gathers the corpus itself and the glob is left to decide only
# when it runs. Fed the matched paths instead, it sees whichever half of a duplicate
# was edited and never the other — and the two halves can land in separate commits.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -qiE 'collect|gather|discover|scan|itself|its own|all (the )?(guidance|files)|whole (corpus|repo|set)|not (just )?(the )?(passed|matched|changed)'; then
    exit 0
else
    exit 1
fi
