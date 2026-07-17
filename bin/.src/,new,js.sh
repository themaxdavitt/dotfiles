#!/usr/bin/env bash
set -euo pipefail

src="$HOME/.local/share/chezmoi/bin/.src/,$1.js"
wrapper="$HOME/.local/share/chezmoi/bin/executable_,$1"

mkdir -p "$(dirname "$src")"

# TODO: add basic arg parsing?
cat >"$src" <<EOF
#!/usr/bin/env -S mise x deno@2 -- deno run --ext=js --minimum-dependency-age=$(date -u +"%Y-%m-%dT%H:%M:%SZ")


EOF

ln -sf ".src/,$1.js" "$wrapper"
