#!/usr/bin/env bash
set -euo pipefail

src="$HOME/.local/share/chezmoi/bin/.src/,$1.py"
wrapper="$HOME/.local/share/chezmoi/bin/executable_,$1"

mkdir -p "$(dirname "$src")"

cat >"$src" <<EOF
#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.14"
# dependencies = []
# [tool.uv]
# exclude-newer = "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
# ///

import argparse


def main():
  parser = argparse.ArgumentParser(",$1")
  args = parser.parse_args()


if __name__ == "__main__":
  main()


EOF

ln -sf ".src/,$1.py" "$wrapper"
