#!/usr/bin/env bash

# Grader: check that the consumer keeps the 40-page reference out of SKILL.md,
# pointing to a reference file loaded on demand instead of inlining it.
# exit 0 = insight present; exit 1 = insight absent.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -qiE '(references?/|reference file|assets/|load(ed|s)? (it |them |only )?(when|on demand)|progressive)'; then
    exit 0
else
    exit 1
fi
