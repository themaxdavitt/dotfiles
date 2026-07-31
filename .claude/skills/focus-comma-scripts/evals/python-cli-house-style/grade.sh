#!/usr/bin/env bash

# Passes when the CLI is built the way every other Python command here is, so the
# comma name survives into `--help` output instead of showing the source filename.

set -euo pipefail

plan="$(cat)"

# argparse and click are the two the house style rules out.
if printf '%s\n' "$plan" | grep -qE '\bimport argparse\b|\bimport click\b'; then
    exit 1
fi

printf '%s\n' "$plan" | grep -qE '\btyper\b' || exit 1

if printf '%s\n' "$plan" | grep -qE 'prog_name'; then
    exit 0
else
    exit 1
fi
