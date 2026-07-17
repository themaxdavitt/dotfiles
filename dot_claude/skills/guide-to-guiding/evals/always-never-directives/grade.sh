#!/usr/bin/env bash

# Grader: check that the consumer's plan/output uses ALWAYS: or NEVER: directive bullets.
# exit 0 = insight present (skill's directive-token convention was applied)
# exit 1 = insight absent (model did not use ALWAYS/NEVER format without the skill)

set -euo pipefail

# Read the plan from stdin
plan="$(cat)"

# Check for at least one ALWAYS: or NEVER: directive bullet
if printf '%s\n' "$plan" | grep -qE '^- (ALWAYS|NEVER):'; then
    exit 0
else
    exit 1
fi
