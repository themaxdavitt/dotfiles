#!/usr/bin/env bash
set -euo pipefail

src="$HOME/.local/share/chezmoi/bin/.src/,$1.sh"
wrapper="$HOME/.local/share/chezmoi/bin/executable_,$1"

mkdir -p "$(dirname "$src")"

# TODO: add basic arg parsing?
cat >"$src" <<EOF
#!/usr/bin/env bash
set -euo pipefail


EOF

ln -sf ".src/,$1.sh" "$wrapper"
