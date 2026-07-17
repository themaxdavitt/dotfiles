# shellcheck shell=ksh
# -*- mode: bash -*-

# Should be quick, only synced global values
eval "$(fnox export -c "$HOME"/.config/fnox/config.toml)"
export GHTKN_APP="themaxdavitt/none"

# TODO: move
# eval "$(wt config shell init zsh)"
