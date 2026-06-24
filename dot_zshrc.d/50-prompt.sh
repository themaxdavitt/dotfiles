# shellcheck shell=ksh

set -o pipefail
HISTFILE="$HOME/.zsh_history"
HISTSIZE=1000000000
# shellcheck disable=2034
SAVEHIST=$HISTSIZE
setopt HIST_IGNORE_DUPS
setopt INTERACTIVE_COMMENTS
setopt SHARE_HISTORY

autoload -U compinit
compinit
# shellcheck disable=1091
source "$HOME/.zsh/fzf-tab/fzf-tab.zsh"
eval "$(zsh-patina activate)"
eval "$(starship init zsh)"
export BAT_PAGER="less -KR"
export DELTA_PAGER="less -KR"

# https://www.zsh.org/mla/users/2023/msg00659.html
bindkey -e
