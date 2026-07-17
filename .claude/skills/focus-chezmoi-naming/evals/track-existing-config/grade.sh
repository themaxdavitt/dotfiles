#!/usr/bin/env bash

# Grader: `~/.config/...` maps to a `dot_config/...` source path. Require
# that attribute-encoded path; a literal `.config/` source path or vague
# "chezmoi add" without the resulting name fails.
# exit 0 = insight present; exit 1 = insight absent.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -q 'dot_config/wezterm'; then
    exit 0
else
    exit 1
fi
