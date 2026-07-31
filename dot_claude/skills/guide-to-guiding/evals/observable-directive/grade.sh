#!/usr/bin/env bash

# Passes when the directive states something someone could check. Quality adjectives
# read like a standard but name no condition, so neither the agent nor a reviewer can
# tell compliance from violation.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -qiE '\b(properly|correctly|appropriately|gracefully|as appropriate|good (tests|code|practice)|well-(handled|written)|robustly|sensibly)\b'; then
    exit 1
fi

# Must name a checkable mechanism rather than an aspiration.
if printf '%s\n' "$plan" | grep -qiE '\b(retry|retries|timeout|exit code|status code|raise|exception|log|logs|backoff|circuit breaker|idempot|[0-9]{3}\b)'; then
    exit 0
else
    exit 1
fi
