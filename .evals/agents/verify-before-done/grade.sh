#!/usr/bin/env bash

# Passes when the answer runs the check that owns a template change and reports
# what it produced, rather than reasoning from the source. Reading a template is
# not evidence that it renders.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -qiE 'chezmoi (diff|cat|execute-template)|render(ed|ing)? (it|the (file|template|output))|dry.?run'; then
    exit 0
else
    exit 1
fi
