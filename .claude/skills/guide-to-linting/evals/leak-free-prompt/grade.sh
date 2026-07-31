#!/usr/bin/env bash

# Grader: the authored task text states a situation and withholds the answer. Rule
# language ("must", "never") or a rationale clause ("because…") reaches the
# WITHOUT-guidance run too, lifting its baseline until real guidance measures as
# redundant — the one verdict that gets guidance deleted.
# Deliberately rule-agnostic: the prompt names no directive, so this catches a leak
# of whichever directive the model picked rather than of one hard-coded rule. That
# also keeps the case from tripping `prompt-leaks-solution` on its own prompt, which
# a rule-specific framing cannot avoid — naming the rule IS the leak it flags.
# exit 0 = leak-free task text; exit 1 = leaks.

set -euo pipefail

plan="$(cat)"

# Directive language transplanted into the task hands over the answer.
if printf '%s\n' "$plan" | grep -qE '\b(ALWAYS|NEVER)\b' || printf '%s\n' "$plan" | grep -qiE '\b(must|never|always|should|required to|make sure to)\b'; then
    exit 1
fi

# So does explaining why the right answer is right.
if printf '%s\n' "$plan" | grep -qiE '\b(because|so that|in order to|the reason)\b'; then
    exit 1
fi

# It still has to pose a real, concrete task rather than refuse or go abstract.
if printf '%s\n' "$plan" | grep -qiE '\byou\b|\byour\b'; then
    exit 0
else
    exit 1
fi
