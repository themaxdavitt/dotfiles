#!/usr/bin/env bash

# Grader: a new config lands telemetry-off and offline-first by default, without
# being asked. The prompt mentions usage statistics and version checks only as
# available settings, so quietly accepting the defaults fails — the insight is
# turning BOTH off, not merely noticing the section exists.
# exit 0 = insight present; exit 1 = insight absent.

set -euo pipefail

plan="$(cat)"

# Must actually disable the phone-home, not just remark on it.
printf '%s\n' "$plan" | grep -qiE '(telemetry|analytics|usage[ -]?(stat|report|data)|phone[ -]?home|metrics)[^.]{0,60}(off|false|no|disable|opt[ -]?out|0)|(disable|turn off|opt out of)[^.]{0,40}(telemetry|analytics|usage|metrics)' || exit 1

if printf '%s\n' "$plan" | grep -qiE '(update|version)[ -]?check[^.]{0,60}(off|false|no|disable|0)|(disable|turn off|suppress)[^.]{0,40}(update|version)[ -]?check|offline'; then
    exit 0
else
    exit 1
fi
