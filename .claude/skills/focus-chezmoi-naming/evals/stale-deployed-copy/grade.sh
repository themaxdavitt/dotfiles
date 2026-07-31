#!/usr/bin/env bash

# Grader: `chezmoi apply` never removes files it has stopped managing, so the
# old target lingers in $HOME until deleted by hand. Require the plan to name
# the stale deployed path as something still to remove; "done" or a re-apply
# fails.
# exit 0 = insight present; exit 1 = insight absent.

set -euo pipefail

plan="$(cat)"

# Must point at the OLD target path (not the source path, not the new one)...
printf '%s\n' "$plan" | grep -qE '\.config/widget/settings\.conf' || exit 1

# ...and must call for removing it rather than merely mentioning it.
if printf '%s\n' "$plan" | grep -qiE '\b(rm|delete|remove|deleting|removing)\b'; then
    exit 0
else
    exit 1
fi
