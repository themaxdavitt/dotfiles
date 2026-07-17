# shellcheck shell=ksh
# -*- mode: bash -*-

# shellcheck disable=2034
files=( ~/.zshrc.d/*.zsh )
if [[ -d ~/.zshrc.d ]]; then
  setopt null_glob
  # shellcheck disable=2068,2296
  for file in ${(n)files[@]}; do
    # shellcheck disable=1090
    source "$file"
  done
  unsetopt nullglob
  unset file
fi
