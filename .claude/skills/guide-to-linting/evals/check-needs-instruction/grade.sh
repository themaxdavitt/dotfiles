#!/usr/bin/env bash

# Passes when the delivery includes the authoring side, not just the grader. A rule
# that demands something no guidance file teaches fails work nobody was told how to
# pass, and the author has no way to learn the standard except by tripping it.

set -euo pipefail

plan="$(cat)"

# Must actually produce the rule.
printf '%s\n' "$plan" | grep -qiE 'rule|\.md|frontmatter|tests:' || exit 1

if printf '%s\n' "$plan" | grep -qiE '(directive|guidance|skill|AGENTS\.md|SKILL\.md)[^.]{0,80}(add|state|say|tell|document|cover)|(add|state|write)[^.]{0,60}(directive|guidance)'; then
    exit 0
else
    exit 1
fi
