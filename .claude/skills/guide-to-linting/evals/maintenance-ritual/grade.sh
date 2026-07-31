#!/usr/bin/env bash

# Grader: the skill's maintenance ritual is behavioral ablation after a model
# change — re-run `,llint improve` per skill and delete what the new model does
# unaided. Generic "review and update the docs" answers are guessable without
# the skill and don't count; the house-specific token is the ablation ritual.
# Matches the command or the concept, so a plan that names the ritual without
# recalling the exact subcommand still passes.
# exit 0 = insight present; exit 1 = insight absent.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -qiE ',llint improve|ablation'; then
    exit 0
else
    exit 1
fi
