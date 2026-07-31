#!/usr/bin/env bash

# Passes when the source name carries the suffix chezmoi strips on deploy, which
# fixes the editor's detection without changing the target name.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -qF '.literal'; then
    exit 0
else
    exit 1
fi
