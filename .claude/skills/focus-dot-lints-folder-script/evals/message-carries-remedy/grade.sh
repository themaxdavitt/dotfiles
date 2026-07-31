#!/usr/bin/env bash

# Passes when the failure line states the action, not merely the absence. The directive
# that used to carry the rule has been deleted, so this line is the only place it still
# exists — "missing .chezmoi.sourceDir reference" names the violation and leaves the
# reader to guess the repair.

set -euo pipefail

plan="$(cat)"

# Keep the repo's `path: reason` shape, naming the offending file.
printf '%s\n' "$plan" | grep -qE 'run_after_deps\.sh:' || exit 1

# Name the remedy: an imperative pointing at sourceDir, rather than sourceDir trailing a
# bare "missing"/"lacks"/"has no".
printf '%s\n' "$plan" | grep -qiE '(add|use|include|pass|set|reference|refer to)[^:]{0,60}sourceDir' || exit 1
