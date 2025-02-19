# Self-explanatory

eval "$(/opt/homebrew/bin/brew shellenv)"

export PATH="$PATH:/Applications/Visual Studio Code.app/Contents/Resources/app/bin"

# Rust-specific stuff
source $HOME/.cargo/env
export PATH="$(brew --prefix llvm)/bin:$PATH"

# Python-specific stuff
export PATH="$HOME/.local/bin:$PATH"
