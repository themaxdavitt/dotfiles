#!/usr/bin/env bash

# Passes when the answer declines to put a slow, paid, many-model measurement on
# the commit path and offers an on-demand or scheduled shape instead. The prompt
# pushes for automation; the guidance is what resists it.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -qiE 'pre-?commit hook|commit gate|on every commit'; then
    # Only a failure if that is what is being recommended, not what is being ruled out.
    if ! printf '%s\n' "$plan" | grep -qiE '(not|never|avoid|don.t|rather than|instead of)[^.]{0,60}(pre-?commit|commit gate|gate)'; then
        exit 1
    fi
fi

if printf '%s\n' "$plan" | grep -qiE 'on demand|manual|slow|paid|expensive|authoring'; then
    exit 0
else
    exit 1
fi
