# Session Planner

A [Pi](https://github.com/earendil-works/pi) extension that splits planning from
implementation across two Pi runs, gating the second on a human-approved plan.

Split out of the `gatekeeper` extension on 2026-07-29. It shares no code with
Gatekeeper: the one thing Gatekeeper still wants — the approved plan's text, so
its Bash auditor can judge commands against it — travels over Pi's extension
event bus on the `session-planner:approved-plan` channel. Deleting this
directory removes the workflow completely and breaks nothing in Gatekeeper.

> **Currently inert.** The `pi-session-planner` nono profile the wrapper
> defaults to does not exist in this repo's `dot_config/nono/profiles/`. Until
> one is written, `session-plan` has no profile to confine the planning Pi.

## Flow

1. `session-plan` launches a **planning Pi** under a read-only nono profile,
    with only `read`, `bash`, `set_turn_plan`, and `submit_session_plan` active.
2. That Pi researches, then submits a markdown plan through
    `submit_session_plan`.
3. The plan goes to Plannotator for review. This does not install or use
    `@plannotator/pi-extension`; it calls the public CLI:
    `plannotator annotate <plan.md> --gate --json`.
4. On approval the tool terminates the planning run, and `session-plan`
    prints (or with `--exec`, runs) the **implementing Pi** command with
    `--approved-session-plan <id>` and the mutating tools restored.

```bash
session-plan --profile pi-session-planner -- -p "Plan the requested change"
```

| Option | Default | Behavior |
|--------|---------|----------|
| `--profile <name>` | `SESSION_PLANNER_PROFILE` or `pi-session-planner` | nono profile confining the planning Pi |
| `--pi <path>` | `SESSION_PLANNER_PI_BIN` or `pi` | Pi binary |
| `--nono <path>` | `SESSION_PLANNER_NONO_BIN` or `nono` | nono binary |
| `--extension <path>` | this package's `index.ts` | extension entry passed to both runs |
| `--cwd <path>` | current directory | working directory for both runs |
| `--exec` | off | run the implementing Pi instead of only printing the command |

Everything after `--` is passed through to the planning Pi verbatim.

Your nono profile should make the project read-only and grant writes only to the
Pi state directories needed for sessions, saved plans, and the per-run
Plannotator data directory. On macOS the wrapper passes
`--allow-launch-services` and `PLANNOTATOR_BROWSER=/usr/bin/open` so Plannotator
can open its localhost review URL; the profile must opt into
`allow_launch_services` and allow localhost.

## Naming

The tool, flags, environment variables, and on-disk layout were all named
`gatekeeper*` before the 2026-07-29 split and were renamed with it, since
nothing real had been planned through them yet. Anything still holding the old
names is stale: `--gatekeeper-planner` → `--session-planner`,
`--gatekeeper-approved-plan` → `--approved-session-plan`,
`gatekeeper_submit_session_plan` → `submit_session_plan`, `GATEKEEPER_*` →
`SESSION_PLANNER_*`, `gatekeeper-plan` → `session-plan`.

Two `--gatekeeper-*` flags in the launch command are **not** stale:
`--gatekeeper-mode auto --gatekeeper-ask never` belong to the gatekeeper
extension, which is loaded in the planning Pi too.

State lives in:

```text
~/.pi/agent/session-planner/plans/<id>.{md,json}   the plan and its record
~/.pi/agent/session-planner/plans/latest-approved.json
~/.pi/agent/session-planner/plannotator/<run-id>/  per-run Plannotator state
```

Draft plans written by the pre-split code are still under
`~/.pi/agent/gatekeeper/plans/`; nothing reads that directory now.

Plannotator state is isolated per planner run, and approved plans are resolved
by run id rather than by `latest-approved.json`, so two concurrent planner runs
cannot claim each other's approvals.

## Install

Deployed by chezmoi from `dot_pi/agent/extensions/session-planner` to
`~/.pi/agent/extensions/session-planner`, where Pi discovers it automatically.
There are no runtime dependencies, so the deployed target needs no
`node_modules`; run the CLI as
`node ~/.pi/agent/extensions/session-planner/bin/session-plan.js`, or directly
since it is deployed executable.
