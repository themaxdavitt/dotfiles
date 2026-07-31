#!/usr/bin/env bash
# Daily-cadence restic backup to the `backups` repo (rclone:mirror = OVH + Hetzner S3),
# with daily/weekly/monthly rotation plus a floor so the newest few snapshots are never
# pruned. Safe to fire from BOTH launchd and cron: a marker file throttles to ~one
# snapshot/day, so whichever scheduler wins does the work and the other no-ops. Portable
# to a homelab box — only the scheduler that invokes it is host-specific.
#
# Subcommand:
#   ,backup init   one-time repo bootstrap (`restic init`), reusing the same rclone+fnox
#                  env; skips the throttle. Run once before the first backup.
#
# Overrides (also how the local self-test runs, Touch-ID / S3-free):
#   RESTIC_REPOSITORY  pre-set to target a different repo (the rclone-mirror env is only
#                      exported when it starts with `rclone:mirror:`)
#   RESTIC_PASSWORD    pre-set to skip the `fnox exec --profile backups` unlock
set -euo pipefail

# --- subcommand: `init` bootstraps the repo; anything else is a backup ----------------
mode=backup
if [[ "${1:-}" == init ]]; then mode=init; shift; fi

# --- what to back up (override via args) ---------------------------------------------
# TODO: replace the placeholder with real source paths (dotfiles state, ~/Documents, …).
paths=("$@")
[[ ${#paths[@]} -eq 0 ]] && paths=("$HOME/.local/share/restic-backup-dummy")

# --- throttle: dedupe launchd + cron double-fires to ~one snapshot/day ----------------
# init never throttles — a one-time bootstrap must always reach the repo.
min_interval_hours=20
marker="${XDG_STATE_HOME:-$HOME/.local/state}/restic/backups.last"
if [[ "$mode" == backup && -r "$marker" ]]; then
  last=$(<"$marker")
  if [[ "$last" =~ ^[0-9]+$ ]] && (( $(date +%s) - last < min_interval_hours * 3600 )); then
    printf ',backup: last snapshot %sh ago (< %sh) — skipping.\n' \
      "$(( ($(date +%s) - last) / 3600 ))" "$min_interval_hours"
    exit 0
  fi
fi

# --- repo + backend ------------------------------------------------------------------
: "${RESTIC_REPOSITORY:=rclone:mirror:backups}"
export RESTIC_REPOSITORY
if [[ "$RESTIC_REPOSITORY" == rclone:mirror:* ]]; then
  # rclone S3 remotes (non-secret; the access keys come from the fnox `backups` profile).
  # TODO: DRY this block with ,vault once that lands (shared sourced snippet).
  export RCLONE_CONFIG__HETZNER_FSN1_TYPE=s3 RCLONE_CONFIG__HETZNER_FSN1_PROVIDER=Other
  export RCLONE_CONFIG__HETZNER_FSN1_ENDPOINT=fsn1.your-objectstorage.com
  export RCLONE_CONFIG__HETZNER_FSN1_REGION=fsn1 RCLONE_CONFIG__HETZNER_FSN1_LOCATION_CONSTRAINT=fsn1
  export RCLONE_CONFIG__HETZNER_FSN1_ACL=private
  export RCLONE_CONFIG__OVH_BHS_TYPE=s3 RCLONE_CONFIG__OVH_BHS_PROVIDER=Other
  export RCLONE_CONFIG__OVH_BHS_ENDPOINT=s3.bhs.io.cloud.ovh.net
  export RCLONE_CONFIG__OVH_BHS_REGION=bhs RCLONE_CONFIG__OVH_BHS_LOCATION_CONSTRAINT=bhs
  export RCLONE_CONFIG__OVH_BHS_ACL=private
  export RCLONE_CONFIG_MIRROR_TYPE=union RCLONE_CONFIG_MIRROR_ACTION_POLICY=all
  export RCLONE_CONFIG_MIRROR_CREATE_POLICY=all RCLONE_CONFIG_MIRROR_SEARCH_POLICY=ff
  export RCLONE_CONFIG_MIRROR_UPSTREAMS="_ovh_bhs:nameless-shape-14 _hetzner_fsn1:quiet-haze-57"
fi

# restic/fnox resolve straight off the mise shims (the ~/bin/restic wrapper that once
# forced `mise which` is retired). Schedulers run a minimal PATH, so fail loud here if
# the shims dir + ~/bin aren't on it, rather than emit a cryptic "command not found".
command -v restic >/dev/null || { echo ",backup: restic not on PATH (need the mise shims dir)" >&2; exit 1; }
if [[ -n "${RESTIC_PASSWORD:-}" ]]; then
  run() { restic "$@"; }                                # creds already in the env
else
  command -v fnox >/dev/null || { echo ",backup: fnox not on PATH (need the mise shims dir)" >&2; exit 1; }
  # Mint ONE biometric unlock up front and reuse it for the whole run: fnox then resolves
  # the profile's secrets under a single session (tap-free after the first prompt) instead
  # of firing a cold, concurrent per-secret unlock — which both spams Touch ID and trips a
  # resolve race that can blank a key. The fnox daemon can't pre-warm this for us because it
  # folds BW_SESSION (which rotates every unlock) into its cache key, so a warm-up session is
  # never reused. Skipped when a session is already inherited (interactive use) or bwbio is
  # absent; a failed unlock falls through to fnox's own prompting rather than aborting.
  if [[ -z "${BW_SESSION:-}" ]] && command -v bwbio >/dev/null; then
    if session="$(bwbio unlock --raw 2>/dev/null)" && [[ -n "$session" ]]; then
      export BW_SESSION="$session"
    else
      echo ",backup: biometric unlock unavailable — fnox will resolve per-secret (may prompt repeatedly)" >&2
    fi
  fi
  run() { fnox exec --profile backups -- restic "$@"; } # resolve via fnox under the session
fi

# init: bootstrap the repo and stop. Idempotent enough — an already-inited repo just
# errors ("master key already initialized"), which is a safe no-op to re-run.
if [[ "$mode" == init ]]; then
  run init
  exit 0
fi

run backup "${paths[@]}"
# Rotation: 3-month daily / 6-month weekly / 1-year monthly, with a 3-snapshot floor so a
# burst of runs can never prune your only copies. --prune reclaims space now; split it to a
# weekly cadence if S3 prune I/O gets expensive.
run forget --keep-last 3 --keep-daily 90 --keep-weekly 26 --keep-monthly 12 --prune

mkdir -p "$(dirname "$marker")"
date +%s > "$marker"
