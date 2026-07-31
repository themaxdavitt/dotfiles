# Gatekeeper

A [Pi](https://github.com/earendil-works/pi) extension that owns Pi's
permission story: turn plans, mode-based Bash gating, and OS confinement.

Containment is per tool call, not per session. Pi itself runs unsandboxed; every
unprivileged Bash command is wrapped in `nono run --profile pi-tools` through the
bash tool's spawn hook, and the in-process file tools (`read`/`write`/`edit`) are
checked against that same profile before they run. `elevated_bash` escapes all of
it behind a per-command approval dialog.

## Planning

The agent must call `set_turn_plan` before any other tool call. The plan is
scoped to the current turn and is cleared when control returns to the user. This
is a quiet implementation detail for audit context and session state tracking;
use the external planner flow for user-reviewed session plans.

```jsonc
set_turn_plan({
  "goal": "Fix the failing auth test",
  "anticipated": ["edit src/auth.ts", "run the test suite"]
})
```

The footer shows a short summary of the current plan. Gatekeeper asks the
configured cheap auditor model for a summary under 10 words and falls back to a
deterministic truncation when no model/API key is available.

## Session Planning

The Plannotator-gated session-plan workflow moved to the sibling
`session-planner` extension on 2026-07-29. Gatekeeper keeps no plan-file
knowledge; it only receives the approved plan's text over Pi's extension event
bus (`session-planner:approved-plan`) and passes it to the Bash auditor as
context. See `../session-planner/README.md`.

## Permission Modes

Set with `/gatekeeper`, `~/.pi/agent/extensions/gatekeeper.json`, or CLI flags.
Project-local `.pi/gatekeeper.json` is deliberately **not** read: it lives in the
working directory the sandbox lets the agent write, so an agent could grant
itself `danger` or a rubber-stamp auditor there.

The mode says **who clears a gated call**: a human, the auditor model, or
nobody. The status colour is a risk ladder — red where the gate is off, amber
where a model clears calls, gray where every one stops for a human.

| Tool | `manual` (gray) | `auto` (amber) | `danger` (red) |
|------|-----------------|----------------|----------------|
| `read`, and other read-only tools | allow | allow | allow |
| Bash the allowlist proves read-only | allow | allow | allow |
| Any other Bash | ask | auditor → allow / ask / block | allow |
| `edit`, `write` | **ask** | allow | allow |
| `edit`, `write` the nono profile denies | ask, framed as leaving the sandbox | ask, same framing | allow |
| `elevated_bash` | ask, always | ask, always | allow |

`edit` and `write` are in-process filesystem calls, so no OS sandbox stands
behind that decision the way it does for Bash — in `manual` the dialog is the
only thing in front of the disk. Consequently a `manual` session with no
reachable human (`--gatekeeper-ask never`, or any non-TTY run) **blocks writes
outright** rather than performing them unattended; pass `--gatekeeper-mode auto`
for that case, which is what `session-planner` does.

### What `danger` does not bypass

The name is `danger`, not Claude Code's `bypassPermissions`, because it does not
bypass permissions — three things survive it:

- **The turn plan.** `set_turn_plan` is still required before any tool runs; the
  gate checks it first.
- **The hidden built-ins.** `ls`, `find`, and `grep` stay blocked in every mode.
- **The nono sandbox.** `sandboxSpawnHook` is installed when the Bash tool is
  registered and never consults the mode, so every Bash call still runs inside
  `nono run --profile …`. The same holds for a user-typed `!` command, confined
  through `user_bash` rather than the hook — see [User Bash](#user-bash--and-).

What it does skip: the AST analyzer, the auditor, the file-tool profile query,
and all approval dialogs — including the one for `elevated_bash`, which is the
one tool that runs *outside* the sandbox. That combination is the sharpest edge
in the extension: `danger` is the only mode where the agent can leave OS
confinement with no human in the loop.

### Renamed on 2026-07-29

`default` → `manual`, `bypassPermissions` → `danger`, and `plan` was removed
(planning now lives outside this extension). A config or flag carrying a retired
name is rejected and falls back to `manual` — the safe direction in every case,
since `default` *was* manual and `plan` was stricter than manual, never looser.

Ask mode controls whether Gatekeeper may prompt:

| Ask mode | Behavior |
|----------|----------|
| `headful` | Prompt only when Pi exposes a dialog-capable UI. |
| `never` | Never prompt; unresolved gated Bash blocks. |

## Auditor

`auto` mode sends non-allowlisted Bash to a cheap model with the declared plan
and the command. If prompting is unavailable or disabled, the auditor may return
only `allow` or `block`. If prompting is available, it may return `allow`,
`ask`, or `block`; the user dialog includes the auditor verdict and reason.

Configure the model:

```jsonc
// ~/.pi/agent/extensions/gatekeeper.json
{
  "mode": "manual",
  "askMode": "headful",
  "auditor": { "provider": "anthropic", "modelId": "claude-haiku-4-5" },
  "binTrust": {
    "miseTools": ["gh", "aube", "uv", "nono", "node", "python", "rg", "fd", "agent-browser"],
    "roots": ["~/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
  }
}
```

`binTrust` is one list doing two jobs: it *is* the PATH handed to the sandboxed
bash (`miseTools` resolved through `mise which`, directory kept, then `roots`),
and it is the set of locations whose executables are trusted. The ambient PATH is
never inherited or consulted — a login PATH can contain entries bash resolves
relative to the agent's working directory.

Being on that list grants a *location*, not permission: which command names run
unprompted is `src/hazmat/allowlist.ts`'s decision alone, so `gh pr create` and
`node -e '…'` still face the auditor or the user even though both are on the
PATH. A pinned PATH also constrains approved commands, so a tool missing from
`miseTools` fails with command-not-found after you allow it.

CLI flags:

```bash
pi -e ./index.ts --gatekeeper-mode auto --gatekeeper-ask never
```

`--session-planner` and `--approved-session-plan` are registered by the
`session-planner` extension, not this one.

## Tool Policy

Gatekeeper removes Pi's built-in `ls`, `find`, and `grep` tools from the active
tool surface on startup, tree switches, and before each agent turn. If another
extension or CLI flag re-adds one of those tools, direct calls are blocked.
Agents should use Bash CLI commands such as `ls`, `find`, `grep`, or `rg`
instead.

## Bash Analysis

Bash commands are parsed with `tree-sitter-bash` and checked with a
default-deny AST walk:

- Every command in the AST is checked against `src/hazmat/allowlist.ts`.
- Every allowlisted name is then resolved to the file that will actually run —
  directory part against the session `cwd`, bare name down `PATH`, first
  executable match winning as bash's own search does — and gated unless it is in
  a configured trusted root (`binTrust` above). An allowlisted *name* proves
  nothing on its own: `./ls`, `/tmp/x/ls`, and `bin/nono why` all name a file
  the agent may have written.
- Assignments that redirect resolution or inject code are gated outright:
  `PATH`, `IFS`, `BASH_ENV`, `ENV`, `SHELLOPTS`, `BASHOPTS`, `CDPATH`,
  `GLOBIGNORE`, `PROMPT_COMMAND`, and anything `DYLD_*`/`LD_*` — so
  `PATH=/tmp/evil ls` and `DYLD_INSERT_LIBRARIES=x.dylib ls` never reach the
  allowlist.
- Output redirects to real files are gated.
- Dynamic command names, parse errors, function definitions, and shell
  executors are gated.
- Benign wrappers such as `nice`, `nohup`, and `timeout` are unwrapped, and each
  wrapper in the chain is trust-checked too (`./timeout 5 ls` runs `./timeout`).

The current allowlist is intentionally small while the maintenance methodology
is being worked out:

```text
cat, head, tail, grep, ls, pwd, wc, true, test, nono (only `nono why`)
```

`find` is deliberately absent: proving a `find` invocation read-only means
tracking `-delete`, `-exec`, `-execdir`, `-ok`, and `-fprintf`, so it goes to
review like anything else. `nono why` is the one mise-managed tool exempt, and
only from a trusted location.

## User Bash (`!` and `!!`)

None of the above applies to a command *you* type at the prompt. Pi routes `!`
input through `AgentSession.executeBash`, not through a tool call, so there is no
AST analysis, no auditor, and no dialog — typing the command is the consent.

What that path did skip until 2026-07-30 was OS confinement, and for a purely
structural reason: `spawnHook` is an option on the bash *tool* definition, so it
only ever sees calls the model made. Gatekeeper now handles Pi's `user_bash`
event and returns wrapped `BashOperations` (`sandboxBashOperations` in
`src/sandbox/wrap.ts`), which puts both paths on one implementation.

| Prefix | Sandbox | Output to the model |
|--------|---------|---------------------|
| `!cmd`  | `nono run --profile pi-tools`, same as the agent's bash | yes |
| `!!cmd` | **none** — runs with your full environment | no |

`!!` is therefore the escape hatch for the cases `!` will now refuse: pushing a
branch, applying chezmoi, anything needing a real credential or a write outside
the working directory. Two consequences worth knowing:

- **`!!` means more than it used to.** Its only prior job was keeping output out
  of the model's context; it now also drops the sandbox. The pairing is the
  point — the command that runs with real credentials is the one whose output
  cannot reach the model — but reaching for `!!` purely to keep noise out of the
  transcript is no longer a neutral choice.
- **"Excluded from context" is not "not recorded."** `!!` output stays out of
  what the model sees; the session log on disk keeps it either way.

Under `!`, `GH_TOKEN` arrives as nono's proxy placeholder and secret-shaped vars
like `DATALAB_API_KEY` are scrubbed, exactly as they are for the agent. The PATH
is the `binTrust` list rather than your login PATH, so a `!` command resolves
binaries from the same groomed set the agent does.

## nono Diagnostics

Gatekeeper does not implement nono rules. If a tool result looks like an outer
nono sandbox denial, Gatekeeper appends guidance pointing the agent toward:

```bash
nono why --self --path <blocked-path> --op <read|write|readwrite>
```

The guidance directs the agent to offer either a one-off grant restart or a
profile draft, and to avoid suggesting `sudo`, `chmod`, `chown`, Full Disk
Access, or Pi approval changes for sandbox denials.

### Proxy CA warm-up

The nono proxy CA is self-signed and regenerated every few days, and the first
`--trust-proxy-ca` run afterwards pops a macOS keychain prompt. Whichever Bash
call came first would otherwise wear that prompt, possibly long after you
stopped watching the session. Gatekeeper runs a no-op `nono run` once at
`session_start` so the prompt lands at startup instead.

`~/bin/pi` does the same thing before Pi launches, which is the better place —
it runs before the TUI owns the terminal. The `session_start` warm-up is the net
for launches that skip the wrapper. It is quiet on success and only prints when
it fails.

## Approval Dialog

When a Bash command needs human approval, the dialog shows the command, auditor
context when present, and analyzer reasons when enabled.

| Key | Action |
|-----|--------|
| `y` | Allow |
| `n` | Decline |
| `←` `→` | Navigate options |
| `Tab` | Toggle focus |
| `Enter` | Attach a message to the selected decision |
| `Esc` | Decline |

## Install

Deployed by chezmoi from `dot_pi/agent/extensions/gatekeeper` to
`~/.pi/agent/extensions/gatekeeper`, where Pi discovers it automatically.
Dependencies are installed into the target by the repo's `run_onchange` deps
script.
