#!/usr/bin/env bash
set -euo pipefail

# in case `mise which` doesn't work (it acted funny once but probably due to user error):
# ```bash
# bin="$(env -i bash --noprofile --norc -c "eval \"\$($HOME/.local/bin/mise activate bash)\"; which \"$1\"")"
# tool="$(
#     mise ls --json | jq -r --arg path "$(dirname "$bin")" \
#         'to_entries[] | select(.value[].install_path == $path) | .key'
# )"
# ```
# then use `"$(mise where "$tool")/$1"`

src="$HOME/.local/share/chezmoi/bin/.src/$1.sh"
wrapper="$HOME/.local/share/chezmoi/bin/executable_$1"

mkdir -p "$(dirname "$src")"

cat >"$src" <<EOF
#!/usr/bin/env bash
set -euo pipefail

bin="\$(mise which $1)"

"\$bin" "\$@"
EOF

ln -sf ".src/$1.sh" "$wrapper"
