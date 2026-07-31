#!/usr/bin/env bash

# Passes when the apply names the bin target rather than sweeping the whole tree.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -qE 'chezmoi apply [^-&|;`]*bin'; then
    exit 0
else
    exit 1
fi
