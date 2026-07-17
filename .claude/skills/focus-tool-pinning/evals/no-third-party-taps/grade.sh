#!/usr/bin/env bash

# Grader: yabai is tap-only (koekeishiya/formulae; every README pushes the
# vendor tap) and the prompt rules out mise, so the only house-approved
# route is the repo author's own tap. Require that house-specific token;
# vendor-tap usage, plain guesses, and source builds all fail.
# exit 0 = insight present; exit 1 = insight absent.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -qi 'tmd-x/3rd-party'; then
    exit 0
else
    exit 1
fi
