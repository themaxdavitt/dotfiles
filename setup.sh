#!/usr/bin/env bash

# Make Bash a little easier to work with
# https://gist.github.com/mohanpedala/1e2ff5661761d3abd0385e8223e16425
set -euo pipefail

# Change to script directory
# https://stackoverflow.com/a/3355423
cd "$(dirname "$0")"

# TODO: Set up a bunch of other stuff before this

# Install Stow, a symlink manager
brew install stow

# Create symlinks in home directory
stow
