#!/usr/bin/env bash

# Grader: non-actionable background either rides inside the directive it serves or
# gets cut. Filing it under references/ looks tidy and is the failure mode — a
# reference file carries specs, upstream docs, and long templates, not prose that
# failed to earn a rule, where it goes unread and unchecked.
# exit 0 = insight present; exit 1 = insight absent.

set -euo pipefail

plan="$(cat)"

# Routing the background into a side file is the wrong answer, however it is dressed.
if printf '%s\n' "$plan" | grep -qiE '(reference|separate|companion|supplementary|background|context)[[:space:]-]?(file|doc|document|page|md)|references/|assets/'; then
    exit 1
fi

# Right answer: attach it to the rule it serves, or drop it.
if printf '%s\n' "$plan" | grep -qiE 'fold|inline|attach|inside the (directive|rule|bullet)|within the (directive|rule)|alongside the (directive|rule)|cut|drop|omit|delete|leave (it )?out|discard|does not earn|has not earned'; then
    exit 0
else
    exit 1
fi
