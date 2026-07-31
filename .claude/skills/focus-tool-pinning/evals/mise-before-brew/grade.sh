#!/usr/bin/env bash

# Passes when the tool is declared through mise rather than the brew formula the
# prompt dangles. A mise backend is reachable here, so brew is not the fallback.

set -euo pipefail

plan="$(cat)"

# Recommending `brew install` as the way in fails outright, even alongside a mise entry.
if printf '%s\n' "$plan" | grep -qiE '^\s*(\$ )?brew install'; then
    exit 1
fi

if printf '%s\n' "$plan" | grep -qiE 'mise\.toml|\[tools\]|(aqua|ubi|github):'; then
    exit 0
else
    exit 1
fi
