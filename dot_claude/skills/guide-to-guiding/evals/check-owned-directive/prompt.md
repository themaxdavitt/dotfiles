A project's `AGENTS.md` is at its directive cap and a new rule needs the slot. Two existing directives look redundant, because a checked-in linter already fails the commit for each of them:

- "ALWAYS: parse CLI arguments with `typer`, never `argparse`" — the linter prints `use typer for CLI arg parsing instead of 'import argparse'` and names the file and line.
- "NEVER: paste a credential into a config file; wire it through the secret template" — the linter scans staged files for credential patterns and names the file.

Free exactly one slot. Say which directive you cut and why the other one stays.
