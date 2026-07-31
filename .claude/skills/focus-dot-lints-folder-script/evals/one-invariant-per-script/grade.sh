#!/usr/bin/env bash

# Grader: one invariant per script, at one abstraction layer — filesystem shape
# and manifest content belong in different scripts, each with its own narrow
# trigger glob. Folding both checks into a single `.lints/` script fails.
# exit 0 = insight present; exit 1 = insight absent.

set -euo pipefail

plan="$(cat)"

# Two distinct .lints/ script filenames is the unambiguous signal.
count="$(printf '%s\n' "$plan" | grep -oE '\.lints/[A-Za-z0-9_-]+\.sh' | sort -u | wc -l | tr -d ' ')"
if [ "$count" -ge 2 ]; then
    exit 0
fi

# Fall back to an explicit statement that they are separate scripts.
if printf '%s\n' "$plan" | grep -qiE '\b(two|separate|distinct)\b[^.]{0,40}\bscripts?\b'; then
    exit 0
fi
exit 1
