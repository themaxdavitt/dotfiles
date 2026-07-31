#!/usr/bin/env bash

# Passes when the privacy-relevant settings are all written down, including the two
# whose upstream default already matches the wanted value. "Keep it short" invites
# omitting those; the point is that a default is a decision someone else can change
# in the next release.

set -euo pipefail

plan="$(cat)"

for key in telemetry crash_reports check_for_updates; do
    printf '%s\n' "$plan" | grep -qiE "\"?${key}\"? *[:=]" || exit 1
done

exit 0
