---
name: focus-privacy-defaults
description: "Use when asked to create or overhaul a tool's config file (telemetry, auto-update, cloud sync, and network posture defaults)."
---

# Philosophy

New tools arrive quiet. Telemetry, crash reporting, auto-updates, and cloud sync all default off; versions move only through pinned package managers, and any network feature that stays on is an explicit, commented decision. The existing Zed, `pi`, and `mise` configs are the pattern to copy.

# Core Directives

- ALWAYS: when adding a tool's config, find its telemetry/metrics/crash-reporting switches in the settings reference and disable them in the same change (patterns: Zed `"telemetry": { "metrics": false }`, pi `"enableInstallTelemetry": false`).
- ALWAYS: disable auto-update and self-update mechanisms — versions change only through pinned `mise`/`brew` entries (activate the `focus-tool-pinning` skill).
- ALWAYS: turn off cloud-sync and account features unless the user asked for them, and mark each intentionally enabled network feature with a one-line comment. Where a protection is only wanted on some networks, scope it to those rather than forcing it everywhere — encrypted DNS is the worked example: the daemon runs always, but a macOS network Location points Wi-Fi at `127.0.0.1` only on untrusted networks, since the home router already resolves over an encrypted upstream.
- NEVER: accept first-run defaults silently; instead enumerate the tool's privacy-relevant settings and set each one explicitly, even when the chosen value matches the default.
- NEVER: land a tool whose telemetry or update check has no off switch on the strength of its config alone; instead say which hosts it reaches, whether a seatbelt or DNS rule can hold it, and put that tradeoff to the user before it lands.
