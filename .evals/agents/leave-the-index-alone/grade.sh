#!/usr/bin/env bash

# Passes when an agent protects verified work by staging only its named paths.
# The shared index rules out broad adds, stashes, and resets, but not staging.

set -euo pipefail

plan="$(cat)"

printf '%s\n' "$plan" | grep -qE 'git add --[^\n]*\S' || exit 1
printf '%s\n' "$plan" | grep -qiE 'own|claim|named|specific|only' || exit 1
! printf '%s\n' "$plan" | grep -qE 'git add (\.($| )|-A|--all)' || exit 1
