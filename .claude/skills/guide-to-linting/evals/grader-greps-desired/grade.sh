#!/usr/bin/env bash

# Passes when the produced grader tests for the wanted behaviour being present,
# rather than failing on any appearance of the anti-pattern. A model that follows
# the guidance routinely names the forbidden form in order to reject it, so a
# grader that greps for "latest" alone marks the best answers wrong.

set -euo pipefail

plan="$(cat)"

# Must actually look for the desired shape (an explicit version), not only the
# forbidden string.
if ! printf '%s\n' "$plan" | grep -qE '[0-9]\]|\[0-9\]|version|semver|[0-9]+\\\.'; then
    exit 1
fi

# A bare "contains 'latest' -> fail" with no positive check is the failure mode.
if printf '%s\n' "$plan" | grep -qiE 'grep -[a-z]*q[a-z]* .{0,12}latest' \
    && ! printf '%s\n' "$plan" | grep -qiE 'grep -[a-z]*q[a-z]* .{0,20}[0-9]'; then
    exit 1
fi

exit 0
