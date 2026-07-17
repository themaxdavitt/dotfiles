#!/usr/bin/env bash

# Grader: exported env secrets route through `fnox` (age-encrypted store fed
# from Bitwarden), not shell-profile literals or ad-hoc `rbw get` calls in
# rc files. Require the fnox token.
# exit 0 = insight present; exit 1 = insight absent.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -qi 'fnox'; then
    exit 0
else
    exit 1
fi
