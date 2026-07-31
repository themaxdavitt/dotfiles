#!/usr/bin/env bash

# Passes when the check gets registered with the runner, scoped to the files it
# actually cares about. A script nobody invokes enforces nothing, and a step with a
# wide trigger runs on every unrelated edit.

set -euo pipefail

plan="$(cat)"

printf '%s\n' "$plan" | grep -qiE 'hk\.pkl|hook config' || exit 1

if printf '%s\n' "$plan" | grep -qiE 'glob|trigger|narrow|scope'; then
    exit 0
else
    exit 1
fi
