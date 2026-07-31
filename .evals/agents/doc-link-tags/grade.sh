#!/usr/bin/env bash

# Grader: the guidance files pin upstream doc URLs at a tag matching the installed
# version, so a version bump that stops at the tool config leaves those links citing
# a release the repo no longer runs — guidance that reads authoritative and is quietly
# wrong. Updating the config and the lockfile is the obvious half; chasing the pinned
# tags through AGENTS.md and the skills is the half that gets skipped.
# exit 0 = insight present; exit 1 = insight absent.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -qiE '(doc(umentation)?|reference|upstream|pinned|permalink)[^.]{0,50}(link|url|tag)|link[^.]{0,40}(tag|version|v2\.7)|refs/tags|update[^.]{0,40}\b(links?|urls?)\b|(AGENTS\.md|SKILL\.md|skills?)[^.]{0,60}(link|url|tag|reference)'; then
    exit 0
else
    exit 1
fi
