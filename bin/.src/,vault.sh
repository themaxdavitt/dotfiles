#!/usr/bin/env bash
# Content vault: a keyed, versioned content store backed by the `vault` restic repo
# (rclone:mirror = OVH + Hetzner S3, isolated from the `backups` repo by repo path). Two
# layers share one repo, one set of creds, and one biometric unlock:
#
#   1. Dumb chuck — kept FOREVER by default; --rotate opts a snapshot into the prunable pool:
#        ,vault [--rotate] PATH...                     snapshot PATH(s) into the vault
#        ,vault prune                                  forget + prune ONLY the `rotate` pool
#
#   2. Keyed artifacts — identity-tagged, versioned, restorable. This is the API that
#      ,gitvault (and future DOI/HAR/… clients) build on; restic stays hidden behind it:
#        ,vault put --id <key> [--tag S]... PATH...    archive PATH under identity <key>
#        ,vault versions <key> [restic snapshots args] list <key>'s snapshots, oldest→newest
#        ,vault get <key> <dest> [--snapshot <id>]     restore <key> (latest, or a snapshot)
#        ,vault exec -- <restic args>                  escape hatch: raw restic on the vault repo
#
# Identity lives in the restic tag `id:<key>`; --tag values pass through opaquely, so each
# caller owns its own facet vocabulary (e.g. ns:git, repo:…, ref:HEAD, tip:<sha>). Keep <key>
# namespaced (`git:github.com/o/r@HEAD`, `doi:10.x/y`, …) so artifact kinds never collide.
# Keyed artifacts carry no `rotate` tag, so `prune` never touches them — they are keep-forever.
#
# Overrides (also how the local self-test runs, Touch-ID / S3-free):
#   RESTIC_REPOSITORY  target a different repo (rclone-mirror env only exported for rclone:mirror:*)
#   RESTIC_PASSWORD    skip the `fnox exec --profile vault` unlock
set -euo pipefail

# --- help / usage: needs no repo, creds, or unlock — handle it before any of that ----
usage() {
  cat <<'EOF'
usage:
  ,vault [--rotate] PATH...                       chuck PATH(s) in (keep-forever; --rotate = prunable)
  ,vault prune                                    forget + prune the rotate-tagged pool
  ,vault put --id <key> [--tag S]... PATH...      archive PATH under identity <key>
  ,vault versions <key> [restic snapshots args]   list <key>'s snapshots, oldest→newest
  ,vault get <key> <dest> [--snapshot <id>]       restore <key> (latest, or a snapshot) into <dest>
  ,vault exec -- <restic args>                    raw restic against the vault repo
EOF
}
die_usage() { usage >&2; exit 2; }

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  '') die_usage ;;
esac

# --- repo + backend ------------------------------------------------------------------
# NOTE: own copy of the rclone-mirror block — deliberately NOT shared with ,backup yet,
# since the remotes/credentials may be reworked so work content lands in work-managed
# buckets (see TODO.md). DRY it only once that shape settles.
: "${RESTIC_REPOSITORY:=rclone:mirror:vault}"
export RESTIC_REPOSITORY
if [[ "$RESTIC_REPOSITORY" == rclone:mirror:* ]]; then
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

command -v restic >/dev/null || { echo "vault: restic not on PATH (need the mise shims dir)" >&2; exit 1; }
if [[ -n "${RESTIC_PASSWORD:-}" ]]; then
  run() { restic "$@"; }                             # creds already in the env
else
  command -v fnox >/dev/null || { echo "vault: fnox not on PATH (need the mise shims dir)" >&2; exit 1; }
  # Mint ONE biometric unlock, but LAZILY — on the first restic call, never for help or a
  # malformed invocation that exits before touching the repo (see ,backup for the full
  # rationale). fnox then resolves the vault profile under a single session (tap-free after the
  # first prompt) instead of a cold, concurrent per-secret unlock that both spams Touch ID and
  # can blank a key. Skipped when a session is already inherited (e.g. ,gitvault unlocked once
  # for a batch) or bwbio is absent; a failed unlock falls through to fnox's own prompting.
  _unlocked=0
  run() {
    if ((!_unlocked)); then
      _unlocked=1
      if [[ -z "${BW_SESSION:-}" ]] && command -v bwbio >/dev/null; then
        if session="$(bwbio unlock --raw 2>/dev/null)" && [[ -n "$session" ]]; then
          export BW_SESSION="$session"
        else
          echo "vault: biometric unlock unavailable — fnox will resolve per-secret (may prompt)" >&2
        fi
      fi
    fi
    fnox exec --profile vault -- restic "$@"
  }
fi

# --- dispatch (everything below needs the repo) --------------------------------------
case "$1" in
  prune)
    shift
    [[ $# -eq 0 ]] || { echo "vault: 'prune' takes no arguments" >&2; exit 2; }
    # Rotate-scoped: pool EVERY `rotate`-tagged snapshot (--group-by '' ignores host/paths/tags),
    # keep all younger than 90d plus a 3-snapshot floor so a fresh opt-in never prunes your only
    # rotating copies. Keep-forever (untagged / keyed) snapshots are out of scope by --tag.
    run forget --tag rotate --group-by '' --keep-within 90d --keep-last 3 --prune
    ;;
  put)
    shift
    id=""
    tags=()
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --id) id="${2:-}"; shift 2 || die_usage ;;
        --id=*) id="${1#--id=}"; shift ;;
        --tag) tags+=(--tag "${2:-}"); shift 2 || die_usage ;;
        --tag=*) tags+=(--tag "${1#--tag=}"); shift ;;
        --) shift; break ;;
        -*) echo "vault put: unknown flag: $1" >&2; exit 2 ;;
        *) break ;;
      esac
    done
    [[ -n "$id" ]] || { echo "vault put: --id <key> is required" >&2; exit 2; }
    [[ $# -gt 0 ]] || { echo "vault put: need at least one PATH" >&2; exit 2; }
    run backup --tag "id:$id" ${tags[@]+"${tags[@]}"} -- "$@"
    ;;
  versions)
    shift
    [[ $# -ge 1 ]] || die_usage
    key="$1"; shift
    run snapshots --tag "id:$key" "$@"
    ;;
  get)
    shift
    snap="latest"
    pos=()
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --snapshot) snap="${2:-}"; shift 2 || die_usage ;;
        --snapshot=*) snap="${1#--snapshot=}"; shift ;;
        --) shift; pos+=("$@"); break ;;
        *) pos+=("$1"); shift ;;
      esac
    done
    [[ ${#pos[@]} -eq 2 ]] || { echo "vault get: usage: ,vault get <key> <dest> [--snapshot <id>]" >&2; exit 2; }
    key="${pos[0]}"; dest="${pos[1]}"
    mkdir -p "$dest"
    # restic recreates the artifact under its original absolute path within <dest>; the caller
    # locates it (e.g. `find <dest> -name '*.bundle'`). `latest` is scoped by the id tag so it
    # resolves to the newest snapshot of THIS key, not the repo-wide latest.
    if [[ "$snap" == latest ]]; then
      run restore latest --tag "id:$key" --target "$dest"
    else
      run restore "$snap" --target "$dest"
    fi
    ;;
  exec)
    shift
    [[ "${1:-}" == "--" ]] && shift
    [[ $# -gt 0 ]] || { echo "vault exec: need restic args after --" >&2; exit 2; }
    run "$@"
    ;;
  --rotate)
    shift
    [[ $# -gt 0 ]] || die_usage
    run backup --tag rotate -- "$@"
    ;;
  *)
    run backup -- "$@"
    ;;
esac
