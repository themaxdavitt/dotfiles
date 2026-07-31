---
name: focus-secret-templates
description: "Use when asked to add, move, or wire any secret, token, or credential (Bitwarden, `rbw`, `fnox`, chezmoi templates, env exports)."
---

# Philosophy

A secret's only home is Bitwarden; the tree holds templates that pull values at apply time. The chain runs Bitwarden → `bwbio` + the `rbw` shim → `fnox` (age-encrypted), wired in `dot_config/private_fnox/private_config.toml.tmpl`; the shim exists because the `bw` backend wants a `BW_SESSION` an SSO vault cannot issue, and it serializes `bwbio` behind a lock because `fnox` resolves batches concurrently. The few globally exported tokens are deliberate, documented conveniences rather than accidents.

# Core Directives

- ALWAYS: make a secret-bearing target a `.tmpl` that resolves at apply time, e.g. `{{ (rbwFields "item").field.value }}` — `AGENTS.md` carries the prohibition this mechanism exists to satisfy.
- NEVER: `chezmoi apply` the deployed `fnox` config; instead edit the source for content and `chmod` the live file directly when only permissions need changing — `fnox` rewrites `~/.config/fnox/config.toml` itself at runtime to cache age sync state, so applying the managed copy clobbers it.
- ALWAYS: route new exported env secrets through `fnox`; reserve global shell exports for deliberately public convenience values (e.g. a public read-only token) with a comment saying so.
- ALWAYS: give secret-holding targets the `private_` source attribute so they deploy owner-only (the `focus-chezmoi-naming` skill owns the attribute reference).
- ALWAYS: follow `AGENTS.md`'s warn-FIRST rule when testing a template render; it owns the trigger condition, the `alerter` invocation, and how to branch on the action it prints.
