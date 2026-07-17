#!/usr/bin/env bash

# Grader: the skill says never to duplicate contributor-facing docs outside
# the feedback loop — point at them instead. Desired behavior: a directive
# bullet that sends the agent to the README rather than restating it.
# exit 0 = insight present; exit 1 = insight absent.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -qE '^[[:space:]]*- (ALWAYS|NEVER):.*README'; then
    exit 0
else
    exit 1
fi
