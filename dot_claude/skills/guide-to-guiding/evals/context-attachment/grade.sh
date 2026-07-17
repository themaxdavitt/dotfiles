#!/usr/bin/env bash

# Grader: the skill says never to write context-only top-level bullets —
# background rides inside the directive it serves. The notes bait a
# standalone "the payments module is legacy..." context bullet. Desired
# behavior: at least two directive-token bullets, no token-less top-level
# bullet, and the legacy-module context preserved somewhere (not dropped).
# This checks the structure of the model's own output, not mentions of an
# anti-pattern. exit 0 = insight present; exit 1 = insight absent.

set -euo pipefail

plan="$(cat)"

tokened=$(printf '%s\n' "$plan" | grep -cE '^- (ALWAYS|NEVER):' || true)
bare=$(printf '%s\n' "$plan" | grep -cE '^- ' || true)

if [ "$tokened" -ge 2 ] && [ "$bare" -eq "$tokened" ] &&
    printf '%s\n' "$plan" | grep -qiE 'legacy|service split|no owner'; then
    exit 0
else
    exit 1
fi
