#!/usr/bin/env bash

# Grader: a durable fact about a repo belongs in that repo's own guidance, where
# other agents, other checkouts, and the duplicate-detection over guidance can all
# see it. Filing it only in a private note store hides it from every one of those,
# and the next agent rediscovers it the same way — by breaking something.
# exit 0 = insight present; exit 1 = insight absent.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -qiE 'AGENTS\.md|CLAUDE\.md|CONTRIBUTING|README|guidance file|skill file|(repo|project|in)[- ]?(guidance|docs|documentation)|document it in the (repo|project)|commit[^.]{0,30}(note|doc|guidance|warning)|check(ed)? (it )?in'; then
    exit 0
else
    exit 1
fi
