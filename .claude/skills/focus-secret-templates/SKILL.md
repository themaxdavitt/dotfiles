---
name: focus-secret-templates
description: "Use when asked to add, move, or wire any secret, token, or credential (Bitwarden, `rbw`, `fnox`, chezmoi templates, env exports)."
---

# Philosophy

A secret's only home is Bitwarden; the tree holds templates that pull values at apply time. `bwbio` and the `rbw` shim handle unlock, `fnox` carries age-encrypted derived values, and the few globally exported tokens are deliberate, documented conveniences rather than accidents.

# Core Directives

- NEVER: write a secret value into any tracked file or read one into the working tree; instead make the target a `.tmpl` that pulls at apply time, e.g. `{{ (rbwFields "item").field.value }}`.
- ALWAYS: treat Bitwarden as the source of truth, reached as Bitwarden → `bwbio` + the `rbw` shim → `fnox` (age-encrypted); `dot_config/private_fnox/config.toml.tmpl` shows the wiring.
- ALWAYS: route new exported env secrets through `fnox`; reserve global shell exports for deliberately public convenience values (e.g. a public read-only token) with a comment saying so.
- ALWAYS: give secret-holding targets the `private_` source attribute so they deploy owner-only (the `focus-chezmoi-naming` skill owns the attribute reference).
- ALWAYS: alert via `alerter` before any chezmoi rendering subcommand while testing a template — rendering triggers a Bitwarden unlock (pattern in `AGENTS.md`).
