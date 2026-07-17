#!/usr/bin/env bash

# Grader: the skill says to carry repeated links as Markdown reference-style
# links with definitions at the bottom of the file. The prompt supplies three
# URLs that several rules need, baiting repeated inline links. Desired
# behavior: at least two reference-style link definitions ("[label]: url").
# exit 0 = insight present; exit 1 = insight absent.

set -euo pipefail

plan="$(cat)"

defs=$(printf '%s\n' "$plan" | grep -cE '^\[[^]]+\]:[[:space:]]+\S' || true)

if [ "$defs" -ge 2 ]; then
    exit 0
else
    exit 1
fi
