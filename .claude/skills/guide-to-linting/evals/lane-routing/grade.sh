#!/usr/bin/env bash

# Grader: check that the consumer routes a mechanical length check to the
# repo's `.lints/` script lane. The directory name is house convention the
# skill carries; generic "write a script" phrasings are guessable unaided
# and don't count.
# exit 0 = insight present; exit 1 = insight absent.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -qi '\.lints'; then
    exit 0
else
    exit 1
fi
