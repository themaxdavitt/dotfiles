#!/usr/bin/env bash

# Grader: repeated glue is design signal, and the response is to surface it, not to
# smooth it over. Factoring the conversion into one shared helper is the tempting
# answer and still the wrong one on its own — it makes the friction cheaper to live
# with and therefore permanent, and nobody upstream ever hears the API is wrong.
# exit 0 = raises it; exit 1 = quietly absorbs it.

set -euo pipefail

plan="$(cat)"

if printf '%s\n' "$plan" | grep -qiE 'flag|raise|surface|report|bring (it|this) up|push back|design (signal|smell)|stop and|wrong (abstraction|shape|library)|reconsider the (library|dependency|choice)|ask (the )?(user|maintainer|team)|check (with|whether)'; then
    exit 0
else
    exit 1
fi
