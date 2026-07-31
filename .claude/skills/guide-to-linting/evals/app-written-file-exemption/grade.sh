#!/usr/bin/env bash

# Passes when both exemptions land in the tools' own ignore mechanisms rather
# than the `exclude` list the prompt dangles. `.prettierignore` is the
# discriminating token: oxfmt ships no ignore file under its own name, so
# nothing but the guidance says that is where its exclusions go.
#
# Deliberately silent about `hk.pkl` — an answer that explains why `exclude` is
# the weaker choice is a guidance-loaded answer, so matching against it would
# punish exactly the runs that absorbed the directive.

set -euo pipefail

answer="$(cat)"

printf '%s\n' "$answer" | grep -qF '.prettierignore' || exit 1
printf '%s\n' "$answer" | grep -qF '.editorconfig' || exit 1
