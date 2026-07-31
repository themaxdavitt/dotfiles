#!/usr/bin/env bash

# Passes when the script checks the paths it is handed rather than discovering its
# own. Hook config already filters by glob, so a self-scanning check re-walks the
# tree on every run and silently ignores the file selection it was given.

set -euo pipefail

plan="$(cat)"

# Collecting its own inputs is the fallback form, not the default one.
if printf '%s\n' "$plan" | grep -qE '\b(fd|find|rg --files)\b[^|]*\.toml|for f in \$\((fd|find)'; then
    exit 1
fi

if printf '%s\n' "$plan" | grep -qE '"\$@"|\$\{@\}|for [a-z_]+ in "\$@"'; then
    exit 0
else
    exit 1
fi
