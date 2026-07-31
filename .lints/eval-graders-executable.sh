#!/usr/bin/env bash

# Require passed eval grader scripts (evals/<case>/grade.sh and .evals/<name>/<case>/grade.sh) to have the executable bit set, since `,llint`'s eval/ablate/compress/compile exec them directly.

set -euo pipefail

failed=0

for arg in "$@"; do
  [[ -f "$arg" ]] || continue

  if [[ ! -x "$arg" ]]; then
    printf '%s: grader is not executable (,llint improve execs it directly); run chmod +x\n' "$arg"
    failed=1
  fi
done

exit "$failed"
