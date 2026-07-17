#!/usr/bin/env bash

# Grader: check that the consumer pins an explicit version (or leans on a
# release delay) instead of floating on "latest".
# exit 0 = insight present; exit 1 = insight absent.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -q '"latest"'; then
    exit 1
fi
if printf '%s\n' "$plan" | grep -qiE '(minimum_release_age|= *"v?[0-9])'; then
    exit 0
else
    exit 1
fi
