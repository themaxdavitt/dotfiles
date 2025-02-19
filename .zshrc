# Self-explanatory

HISTFILE=${ZDOTDIR:-$HOME}/.zsh_history
HISTSIZE=1000000000
SAVEHIST=$HISTSIZE
setopt SHARE_HISTORY
setopt HIST_IGNORE_DUPS

unsetopt BEEP
setopt INTERACTIVE_COMMENTS

# https://apple.stackexchange.com/a/20553
function pub-ip {
  dig -4 TXT +short o-o.myaddr.l.google.com @ns1.google.com | tr -d '"'
}

# https://apple.stackexchange.com/a/147777
function priv-ip() {
  function priv-ip-iface() {
    IT=$(ifconfig "$1")
    if [[ "$IT" != *"status: active"* ]] || [[ "$IT" != *" broadcast "* ]]; then
      return
    fi
    echo "$IT" | grep "inet " | grep -v 127.0.0.1 | awk '{print $2}'
  }

  if [[ -n "$1" ]]; then
    priv-ip-iface "$1"
  else
    DEFAULT_ROUTE=$(route -n get 0.0.0.0 2>/dev/null | awk '/interface: / {print $2}')
    for iface in $(ifconfig | awk '/^[a-z0-9]+:/ {print substr($1, 1, length($1)-1)}' | sort -u); do
      IP=$(priv-ip-iface "$iface")
      [[ -n "$IP" ]] && echo "$iface $IP" $( [[ "$iface" == "$DEFAULT_ROUTE" ]] && echo "*" )
    done
  fi
}
