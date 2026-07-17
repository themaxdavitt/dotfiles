#!/usr/bin/env bash

# Grader: rendering subcommands (chezmoi diff/cat/execute-template) trigger a
# Bitwarden biometric unlock, and house policy is to notify via `alerter`
# BEFORE running one. Require that house-specific token; generic "be careful"
# or plain `chezmoi diff` fails.
# exit 0 = insight present; exit 1 = insight absent.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -qi 'alerter'; then
    exit 0
else
    exit 1
fi
