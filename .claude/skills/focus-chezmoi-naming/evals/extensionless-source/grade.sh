#!/usr/bin/env bash

# Passes when the file declares its own type inline, so tooling that keys off the
# extension has something else to read.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -qE '\-\*\-.*mode|shellcheck shell='; then
    exit 0
else
    exit 1
fi
