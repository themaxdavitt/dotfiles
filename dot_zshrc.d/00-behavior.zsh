# shellcheck shell=ksh
# -*- mode: bash -*-

# TODO: move stuff in this file or rename it

# TODO: generate these somehow..?
# TODO: figure out if i need both of these
LSCOLORS="exfxcxdxbxegedabagacad"
LS_COLORS="di=34:ln=35:so=32:pi=33:ex=31:bd=34;46:cd=34;43:su=30;41:sg=30;46:tw=30;42:ow=30;43"
export LSCOLORS
export LS_COLORS

# TODO: make sure all my CLIs have completions, throw LLMs at https://usage.jdx.dev if not
# TODO: figure out if i need caching..?
# zstyle ':completion:*' use-cache on
# zstyle ':completion:*' cache-path "$HOME/.cache/zsh/.zcompcache"
zstyle ':completion:*' format '[%d]'
zstyle ':completion:*' menu no
zstyle ':fzf-tab:*' prefix ''
# TODO: add https://github.com/junegunn/fzf/blob/9e2856559d50637df482b8598fd7b35b2d746485/bin/fzf-preview.sh
# TODO: add https://github.com/junegunn/fzf/tree/master#customizing-completion-source-for-paths-and-directories
# try to keep in sync with `ls` alias
# shellcheck disable=2016
zstyle ':fzf-tab:complete:cd:*' fzf-preview 'ls -Apt --color=always $realpath'
zstyle ':fzf-tab:*' switch-group '<' '>'
zstyle ':fzf-tab:*' fzf-flags --bind=tab:accept
# shellcheck disable=2296
zstyle ':completion:*' list-colors "${(s.:.)LS_COLORS}"
