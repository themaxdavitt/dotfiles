#!/usr/bin/env bash

# Grader: the skill keeps design philosophy to ONE succinct opening paragraph
# and makes everything after it directive bullets under short headings. The
# prompt's "include the reasoning" invites essay prose between the rules.
# Desired structure: at least two directive-token bullets and at most one
# prose paragraph block (outside frontmatter and code fences).
# exit 0 = insight present; exit 1 = insight absent.

set -euo pipefail

plan="$(cat)"

# Unwrap a single outer ```/```markdown fence if the whole answer is inside one.
body="$(printf '%s\n' "$plan" | awk '
    NR == 1 && /^```/ { wrapped = 1; next }
    wrapped && /^```[[:space:]]*$/ { last = NR; next }
    { lines[NR] = $0 }
    END {
        for (i = 1; i <= NR; i++)
            if (i in lines && !(wrapped && i > last && last)) print lines[i]
    }
')"

tokened=$(printf '%s\n' "$body" | grep -cE '^[[:space:]]*- (ALWAYS|NEVER):' || true)

prose=$(printf '%s\n' "$body" | awk '
    NR == 1 && /^---$/ { fm = 1; next }
    fm { if (/^---$/) fm = 0; next }
    /^```/ { fence = !fence; inblock = 0; next }
    fence { next }
    /^[[:space:]]*$/ { inblock = 0; next }
    /^[[:space:]]*(#|-|\*|[0-9]+\.|\[|>|\|)/ { inblock = 0; next }
    { if (!inblock) count++; inblock = 1 }
    END { print count + 0 }
')

if [ "$tokened" -ge 2 ] && [ "$prose" -le 1 ]; then
    exit 0
else
    exit 1
fi
