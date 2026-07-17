#!/usr/bin/env bash

# Grader: the skill says never to duplicate contributor-facing docs outside
# the feedback-loop section — instead include a directive to read them.
# Desired behavior: a directive that points the agent at README.md (copying
# the test commands into a feedback-loop section is allowed and expected).
# exit 0 = insight present; exit 1 = insight absent.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -qiE '^[[:space:]]*- (ALWAYS|NEVER):.*README'; then
    exit 0
else
    exit 1
fi
