#!/usr/bin/env bash

# Grader: fnox rewrites its own deployed config at runtime to cache age sync state,
# so re-applying the managed copy clobbers that state. Permissions get fixed on the
# live file directly. Reaching for `chezmoi apply` is the trained-in reflex for any
# deployed-file problem and is exactly wrong here, so it fails outright.
# exit 0 = insight present; exit 1 = insight absent.

set -euo pipefail

plan="$(cat)"

# A good answer names `chezmoi apply` precisely to rule it out, so split into clauses
# and drop the ones carrying a negation or contrast cue first. Without this, saying
# "chmod it, since re-applying would clobber the cache" — the ideal answer — fails on
# the word it uses to reject the wrong one.
affirmative="$(printf '%s\n' "$plan" | tr '.;,' '\n' |
    grep -viE "\b(not|never|avoid|instead|rather than|clobber(s|ed|ing)?|overwrite(s|d)?|destroy(s|ed)?|don't|do not|would)\b")"

# Applying the managed copy destroys the runtime state, so proposing it fails.
if printf '%s\n' "$affirmative" | grep -qiE 'chezmoi apply|re-?apply|chezmoi add|apply the (managed|source)'; then
    exit 1
fi

if printf '%s\n' "$plan" | grep -qiE 'chmod|600|owner-only.{0,40}(directly|live|in place)|directly on the (live|deployed) file'; then
    exit 0
else
    exit 1
fi
