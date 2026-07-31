#!/usr/bin/env bash
set -e

# TODO: figure out how I can make some/all of this run automatically using some chezmoi filename magic, e.g. https://www.chezmoi.io/user-guide/machines/macos/ tho maybe figure out how sequencing should work with mise's bootstrap feature in the mix now
# TODO: instead, actually, maybe make this zshrc-only?

lock() {
  bwbio lock
}

trap lock EXIT

# TODO: bail if can't be unlocked via bio
BW_SESSION="$(bwbio unlock --raw)"

# Render the full preview BEFORE paging it: chezmoi v2.70.2 deadlocks if the
# pager quits while the (rbw-stall-prone) diff stream is still being written,
# which silently ate the confirmation prompt below.
diff_file="$(mktemp -t cza-diff)"
remove_diff() {
  rm -f "$diff_file"
  lock
}
trap remove_diff EXIT

echo "rendering diff (may pause for Bitwarden)..." >&2
BW_SESSION="$BW_SESSION" chezmoi apply --dry-run --verbose --force --no-pager > "$diff_file"

# Pager exit is deliberately ignored: quitting early must not skip the prompt.
LESS='KR' delta < "$diff_file" || true

read -p "are you sure? " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  exit 0
fi

# Keep cruft at bay... a little
# TODO: something smarter
find "$HOME/bin" -maxdepth 1 -type f -name ",*" -exec rm {} +

BW_SESSION="$BW_SESSION" chezmoi apply --force

# -C "$HOME" on every mise call below: these are global operations, but mise
# still loads the config in the *invocation* cwd, and an untrusted or malformed
# project mise.toml then aborts the whole command. Running `,cza` from a repo
# whose mise.toml just changed would otherwise die here — after the apply above
# has already landed, but before the lock, install, and fnox sync below.
tools_json=$(mise -C "$HOME" ls -gm --json)
mapfile -t tools < <(jq -r 'to_entries[] | "\(.key)@\(.value[0].requested_version)"' <<<"$tools_json")
mapfile -t new_tools < <(python3 -c "
import tomllib, sys, os
lockfile = os.path.expanduser('~/.config/mise/mise.lock')
try:
        with open(lockfile, 'rb') as f:
                tools = tomllib.load(f).get('tools', {})
        locked = {f'{k}@{v[0][\"version\"]}' for k, v in tools.items()}
except FileNotFoundError:
        locked = set()
for tool in sys.stdin.read().splitlines():
        if tool and tool not in locked:
                print(tool)
" <<<"$(printf '%s\n' "${tools[@]}")")

if [[ ${#new_tools[@]} -gt 0 ]]; then
  echo locking "${new_tools[@]}" >&2
  mise -C "$HOME" lock --global "${new_tools[@]}"
fi

if [[ ${#tools[@]} -gt 0 ]]; then
  echo installing "${tools[@]}" >&2
  mise -C "$HOME" install --locked "${tools[@]}"
  chezmoi add "$HOME/.config/mise/mise.lock"
fi

cd "$HOME"/.config/fnox
export BW_SESSION="$BW_SESSION"

fnox sync --global --provider age --force

profiles=("pi")

for profile in "${profiles[@]}"
do
  fnox sync --global --profile "$profile" --provider age --force
done
