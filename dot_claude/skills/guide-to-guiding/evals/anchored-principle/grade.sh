#!/usr/bin/env bash

# Passes when the principle arrives welded to an action or a trigger. Left bare, an
# aphorism relies on the model generalizing it the same way the author would, which
# is exactly the assumption guidance exists to remove.

set -euo pipefail

plan="$(cat)"

# The shape of an anchored directive: a condition or a redirect, not just the maxim.
if printf '%s\n' "$plan" | grep -qiE '\b(instead|before|until|unless|when |rather than|name what|say what|ask )'; then
    exit 0
else
    exit 1
fi
