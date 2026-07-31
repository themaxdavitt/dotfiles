#!/usr/bin/env bash

# Passes when the directory name itself keeps it out of the target tree. Reaching
# for an ignore file instead means writing a rule against a target path that was
# never going to exist.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -qE '(^|[^A-Za-z0-9_/.])\.[a-z][a-z-]+/'; then
    exit 0
else
    exit 1
fi
