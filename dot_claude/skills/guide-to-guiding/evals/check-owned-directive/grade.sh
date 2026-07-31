#!/usr/bin/env bash

# Passes when the typer directive is cut and the credential one is kept on the grounds
# that its damage outlives the edit. Both are lint-covered, so "a check already catches
# it" alone picks either — the discriminating question is whether editing the file the
# check named repairs the harm. For the leak it does not, which is what keeps that rule
# in always-loaded context.

set -euo pipefail

plan="$(cat)"

# The typer directive is the one that goes.
printf '%s\n' "$plan" | grep -qiE '(cut|drop|delet|remov|demot)' || exit 1
printf '%s\n' "$plan" | grep -qiE 'typer|argparse' || exit 1

# Cutting the credential directive instead — or as well — is the failure this case exists
# to catch.
if printf '%s\n' "$plan" | grep -qiE '(cut|drop|delet|remov)[^.]{0,60}(credential|secret)'; then
    exit 1
fi

# It must survive, and for the right reason: the harm is not undone by editing the file.
printf '%s\n' "$plan" | grep -qiE '(keep|kept|retain|stay|remain|preserv|surviv)' || exit 1
printf '%s\n' "$plan" | grep -qiE 'rotat|irreversib|cannot be undone|can.t be undone|already (leak|expos|commit)|after the (fact|damage)|too late|prevent' || exit 1
