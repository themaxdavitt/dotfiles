#!/usr/bin/env bash
set -euo pipefail

bin="$(mise which gh)"

GH_TOKEN="$(ghtkn get)" exec $bin "$@"
