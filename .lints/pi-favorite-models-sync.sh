#!/usr/bin/env bash

# Check that agent_servers.pi.favorite_models in the Zed settings matches enabledModels in dot_pi/agent/settings.json.

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(realpath "$script_dir"/..)"

zed_settings="dot_config/zed/private_settings.json.literal"
pi_settings="dot_pi/agent/settings.json"

failed=0

arg_to_relpath() {
  local arg="$1"

  case "$arg" in
    "$repo_root"/*) printf '%s\n' "${arg#"$repo_root"/}" ;;
    /*) return 1 ;;
    ./*) printf '%s\n' "${arg#./}" ;;
    *) printf '%s\n' "$arg" ;;
  esac
}

triggered=0
for arg in "$@"; do
  relpath="$(arg_to_relpath "$arg")" || continue
  case "$relpath" in
    "$zed_settings" | "$pi_settings") triggered=1; break ;;
  esac
done

[[ "$triggered" -eq 1 ]] || exit 0

extract_zed_models() {
  python3 -c "
import re, json, sys
content = open(sys.argv[1]).read()
content = re.sub(r'//[^\n]*', '', content)
content = re.sub(r',\s*([}\]])', r'\1', content)
data = json.loads(content)
for m in sorted(data['agent_servers']['pi']['favorite_models']):
    print(m)
" "$1"
}

zed_models="$(extract_zed_models "$repo_root/$zed_settings")"
pi_models="$(jq -r '.enabledModels | sort[]' "$repo_root/$pi_settings")"

if [[ "$zed_models" != "$pi_models" ]]; then
  printf '%s: favorite_models out of sync with %s enabledModels\n' "$zed_settings" "$pi_settings"
  failed=1
fi

exit "$failed"
