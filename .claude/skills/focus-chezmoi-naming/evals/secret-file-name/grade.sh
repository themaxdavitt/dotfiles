#!/usr/bin/env bash

# Grader: owner-only permissions come from the `private_` source attribute
# (dot_config/acme/private_credentials). Require that attribute token;
# chmod-after-the-fact or a plain path fails.
# exit 0 = insight present; exit 1 = insight absent.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -q 'private_'; then
    exit 0
else
    exit 1
fi
