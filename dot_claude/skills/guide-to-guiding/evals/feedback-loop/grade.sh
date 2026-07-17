#!/usr/bin/env bash

# Grader: check that the consumer's AGENTS.md establishes a feedback loop —
# concrete check commands plus check-before-done framing.
# exit 0 = insight present; exit 1 = insight absent.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -qE 'cargo (test|clippy|fmt)' &&
    printf '%s\n' "$plan" | grep -qiE '(before (claiming|marking|calling|considering|declaring)|verif|check.{0,20}(work|change|done|complete))'; then
    exit 0
else
    exit 1
fi
