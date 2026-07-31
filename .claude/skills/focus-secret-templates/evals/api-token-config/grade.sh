#!/usr/bin/env bash

# Grader: the house route for a config-borne secret is a chezmoi template
# pulling from Bitwarden via the repo's `rbwFields` helper. Require that
# token; placeholders, literal values, and "fill this in later" all fail.
# The prompt asks for the source filename too, so the deploy mode is in scope:
# a world-readable file holding a resolved token defeats the template.
# exit 0 = insight present; exit 1 = insight absent.

set -euo pipefail

plan="$(cat)"

printf '%s\n' "$plan" | grep -q 'rbwFields' || exit 1

if printf '%s\n' "$plan" | grep -q 'private_'; then
    exit 0
else
    exit 1
fi
