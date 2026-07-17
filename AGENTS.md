# Agent guidelines

This file guides AI agents working in this repo: personal dotfiles, currently macOS-only, managed by [chezmoi](https://chezmoi.io). Everything is in flux — expect stubs, gaps, and open TODOs rather than completeness. Convenience matters, but security and reproducibility outrank it; if they conflict, ask.

## Verify

- ALWAYS: show evidence, not assertions — there is no test suite, so run the check that owns your change:
  - Lint (deterministic lanes, changed files): `mise run check`; whole repo: `hk check --all`
  - Lint (LLM judge lane, paid + cached): `mise run check-llm`
  - Skill value (behavioral ablation, on demand): `,llint eval <skill-dir>`
  - Renders: `chezmoi diff`, `chezmoi cat <target>`, `chezmoi execute-template` — each can trigger a Bitwarden unlock, so **warn FIRST** (next section)
  - Scripts: `shellcheck`; tool/version changes: `mise lock` and `--dry-run`

## ⚠️ Bitwarden unlock — warn FIRST

- ALWAYS: the moment you realize a step needs a chezmoi rendering subcommand, alert the user **before** running it via `alerter` (installed), then branch on its printed action (`Proceed` / `Wait` / `@TIMEOUT`). Rendering requests secret values, which refocuses the Bitwarden desktop app; the user isn't always watching and wants zero MFA fatigue:

  ```bash
  alerter --title "chezmoi-agent" --subtitle "Bitwarden unlock incoming" \
    --message "About to run \`chezmoi diff\` — triggers a biometric unlock + refocuses Bitwarden. Proceed?" \
    --actions "Proceed" --close-label "Wait" --timeout 60
  ```

- NEVER: run unscoped `,cza` or bare `chezmoi apply`; instead apply narrowly scoped targets the user approved (e.g. `chezmoi apply ~/bin`), warning first if a target renders secrets.

## Security posture

- ALWAYS: pin + delay everything (supply chain) — this is the point of the repo. Activate the `focus-tool-pinning` skill for any tool, runtime, or dependency change; the `mise`/`brew`/PEP 723/vendoring rules live there.
- NEVER: commit a secret or read one into the tree; instead activate the `focus-secret-templates` skill and have templates pull via `rbwFields` (source of truth: Bitwarden → `bwbio` + the `rbw` shim → `fnox`, age-encrypted).
- ALWAYS: default new configs to telemetry-off and offline/privacy-first — the `focus-privacy-defaults` skill owns the switches (see existing Zed, `pi`, and `mise` settings).
- ALWAYS: follow the existing seatbelt patterns (`agent-safehouse`, `,chrome`, `,ssh`, `,safe-pi`) and raise it when a new tool touches the network or runs an agent — sandboxing policy is unsettled, so ask before inventing new rules.

## Linting

- ALWAYS: activate the `guide-to-linting` skill before writing or debugging any check; it routes work across the five lanes (`mdschema` → Vale `AgentGuidance` → `.lints/` → `,llint lint` → `,llint eval`) and owns the `,llint` ground rules.

## Conventions

- ALWAYS: activate the `focus-chezmoi-naming` skill before adding, moving, or renaming any managed file — the [source-state attribute][chezmoi-source-attrs] prefixes, `.literal` workaround, and mode-line rules live there.
- ALWAYS: activate the `focus-comma-scripts` skill for anything under `bin/` — the `,`-command layout, thin `exec` wrappers, and PEP 723 pinning rules live there.
- ALWAYS: keep `agent_servers.pi.favorite_models` (Zed settings) in sync with `dot_pi/agent/settings.json` — the editor is Zed + the `pi` agent over ACP.

## Repo boundaries

- NEVER: surface, commit, or depend on gitignored scratch (`*.local.*` including `.local.resources/`, and `TODO*` — personal, may hold secrets); instead treat it as read-only context when the user points you at it.
- ALWAYS: assume other checkouts exist — secondary chezmoi checkouts (e.g. `~/.local/share/chezmoi2`) hold work/private configs; prefer `.d`-directory drop-ins (like `dot_zshrc.d/`) over claiming whole shared files, so both checkouts apply cleanly.
- ALWAYS: assume other agents work in this tree concurrently — declare the paths you claim up front and stay inside them, edit chezmoi source rather than deployed targets (target edits drift and get clobbered on the next apply), and leave the git index alone: no `git add`, `git stash`, or commits unless the user assigns them to you.

## Reference

- ALWAYS: when you bump a tool's version, re-check the upstream doc links pinned in this file and in the skills — they cite tags matching the installed version (e.g. chezmoi `v2.70.2`) — and update the tags to match.

[chezmoi-source-attrs]: https://raw.githubusercontent.com/twpayne/chezmoi/refs/tags/v2.70.2/assets/chezmoi.io/docs/reference/source-state-attributes.md
