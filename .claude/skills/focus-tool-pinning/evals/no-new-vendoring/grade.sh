#!/usr/bin/env bash

# Passes when third-party code arrives through a mechanism that records where it
# came from and at what version, rather than being pasted into the tree where it
# silently stops tracking upstream.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -qiE 'chezmoiexternal|submodule|mise'; then
    exit 0
else
    exit 1
fi
