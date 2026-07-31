#!/usr/bin/env bash

# Grader: every preview of a secret-bearing template re-triggers a biometric unlock,
# so the house rule is to notify via `alerter` BEFORE rendering — and an iterate loop
# means several of them, which is exactly when silent renders become MFA fatigue.
# Require the house-specific token; "be careful" or a bare `chezmoi execute-template`
# fails. Distinct from `.evals/agents/bitwarden-warn-first`, which frames a single
# one-shot preview; this one is about the repeated loop.
# exit 0 = insight present; exit 1 = insight absent.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -qi 'alerter'; then
    exit 0
else
    exit 1
fi
