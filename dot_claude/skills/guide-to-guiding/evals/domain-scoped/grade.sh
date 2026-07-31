#!/usr/bin/env bash

# Passes when the SQL rule does not survive into a document about Git conventions.
# It reads as sound advice, which is what makes it the tempting one to keep — and
# an off-topic rule spends budget and dilutes the file it sits in.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -qiE 'parameteris|parameteriz|user-supplied string'; then
    # Naming it in order to exclude it is the correct answer.
    if printf '%s\n' "$plan" | grep -qiE '(drop|omit|exclude|leave out|remove|does not belong|belongs in|out of scope|not (a )?git)'; then
        exit 0
    fi
    exit 1
fi

# Must still have produced the section rather than refusing.
if printf '%s\n' "$plan" | grep -qiE 'imperative|rebase|ticket'; then
    exit 0
else
    exit 1
fi
