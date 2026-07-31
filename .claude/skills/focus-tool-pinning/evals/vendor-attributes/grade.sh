#!/usr/bin/env bash

# Passes when the removal list includes the attributes file that marks the path as
# third-party. Stale entries there leave the repo's language stats and diff
# behaviour describing a file that no longer exists.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -qF '.gitattributes'; then
    exit 0
else
    exit 1
fi
