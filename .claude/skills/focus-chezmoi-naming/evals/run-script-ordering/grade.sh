#!/usr/bin/env bash

# Grader: chezmoi applies entries within a directory in lexical order and
# `after_` orders a script against its containing directory, not its siblings —
# so a script must reach its inputs through the source tree rather than the
# deployed path it races. Require the `.chezmoi.sourceDir` token; a script
# pointing at ~/.local/share/dotfiles/widget/build.js fails.
# exit 0 = insight present; exit 1 = insight absent.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -qF '.chezmoi.sourceDir'; then
    exit 0
else
    exit 1
fi
