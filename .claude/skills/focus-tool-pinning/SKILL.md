---
name: focus-tool-pinning
description: "Use when asked to add, bump, pin, vendor, or remove a tool, runtime, or script dependency (mise, brew, uv/PEP 723, `,`-script deps)."
---

# Philosophy

Supply-chain caution is the point of this repo: every tool arrives pinned, delayed, and documented, through the most accountable backend available. Convenience loses ties against security and reproducibility. These directives encode where each kind of dependency belongs — `mise` first, `brew` as the macOS fallback, PEP 723 for scripts — and how to keep upgrades reviewable.

# Core Directives

- ALWAYS: install every tool/runtime through `mise`; fall back to `brew` only when no `mise` backend can provide it (macOS apps, e.g. `.pkg`s with no other release artifacts; no auto-updates).
- ALWAYS: pin + delay everything: when adding a tool, use a backend that supports `minimum_release_age`, keep `paranoid` + `minimum_release_age` global, and leave `locked` unset (it's problematic with less-strict projects).
- ALWAYS: prefer ecosystem backends over registry backends, and implicitly pinned ecosystem backends over the rest (e.g. `github` > `aqua` > `npm`).
- ALWAYS: keep lockfiles for the global config; give every tool an explicit version.
- NEVER: run `mise lock`/`mise install` or apply `~/.config/mise` yourself after a config change; instead edit the source config and ask the user to run `,cza`, which locks narrowly (`mise lock --global <new tools only>`), installs `--locked`, and re-adds the lockfile to source — a broad `mise lock` re-resolves existing entries against current upstream artifacts, so a silently overwritten release would replace a trusted checksum. A same-day npm bump has to clear a *second*, independent gate: aube's `paranoid` default rejects anything under 1440 minutes old, so `minimumReleaseAgeExclude` in `dot_config/aube/config.toml` must name every package in the release train rather than only the one pinned in mise. Clearing mise's `minimum_release_age` does not clear aube's, and the failure names a transitive dependency (`ERR_AUBE_NO_MATURE_MATCHING_VERSION`) instead of the tool you bumped.
- ALWAYS: give each non-runtime tool a one-line `# comment` saying why it's useful; runtimes (e.g. `deno`, `node`) are exempt.
- ALWAYS: on any tool version bump, link the upstream changelog / release notes in your handoff so the user can review before applying.
- NEVER: install from third-party taps (e.g. no `hashicorp/tap/terraform`); instead use official Homebrew repos or `tmd-x/3rd-party` (managed by this repo's author).
- NEVER: pull unpinned/undelayed third-party code into a `,`-script; instead wrap already-pinned tools in a thin bash `exec` passthrough, or pin + delay via PEP 723 `uv` + `exclude-newer`. Exception: `mise x node@22` pulls zero third-party npm packages and pins the runtime via `mise` (a weak `@22` is fine for too-big-to-fail runtimes `mise` manages); third-party packages get no such leniency.
- NEVER: add new in-tree vendored code (`bin/executable_bwbio` is a wart to remove, not a pattern to copy); instead prefer `.chezmoiexternal.toml`, git submodules, or mise-managed binaries.
- NEVER: commit an artifact — generated output, or a third-party data file the repo merely consumes; instead retrieve it at runtime from an immutable pinned URL (a Wayback `…id_/` snapshot works when upstream serves no versioned one), assert its `sha256` before use so the pin is enforced rather than assumed, and cache it under `XDG_CACHE_HOME` so a later run still works offline. `.colors/generate.js` is the worked example.
- NEVER: modify a vendored file without an adjacent comment recording its upstream and the reason for the local change; instead prefer re-vendoring wholesale from upstream over accumulating local patches.
