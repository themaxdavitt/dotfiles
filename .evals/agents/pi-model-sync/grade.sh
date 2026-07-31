#!/usr/bin/env bash

# Passes when the editor's own copy of the list moves too. The two are separate
# files that must agree, and the prompt names only one of them.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -qiE 'zed'; then
    exit 0
else
    exit 1
fi
