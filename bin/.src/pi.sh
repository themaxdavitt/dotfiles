#!/usr/bin/env bash

# Guard wrapper for pi: warn if this repo has project-local inputs that pi may
# still read or migrate before its normal trust gate, then exec the real binary.

# TODO: mention in skill to check whether or not this is relevant when updating pi

set -euo pipefail

findings=()

if [[ -d .pi ]]; then
  if [[ -f .pi/settings.json ]]; then
    keys=()
    jq -e 'has("sessionDir")' .pi/settings.json >/dev/null && keys+=("sessionDir")
    jq -e 'has("theme")' .pi/settings.json >/dev/null && keys+=("theme")

    if ((${#keys[@]} > 0)); then
      findings+=(".pi/settings.json: mentions pre-trust startup keys (${keys[*]})")
    else
      findings+=(".pi/settings.json: exists and is read before trust")
    fi
  fi

  [[ -e .pi/commands ]] && findings+=(".pi/commands: startup migration may rename this to .pi/prompts before trust")
  [[ -e .pi/hooks ]] && findings+=(".pi/hooks: startup scans this deprecated directory before trust")
  [[ -e .pi/tools ]] && findings+=(".pi/tools: startup scans this deprecated directory before trust")
fi

if ((${#findings[@]} > 0)); then
  echo "dotfiles: suspicious pre-trust inputs found in $(pwd)" >&2
  for finding in "${findings[@]}"; do
    echo "  - $finding" >&2
  done
  echo "(these checks happen before pi's normal trust prompt in v0.79.0)" >&2
  [[ -t 0 ]] || {
    echo "refusing to continue without an interactive terminal" >&2
    exit 1
  }
  read -r -p "start pi anyway? [y/N] " answer
  [[ "$answer" =~ ^[Yy]([Ee][Ss])?$ ]] || exit 1
fi

# nono regenerates its self-signed proxy CA every few days, and the first
# --trust-proxy-ca run after that pops a macOS keychain prompt. Warm it here so
# the prompt lands at launch instead of mid-session inside the TUI. The
# gatekeeper extension repeats this at session_start for launches that skip
# this wrapper; here is better, because the TUI does not own the terminal yet.
# (cd /tmp: --allow-cwd is refused for $HOME, which overlaps nono's state root.)
#
# GH_TOKEN isn't fetched yet, so nono warns about the github credential route on
# every launch. Drop just those lines rather than redirecting everything to
# /dev/null: a real CA failure explains itself in the output, and stdout stays
# on the terminal so an interactive nono prompt is still readable.
nono_warmup_noise='(Proxy credential warnings:|credential_not_found |Looked for env var )'
(cd /tmp && nono run --profile pi-tools --allow-cwd --trust-proxy-ca --silent -- /usr/bin/true) \
  2> >(grep -Ev "$nono_warmup_noise" >&2) ||
  echo "dotfiles: nono proxy-CA warm-up failed; sandboxed bash may misbehave" >&2

# Pi itself runs UNSANDBOXED: the gatekeeper extension wraps each unprivileged
# bash call in `nono run --profile pi-tools` and profile-gates the file tools
# instead (running pi inside an outer sandbox would let sandboxed bash reach
# any escape channel the extension can reach). fnox injects DATALAB_API_KEY for
# `,doc2md`; pi's OpenRouter key is no longer among them, since its browser login
# stores one in ~/.pi/agent/auth.json, which the sandbox denies reads of anyway.
# GH_TOKEN stays in pi's env for nono's github credential proxy, which hands
# tool calls a placeholder. `mise which` pins plannotator's resolution and
# dodges re-resolving `pi` to this wrapper.
GH_TOKEN="$(ghtkn get "themaxdavitt/none")" PI_OFFLINE=true PI_TELEMETRY=false \
  SESSION_PLANNER_PLANNOTATOR_BIN="$(mise which plannotator)" \
  exec fnox exec --profile pi -- "$(mise which pi)" "$@"
