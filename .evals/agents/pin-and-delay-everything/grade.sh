#!/usr/bin/env bash

# Passes when both halves of the supply-chain posture show up: an exact version, and
# a hold-back before a freshly published release is trusted. Pinning alone still
# installs a compromised artifact the day it ships.

set -euo pipefail

plan="$(cat)"

printf '%s\n' "$plan" | grep -qiE '\bpin(ned|ning)?\b|explicit version|exact version|lockfile' || exit 1

if printf '%s\n' "$plan" | grep -qiE 'minimum_release_age|release age|delay|cooling|cool-?off|hold(ing)? back|wait[^.]{0,30}(days?|release)'; then
    exit 0
else
    exit 1
fi
