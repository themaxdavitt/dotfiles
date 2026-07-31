# Agent guidelines

This file guides AI agents working in this repo: personal dotfiles, currently macOS-only, managed by [chezmoi](https://chezmoi.io). Everything is in flux — expect stubs, gaps, and open TODOs rather than completeness. Convenience matters, but security and reproducibility outrank it; if they conflict, ask.

## Verify

- ALWAYS: reach for these checks when showing your evidence — there is no test suite here, so the check that owns a change is one of:
  - Lint (deterministic lanes, changed files): `mise run check`; whole repo: `hk check --all`
  - Lint (LLM judge lane, paid + cached): `mise run check-llm`
  - Skill value (behavioral ablation, on demand): `,llint improve --dry-run <skill-dir>`
  - Renders: `chezmoi diff`, `chezmoi status`, `chezmoi cat <target>`, `chezmoi execute-template` — each can trigger a Bitwarden unlock, so **warn FIRST** (next section)
  - Secret wiring (Bitwarden-backed `fnox` profile): `fnox exec --profile <name> -v -- env | rg <PREFIX>` — every referenced secret must print non-empty; a blank means a bad `value` ref or a concurrent-batch resolve failure, not success. Triggers Touch ID (cold, up to one prompt per secret), so **warn FIRST** like renders.
  - Scripts: `shellcheck`; tool/version changes: hand off to the user's `,cza` run — the `focus-tool-pinning` skill owns why `mise lock`/`mise install` stay off-limits

## ⚠️ Bitwarden unlock — warn FIRST

- ALWAYS: alert the user via `alerter` (installed) **before** a step that will actually request secret values — a chezmoi render/apply whose targets or `.chezmoi*` control files reference `rbwFields`, any `fnox exec --profile <name>`, or `,cza` — then branch on its printed action (`Proceed` / `Wait` / `@TIMEOUT`). Such a step refocuses the Bitwarden desktop app; the user isn't always watching and wants zero MFA fatigue. The gate is whether Bitwarden will pop, rather than whether the step is risky — when nothing in scope references `rbwFields` (e.g. `bin/`, the generated color-scheme themes), run it unannounced and say so in your report:

  ```bash
  alerter --title "chezmoi-agent" --subtitle "Bitwarden unlock incoming" \
    --message "About to run \`chezmoi diff\` — triggers a biometric unlock + refocuses Bitwarden. Proceed?" \
    --actions "Proceed" --close-label "Wait" --timeout 60
  ```

- NEVER: run `,cza`, or any chezmoi command that computes target state (`apply`, `status`, `diff`, `verify`, `archive`, `dump`), without a target path; instead scope it to paths the user approved (e.g. `chezmoi apply ~/bin`), warning first if that scope renders secrets. Every one of them renders each managed template *in scope*, so the bare form sweeps the whole tree and pops an unlock per `rbwFields` secret — `chezmoi status` is not the cheap read-only peek its name suggests, though `chezmoi status ~/.pi` is. Scope decides whether Bitwarden fires, not the subcommand.

## Security posture

- ALWAYS: pin + delay everything (supply chain) — this is the point of the repo. Activate the `focus-tool-pinning` skill for any tool, runtime, or dependency change; the `mise`/`brew`/PEP 723/vendoring rules live there.
- NEVER: commit a secret or read one into the tree; instead activate the `focus-secret-templates` skill, which owns the template mechanism and the vault chain.
- ALWAYS: default new configs to telemetry-off and offline/privacy-first; the `focus-privacy-defaults` skill owns which switches to hunt down (see existing Zed, `pi`, and `mise` settings).
- ALWAYS: follow the existing seatbelt patterns (`agent-safehouse`, `,chrome`, `,ssh`, `,safe-pi`) and raise it when a new tool touches the network or runs an agent — for agent tooling the settled shape is the gatekeeper pattern (unsandboxed supervisor, per-tool-call `nono` sandboxes, human-gated elevation; see `dot_pi/agent/extensions/gatekeeper/AGENTS.md`); beyond that, sandboxing policy is unsettled, so ask before inventing new rules.

## Linting

- ALWAYS: activate the `guide-to-linting` skill before writing or debugging any check; it routes work across the five lanes (`mdschema` → Vale `AgentGuidance` → `.lints/` → `,llint check` → `,llint improve`) and owns the `,llint` ground rules.

## Conventions

- ALWAYS: activate the `focus-chezmoi-naming` skill before adding, moving, or renaming any managed file — the [source-state attribute][chezmoi-source-attrs] prefixes, `.literal` workaround, and mode-line rules live there.
- ALWAYS: activate the `focus-comma-scripts` skill for anything under `bin/` — the `,`-command layout, thin `exec` wrappers, and PEP 723 pinning rules live there.
- ALWAYS: keep `agent_servers.pi.favorite_models` (Zed settings) in sync with `dot_pi/agent/settings.json` — the editor is Zed + the `pi` agent over ACP.

## Repo boundaries

- NEVER: surface, commit, or depend on gitignored scratch (`*.local.*` including `.local.resources/`, and `TODO*` — personal, may hold secrets); instead treat it as read-only context when the user points you at it.
- ALWAYS: assume other checkouts exist — secondary chezmoi checkouts (e.g. `~/.local/share/chezmoi2`) hold work/private configs; prefer `.d`-directory drop-ins (like `dot_zshrc.d/`) over claiming whole shared files, so both checkouts apply cleanly.
- ALWAYS: assume other agents work in this tree concurrently — declare the paths you claim up front and stay inside them, edit chezmoi source rather than deployed targets (target edits drift and get clobbered on the next apply). Clean up the stale artifacts your change strands, deleting unprompted only what you created or displaced yourself; for anything else ask first, and remove named paths instead of sweeping a directory, since unrelated work-in-progress (e.g. under `~/.claude/`) lives beside it.
- ALWAYS: stage only the paths you own after each verified task (`git add -- <path>...`) rather than staging broadly, stashing, or resetting the shared index, since those operations can capture or discard concurrent work. In the main checkout, offer Max a fresh, vague, playful message inspired by the recent log without reusing one of its titles, and wait for approval before creating it; in an isolated worktree, commit each verified staged task without waiting, using a conventional `type(scope): description` message so the worktree's agent can trace its own history.

[chezmoi-source-attrs]: https://raw.githubusercontent.com/twpayne/chezmoi/refs/tags/v2.70.2/assets/chezmoi.io/docs/reference/source-state-attributes.md
