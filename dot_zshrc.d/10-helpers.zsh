# shellcheck shell=ksh
# -*- mode: bash -*-

# TODO: assign this file to a diff number probably

export HOMEBREW_BAT=1
export HOMEBREW_BUNDLE_NO_UPGRADE=1
export HOMEBREW_DISPLAY_INSTALL_TIMES=1
export HOMEBREW_NO_ANALYTICS=1
export HOMEBREW_NO_INSECURE_REDIRECT=1
export HOMEBREW_NO_INSTALL_UPGRADE=1
export HOMEBREW_NO_UPGRADE_AUTO_UPDATES_CASKS=1

,priv-ip () {
  ipconfig getiflist | xargs -n1 ipconfig getifaddr
}

,pub-ip () {
  curl --fail-with-body -sS --proto '=https' --tlsv1.2 \
    "https://ipv4.icanhazip.com"
}

# Fancy `git log`
# TODO: maybe use this for fzf preview
,gl () {
  # TODO: figure out if i should actually have this `shellcheck disable` bit here
  # shellcheck disable=2046
  local stash_refs
  stash_refs=$(git reflog show --format="%h" stash 2>/dev/null || true)
  # shellcheck disable=2086
  git log -n 10 --graph --abbrev-commit --decorate --format=format:'%C(bold blue)%s%C(reset)%C(auto)%d%C(reset) %C(dim white)~%cr%C(reset)%n''%C(white)%an <%ae> (%G?)%C(reset) %C(dim blue)#%h%C(reset)' --all $stash_refs
}

# https://max.davitt.me/blog/fix-sounds-cut-off-over-bluetooth/
,fix-bt () {
  ffplay -nodisp -f lavfi -i anullsrc=r=44100:cl=stereo
}

# TODO: figure out theming for these
export BAT_PAGER="less -KR"
export DELTA_PAGER="less -KR"

# FYI: you don't need `compdef` for aliases
# try to keep in sync with fzf-preview
alias ..='cd ..'
alias ,l='ls -AGp'
alias ,ll='ls -AGhlpt'

# try to keep our special stuff exposed as either `,`-prefixed or an alias over an actual command
alias ls='ls -AGp'
alias mkdir='mkdir -pv'
alias cat='bat'
