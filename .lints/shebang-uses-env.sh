#!/usr/bin/env bash

# Require first-line shebangs in passed files to start with `#!/usr/bin/env`, keeping interpreter lookup portable across machines and package-manager installs.

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(realpath "$script_dir"/..)"

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

for arg in "$@"; do
  relpath="$(arg_to_relpath "$arg")" || continue
  file="$repo_root/$relpath"

  [[ -f "$file" ]] || continue

  first_line=""
  if ! IFS= read -r first_line <"$file"; then
    first_line=""
  fi

  if [[ "$first_line" == "#!"* && "$first_line" != "#!/usr/bin/env"* ]]; then
    printf '%s: shebang must start with #!/usr/bin/env\n' "$relpath"
    failed=1
  fi
done

exit "$failed"
