#!/usr/bin/env bash
set -euo pipefail

TAP="$1"

DIR=$(brew tap-info "$TAP" --json | jq -r '.[0].path')
exec "$EDITOR" "$DIR"
