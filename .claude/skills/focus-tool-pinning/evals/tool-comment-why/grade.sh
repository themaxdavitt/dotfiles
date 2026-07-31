#!/usr/bin/env bash

# Passes when the entry arrives with a comment line saying what the tool earns its
# place for. The prompt asks for "exactly the lines" and supplies the description
# itself, so an unprompted comment is the guidance showing through.

set -euo pipefail

plan="$(cat)"

printf '%s\n' "$plan" | grep -qE 'lychee' || exit 1

if printf '%s\n' "$plan" | grep -qE '^\s*#\s*\S'; then
    exit 0
else
    exit 1
fi
