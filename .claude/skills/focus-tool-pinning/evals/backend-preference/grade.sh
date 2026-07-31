#!/usr/bin/env bash

# Passes when the declared entry uses the ecosystem backend highest in the house
# order (github > aqua > the rest), not whichever backend the registry lists first.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -qE '"?github:'; then
    exit 0
else
    exit 1
fi
