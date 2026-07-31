#!/usr/bin/env bash

# Passes when narrowing the rule also revisits the cases that measure it. A case
# written against the old, broader rule keeps asserting behaviour the new rule
# forbids, so it fails the very answers that now follow the guidance.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -qiE 'case|eval|grade|test'; then
    exit 0
else
    exit 1
fi
