#!/usr/bin/env bash

# Type-check PEP 723 scripts with ty using the Python and dependencies declared in each script. Workaround for astral-sh/ty#691.

set -o errexit
set -o nounset
set -o pipefail

if [ "$#" -eq 0 ]; then
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

for script in "$@"; do
  req="$(mktemp "$tmp/requirements.txt.XXXXXX")"
  python="$(uv python find --script "$script")"
  exclude_newer_file="$(mktemp "$tmp/exclude-newer.XXXXXX")"

  "$python" - "$script" >"$exclude_newer_file" <<'PY'
import re
import sys
import tomllib

metadata = []
in_script_block = False
for line in open(sys.argv[1], encoding="utf-8"):
  if not in_script_block:
    if re.fullmatch(r"# /// script\s*", line):
      in_script_block = True
    continue
  if re.fullmatch(r"# ///\s*", line):
    break
  if not line.startswith("#"):
    raise SystemExit(f"invalid PEP 723 metadata line: {line.rstrip()}")
  body = line[1:]
  if body.startswith(" "):
    body = body[1:]
  metadata.append(body)

data = tomllib.loads("".join(metadata))
print(data.get("tool", {}).get("uv", {}).get("exclude-newer", ""))
PY
  exclude_newer="$(<"$exclude_newer_file")"

  export_args=(
    export
    --script "$script"
    --python "$python"
    --format requirements.txt
    --no-header
    --no-annotate
    --no-hashes
    --output-file "$req"
  )
  run_args=(
    run
    --python "$python"
    --with-requirements "$req"
  )

  if [ -n "$exclude_newer" ]; then
    export_args+=(--exclude-newer "$exclude_newer")
    run_args+=(--exclude-newer "$exclude_newer")
  fi

  uv -q "${export_args[@]}"

  uv -q "${run_args[@]}" python - "$script" <<'PY'
import pathlib
import subprocess
import sys

extra = []
seen = set()
for raw in sys.path:
  path = pathlib.Path(raw or ".").resolve()
  if path.name == "site-packages" and path.is_dir() and path not in seen:
    seen.add(path)
    extra.extend(["--extra-search-path", str(path)])

raise SystemExit(
  subprocess.run(
    ["ty", "check", "--python", sys.executable, *extra, *sys.argv[1:]],
  ).returncode,
)
PY
done
