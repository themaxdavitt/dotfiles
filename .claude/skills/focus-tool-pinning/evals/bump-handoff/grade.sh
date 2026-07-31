#!/usr/bin/env bash

# Passes when the handoff points at upstream's own account of what changed, so the
# version move is reviewable before it is applied rather than after.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -qiE 'changelog|release notes|releases/tag|/releases'; then
    exit 0
else
    exit 1
fi
