#!/usr/bin/env bash

# Grader: house style is one file until complexity forces a split, and a port is
# the moment to collapse the upstream layout rather than mirror it. Pass only if
# the plan lands on a single file; reproducing a multi-module `src/` tree fails.
# Deliberately does not penalise *mentioning* the upstream src/ layout, which the
# prompt itself describes — only proposing one (cf. the scoped-apply grader).
# exit 0 = insight present; exit 1 = insight absent.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -qiE '\b(a |one |single )(single )?file\b|\bone-file\b|\bsingle-file\b'; then
    exit 0
else
    exit 1
fi
