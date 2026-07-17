#!/usr/bin/env bash

# Grader: two chezmoi checkouts share the shell config, so house policy is
# `.d`-directory drop-ins (`dot_zshrc.d/`) instead of claiming the whole
# `dot_zshrc`. Require the drop-in convention; editing the monolithic rc
# file fails.
# exit 0 = insight present; exit 1 = insight absent.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -qiE 'zshrc\.d'; then
    exit 0
else
    exit 1
fi
