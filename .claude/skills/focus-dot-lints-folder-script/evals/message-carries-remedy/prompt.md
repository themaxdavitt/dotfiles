A repository has just deleted this directive from its `AGENTS.md`, on the grounds that a `.lints/` script already fails the commit for it:

> ALWAYS: give every `run_` script that reads its own deployed directory a `.chezmoi.sourceDir` reference, since `after_` orders the script against its containing directory rather than its sibling entries.

You are writing that script's failure output. Give the exact line it prints for `run_after_deps.sh`.
