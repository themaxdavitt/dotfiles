#!/usr/bin/env bash

# Grader: third-party data is not committed; it is fetched at runtime from an
# immutable pinned URL and its digest asserted before use, so the pin is
# enforced rather than assumed. Checking in the file, or downloading it with no
# integrity check, both fail. Require an explicit digest check — that is the
# part a model will not volunteer without the house rule.
# exit 0 = insight present; exit 1 = insight absent.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -qiE 'sha-?256|checksum|digest|shasum'; then
    exit 0
else
    exit 1
fi
