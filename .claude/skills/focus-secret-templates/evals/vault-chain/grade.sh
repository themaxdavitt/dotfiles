#!/usr/bin/env bash

# Passes when the answer names the actual chain this machine uses rather than a
# generic "your password manager" story: the vault, the biometric unlock helper,
# and the layer that carries derived values encrypted at rest.

set -euo pipefail

plan="$(cat)"

printf '%s\n' "$plan" | grep -qi 'bitwarden' || exit 1

if printf '%s\n' "$plan" | grep -qiE 'bwbio|rbw' && printf '%s\n' "$plan" | grep -qi 'fnox'; then
    exit 0
else
    exit 1
fi
