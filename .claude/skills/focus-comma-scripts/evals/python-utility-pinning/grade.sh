#!/usr/bin/env bash

# Grader: Python `,`-scripts are PEP 723 `uv run --script` files pinned with
# `exclude-newer` under [tool.uv]. Require that pinning token; an unpinned
# PEP 723 block or a plain script fails.
# exit 0 = insight present; exit 1 = insight absent.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -q 'exclude-newer'; then
    exit 0
else
    exit 1
fi
