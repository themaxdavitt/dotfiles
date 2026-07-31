# shellcheck shell=ksh
# -*- mode: bash -*-

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

# Keep a blank line between commands without making it part of PROMPT: fzf-tab
# asks ZLE to redisplay after completion, which would otherwise print it again.
autoload -Uz add-zsh-hook
prompt_spacer() { print; }
add-zsh-hook precmd prompt_spacer

# https://www.zsh.org/mla/users/2023/msg00659.html
bindkey -e
