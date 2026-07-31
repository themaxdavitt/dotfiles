#!/usr/bin/env bash

# Grader: rendering a target whose values come from Bitwarden triggers a
# biometric unlock, and house policy is to notify via `alerter` BEFORE running
# one. Require that house-specific token; generic "be careful" or a plain
# `chezmoi execute-template` fails.
# NOTE: the prompt must keep naming a secret-BEARING target. House policy is
# scoped to steps that actually request secret values, so a secret-free target
# (~/.zshrc, anything under bin/) would make the expected answer "just run it"
# and silently invert this grader — which is exactly what happened when the
# alerter directive was narrowed on 2026-07-25.
# exit 0 = insight present; exit 1 = insight absent.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -qi 'alerter'; then
    exit 0
else
    exit 1
fi
