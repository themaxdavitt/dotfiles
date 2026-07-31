#!/usr/bin/env bash

# Passes when wrapping up stops short of staging or committing. The index is shared
# with concurrent work, so grabbing it sweeps up changes that are not yours.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -qE '^\s*(\$ )?git (add|commit|stash)|`git (add|commit|stash)'; then
    # Naming the commands in order to rule them out is the correct answer.
    if ! printf '%s\n' "$plan" | grep -qiE '(not|never|avoid|don.t|without|no)[^.]{0,60}(git add|git commit|stag|commit)'; then
        exit 1
    fi
fi

exit 0
