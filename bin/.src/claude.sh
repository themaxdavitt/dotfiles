#!/usr/bin/env bash
set -e

exec ,sb claude --dangerously-skip-permissions "$@"
