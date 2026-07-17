#!/usr/bin/env bash

# Grader: check that the consumer proposes with/without ablation (cross-review
# of observed behavior) rather than asking a model to introspect.
# exit 0 = insight present; exit 1 = insight absent.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -qiE '(with(out)? the (skill|guidance|directive)|ablat|compare[sd]? (the )?(output|response|behavior)|two (runs|conditions|variants)|a/b test)'; then
    exit 0
else
    exit 1
fi
