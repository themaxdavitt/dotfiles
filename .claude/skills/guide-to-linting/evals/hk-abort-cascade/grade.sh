#!/usr/bin/env bash

# Passes when the answer treats the ten red steps as one failure plus fallout
# rather than ten bugs — either by naming the cascade or by re-running a single
# step in isolation to get a trustworthy result.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -qiE 'cascad|kills? in-?flight|aborted (steps? )?(are|do not|don.t)|not (real|genuine|separate) failures|--step'; then
    exit 0
else
    exit 1
fi
