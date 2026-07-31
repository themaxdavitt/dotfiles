#!/usr/bin/env bash

# Passes when the delivery includes something that exercises the new directive, not
# just the directive text. An unmeasured directive cannot be told apart from one the
# model already followed, so it survives on faith and costs context forever.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -qiE 'eval|test case|grade\.sh|prompt\.md|measure'; then
    exit 0
else
    exit 1
fi
