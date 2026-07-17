#!/usr/bin/env bash
set -e

exec sandbox-exec -f "$(safehouse --enable=all-agents)" -- pi "$@"
