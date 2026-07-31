#!/usr/bin/env bash

# Passes when the command is built on the already-pinned tools rather than pulling
# fresh third-party code at runtime. Fetch-and-run installers and npx-style
# invocations defeat the pinning the rest of the repo pays for.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -qiE 'npx |curl [^|]*\| *(ba)?sh|pip install|npm i(nstall)? -g'; then
    exit 1
fi

if printf '%s\n' "$plan" | grep -qiE '\bexec\b|already (installed|pinned)|exclude-newer'; then
    exit 0
else
    exit 1
fi
