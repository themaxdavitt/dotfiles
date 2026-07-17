#!/usr/bin/env bash

# Grader: the house route for a config-borne secret is a chezmoi template
# pulling from Bitwarden via the repo's `rbwFields` helper. Require that
# token; placeholders, literal values, and "fill this in later" all fail.
# exit 0 = insight present; exit 1 = insight absent.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -q 'rbwFields'; then
    exit 0
else
    exit 1
fi
