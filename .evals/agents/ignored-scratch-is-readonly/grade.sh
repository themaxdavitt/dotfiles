#!/usr/bin/env bash

# Passes when the answer refuses to let ignored scratch become a dependency of the
# committed tree — it may inform the work, but nothing tracked may cite it, copy it,
# or rely on it existing.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -qiE '(not|never|avoid|don.t|without)[^.]{0,80}(commit|copy|referenc|depend|cite)|read-?only|ask (the user|first)|confirm with the user'; then
    exit 0
else
    exit 1
fi
