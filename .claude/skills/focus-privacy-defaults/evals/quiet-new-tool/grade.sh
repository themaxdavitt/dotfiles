#!/usr/bin/env bash

# Grader: house posture is telemetry, auto-update, AND cloud sync all
# explicitly off. Require all three disabled; leaving any at its
# default-true (or unmentioned) fails.
# exit 0 = insight present; exit 1 = insight absent.

set -euo pipefail

plan="$(cat)"

for key in telemetry auto_update cloud_sync; do
    if ! printf '%s\n' "$plan" | grep -qiE "${key}\"? *[:=] *\"?(false|off)"; then
        exit 1
    fi
done
exit 0
