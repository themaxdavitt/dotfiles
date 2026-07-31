#!/usr/bin/env bash

# Grader: the objection is answered by the failure message, not by restoring the
# directive. Re-adding it undoes the deletion the change existed to make, and shipping
# a bare violation line leaves the rule stated nowhere at all. Pass iff the delivery
# puts the remedy in the check's own output and keeps the rule out of guidance.
# exit 0 = insight present; exit 1 = insight absent.

set -euo pipefail

plan="$(cat)"

# The message has to carry the fix.
printf '%s\n' "$plan" | grep -qiE '(failure|error|check|lint|violation)[^.]{0,40}(message|output|line)|message[^.]{0,40}(carr|state|name|explain|tell)' || exit 1
printf '%s\n' "$plan" | grep -qiE 'remedy|what to do|the fix|how to fix|corrective|action to take|says? what' || exit 1

# Restoring the directive is the wrong resolution — it undoes the deletion.
if printf '%s\n' "$plan" | grep -qiE '(re-?add|restore|put (it )?back|reinstate|keep) (the )?(directive|rule)[^.]{0,40}(guidance|AGENTS|SKILL)'; then
    exit 1
fi
