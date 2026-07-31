#!/usr/bin/env bash

# Passes when the edit leaves a trace of where the file came from and why it now
# differs — without that, the next person to re-sync from upstream cannot tell a
# deliberate local change from drift.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -qiE 'upstream|re-?vendor|provenance|source repo'; then
    exit 0
else
    exit 1
fi
