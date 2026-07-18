#!/usr/bin/env bash
set -euo pipefail

NEW_TMPDIR="/tmp/.dotfiles/.dotfiles-,sb-$RANDOM"
NEW_RUNDIR="$NEW_TMPDIR-run"
mkdir -p "$NEW_TMPDIR" "$NEW_RUNDIR"

cleanup() {
  rm -rf "$NEW_TMPDIR"
}

trap cleanup EXIT


# The PATH stuff is mostly just to prevent unintentional misuse

# "$(dirname "$(mise which cs)")"
# "$(dirname "$(mise which rg)")"
# "$(dirname "$(mise which scc)")"
# "$(dirname "$(mise which opengrep)")"

NEW_PATHS=(
  "$(dirname "$(mise which "$1")")"
  "$(dirname "$(mise which gh)")"
  ~/bin
  "$(dirname "$(mise which aube)")"
  "$(dirname "$(mise which uv)")"
  "$(dirname "$(mise which nono)")"
  "$(dirname "$(mise which node)")"
  "$(dirname "$(mise which python)")"
  "$(dirname "$(mise which rg)")"
  "$(dirname "$(mise which fd)")"
  "$(dirname "$(mise which agent-browser)")"
  "/usr/bin"
  "/bin"
  "/usr/sbin"
  "/sbin"
)
NEW_PATH="$(
  IFS=:
  echo "${NEW_PATHS[*]}"
)"
READ_ARGS=()
for str in "${NEW_PATHS[@]}"; do
  READ_ARGS+=(--read "$str")
done

TMPDIR="$NEW_TMPDIR" XDG_RUNTIME_DIR="$NEW_RUNDIR" \
  fnox exec --profile "$1" \
    nono run --profile "$1" \
      --allow-cwd \
      --trust-proxy-ca \
      "${READ_ARGS[@]}" \
      --silent -- \
        env \
          PATH="$NEW_PATH" \
          AGENT_BROWSER_ARGS="--no-sandbox" \
          "$@"
