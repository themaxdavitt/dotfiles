#!/usr/bin/env -S uv run --script
# -*- mode: python -*-
#
# /// script
# requires-python = ">=3.14"
# dependencies = [
#   "packaging>=25.0",
#   "typer>=0.26.7",
# ]
# [tool.uv]
# exclude-newer = "2026-07-25T03:46:51Z"
# ///
"""URL-keyed, append-only Git archival on top of the content vault.

Every archive is a ``url@<ref>`` git bundle stored in the `vault` restic repo via the
`,vault` keyed-artifact verbs (put/versions/get) — restic's forever-retention + dedup
give the append-only guarantee, so there is no prune. `refresh` advances a mutable
``@HEAD`` snapshot; a fast-forward is a normal new version, and a non-fast-forward
(force-push) is archived too but stamped as a history-segment boundary you can inspect
with `timeline`. Submodules are archived recursively as their own ``url@<pinsha>`` records.

Identity is namespaced so future non-git artifact kinds can share the vault without
collision: the vault id is ``git:<canonical-url>@<ref>`` and each snapshot also carries
independent facet tags (ns:git, repo:<url>, ref:<ref>, tip:<sha>, and on a force-push
event:force-push + prev-tip:<sha>), plus child:<child-id> edges for submodules.
"""

import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from pathlib import Path
from urllib.parse import urlparse, urlunparse

import typer
from packaging.version import InvalidVersion, Version

__version__ = "0.1.0"

ARCHIVE_REF = "refs/heads/archive"


# --- errors -------------------------------------------------------------------


class ReposError(Exception):
    """Base error for expected failures."""


class GitError(ReposError):
    def __init__(self, args: list[str], returncode: int, stdout: str, stderr: str):
        command = " ".join(args)
        detail = stderr.strip() or stdout.strip() or f"exit code {returncode}"
        super().__init__(f"{command}: {detail}")


class UnanchorablePinError(ReposError):
    def __init__(self, parent_key: str, child_key: str, pinned_sha: str):
        self.parent_key = parent_key
        self.child_key = child_key
        super().__init__(f"could not anchor submodule commit {pinned_sha} for {child_key} referenced by {parent_key}")


# --- git helpers --------------------------------------------------------------


def git(args: list[str], *, cwd: Path | None = None, check: bool = True) -> subprocess.CompletedProcess[str]:
    command = ["git", *args]
    result = subprocess.run(command, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if check and result.returncode != 0:
        raise GitError(command, result.returncode, result.stdout, result.stderr)
    return result


def git_out(args: list[str], *, cwd: Path | None = None, check: bool = True) -> str:
    return git(args, cwd=cwd, check=check).stdout.strip()


def git_lines(args: list[str], *, cwd: Path | None = None, check: bool = True) -> list[str]:
    return [line for line in git(args, cwd=cwd, check=check).stdout.splitlines() if line]


def object_exists(repo: Path, rev: str) -> bool:
    return git(["cat-file", "-e", rev], cwd=repo, check=False).returncode == 0


def rev_parse(repo: Path, rev: str) -> str:
    return git_out(["rev-parse", rev], cwd=repo)


def is_ancestor(repo: Path, old: str, new: str) -> bool:
    return git(["merge-base", "--is-ancestor", old, new], cwd=repo, check=False).returncode == 0


def ref_exists(repo: Path, ref: str) -> bool:
    return git(["show-ref", "--verify", "--quiet", ref], cwd=repo, check=False).returncode == 0


def delete_ref(repo: Path, ref: str) -> None:
    if ref_exists(repo, ref):
        git(["update-ref", "-d", ref], cwd=repo)


# --- URL canonicalization (ported from repos-cli; collapses git's many-URLs→one-repo) --

_SCP_RE = re.compile(r"^(?:(?P<user>[^@/:]+)@)?(?P<host>[^/:]+):(?P<path>.+)$")
_SCHEME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*://")


def looks_like_url(value: str) -> bool:
    value = value.strip()
    return bool(_SCHEME_RE.match(value) or _SCP_RE.match(value))


def _strip_git(path: str) -> str:
    path = path.strip().rstrip("/")
    if path.endswith(".git"):
        path = path[:-4]
    return path.strip("/")


def canonicalize_url(value: str) -> str:
    raw = value.strip()
    if not raw:
        raise ReposError("empty repository URL")

    scp = _SCP_RE.match(raw)
    if scp and not _SCHEME_RE.match(raw):
        host = scp.group("host").lower()
        path = _strip_git(scp.group("path"))
        if not path:
            raise ReposError(f"repository URL has no path: {value}")
        return f"{host}/{path}"

    parsed = urlparse(raw)
    if parsed.scheme:
        if parsed.scheme == "file":
            host = (parsed.hostname or "local").lower()
            path = _strip_git(parsed.path)
            if not path:
                raise ReposError(f"repository URL has no path: {value}")
            return f"{host}/{path}"
        if not parsed.netloc:
            raise ReposError(f"repository URL has no host: {value}")
        host = (parsed.hostname or "").lower()
        path = _strip_git(parsed.path)
        if not host or not path:
            raise ReposError(f"repository URL has no host/path: {value}")
        return f"{host}/{path}"

    path = Path(raw).expanduser()
    if path.is_absolute() or raw.startswith("."):
        stripped = _strip_git(path.resolve().as_posix())
        if not stripped:
            raise ReposError(f"repository path has no name: {value}")
        return f"local/{stripped}"

    if "/" in raw:
        return _strip_git(raw)

    raise ReposError(f"cannot canonicalize repository URL or key: {value}")


def sanitize_url_for_storage(value: str) -> str:
    raw = value.strip()
    parsed = urlparse(raw)
    if parsed.scheme and parsed.netloc:
        host = parsed.hostname or ""
        if parsed.port:
            host = f"{host}:{parsed.port}"
        if parsed.username and parsed.password is None and parsed.scheme in {"ssh", "git+ssh"}:
            host = f"{parsed.username}@{host}"
        return urlunparse((parsed.scheme, host, parsed.path, "", parsed.query, parsed.fragment))
    return raw


def key_to_synthetic_url(url_key: str) -> str:
    if url_key.startswith("local/"):
        return "/" + url_key.removeprefix("local/").lstrip("/")
    host, _, path = url_key.partition("/")
    return f"https://{host}/{path}.git"


def is_probable_key(value: str) -> bool:
    return not looks_like_url(value) and "/" in value


def make_key(url_key: str, ref: str) -> str:
    return f"{url_key}@{ref}"


def split_key(key: str) -> tuple[str, str | None]:
    base, sep, ref = key.rpartition("@")
    if not sep:
        return key, None
    return base, ref


def url_key_of(key: str) -> str:
    return split_key(key)[0]


def vault_id(key: str) -> str:
    """The namespaced vault identity for an archive key."""
    return f"git:{key}"


# --- data ---------------------------------------------------------------------


@dataclass(frozen=True)
class ModuleEntry:
    name: str
    path: str
    url: str


@dataclass(frozen=True)
class CommandResult:
    key: str
    status: str
    detail: str | None = None


@dataclass(frozen=True)
class RepoInfo:
    key: str
    url: str
    snapshots: int
    last_refresh: str | None


@dataclass(frozen=True)
class Edge:
    parent_key: str
    child_key: str


@dataclass(frozen=True)
class TimelineEntry:
    time: str
    snapshot: str
    tip: str
    kind: str
    detail: str | None = None


# --- vault backend (thin wrapper over the `,vault` keyed-artifact verbs) -------


class Vault:
    """Storage layer: the `,vault` repo reached through its put/versions/get verbs.

    Overridable via GITVAULT_VAULT (e.g. `bash …/,vault.sh` for the local self-test).
    """

    def __init__(self) -> None:
        self.cmd = shlex.split(os.environ.get("GITVAULT_VAULT", ",vault"))

    def _run(self, args: list[str]) -> subprocess.CompletedProcess[str]:
        # Always capture: restic's own progress chatter would otherwise interleave with
        # ,gitvault's clean per-key status lines. Surfaced only when a call fails.
        proc = subprocess.run(
            [*self.cmd, *args],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        if proc.returncode != 0:
            detail = (proc.stderr or proc.stdout or "").strip()
            raise ReposError(f",vault {' '.join(args)} failed: {detail or f'exit {proc.returncode}'}")
        return proc

    def put(self, vid: str, path: Path, tags: list[tuple[str, str]]) -> None:
        args = ["put", "--id", vid]
        for key, value in tags:
            args += ["--tag", f"{key}:{value}"]
        args += ["--", str(path)]
        self._run(args)

    def versions(self, vid: str) -> list[dict]:
        proc = self._run(["versions", vid, "--json"])
        snaps = json.loads(proc.stdout or "[]")
        snaps.sort(key=lambda s: s["time"])
        return snaps

    def latest(self, vid: str) -> dict | None:
        snaps = self.versions(vid)
        return snaps[-1] if snaps else None

    def has(self, vid: str) -> bool:
        return bool(self.versions(vid))

    def get(self, vid: str, dest: Path, *, snapshot: str | None = None) -> Path:
        args = ["get", vid, str(dest)]
        if snapshot:
            args += ["--snapshot", snapshot]
        self._run(args)
        bundles = sorted(Path(dest).rglob("*.bundle"))
        if not bundles:
            raise ReposError(f"no bundle restored for {vid}")
        return bundles[0]

    def all_git_snapshots(self) -> list[dict]:
        proc = self._run(["exec", "--", "snapshots", "--tag", "ns:git", "--json"])
        return json.loads(proc.stdout or "[]")


def ensure_session() -> None:
    """Mint ONE biometric unlock up front so the batch of `,vault` children run tap-free.

    Mirrors the single-unlock block in `,vault`/`,backup`; skipped when creds are already
    in the env (RESTIC_PASSWORD, e.g. the local self-test) or a session is inherited.
    """
    if os.environ.get("RESTIC_PASSWORD") or os.environ.get("BW_SESSION"):
        return
    if not shutil.which("bwbio"):
        return
    proc = subprocess.run(["bwbio", "unlock", "--raw"], text=True, capture_output=True, check=False)
    session = proc.stdout.strip()
    if proc.returncode == 0 and session:
        os.environ["BW_SESSION"] = session
    else:
        print(
            ",gitvault: biometric unlock unavailable — ,vault will resolve per call (may prompt)",
            file=sys.stderr,
        )


# --- manager ------------------------------------------------------------------


@contextmanager
def temp_bare_hub():
    with tempfile.TemporaryDirectory(prefix="gitvault-hub-") as tmp:
        hub = Path(tmp) / "hub"
        git(["init", "--bare", str(hub)])
        yield hub


class GitVault:
    def __init__(self) -> None:
        ensure_session()
        self.vault = Vault()

    # ------------------------------------------------------------------ verbs

    def add(self, url: str, ref: str | None = None) -> CommandResult:
        return self._archive(url, ref, visited=set())

    def refresh(self, target: str) -> list[CommandResult]:
        return self._refresh_url(self._url_key(target), self._source_url(target), set())

    def refresh_all(self) -> tuple[list[CommandResult], list[tuple[str, str]]]:
        results: list[CommandResult] = []
        failures: list[tuple[str, str]] = []
        visited: set[str] = set()
        for url_key in sorted({url_key_of(key) for key in self._snapshots_by_id()}):
            try:
                results.extend(self._refresh_url(url_key, key_to_synthetic_url(url_key), visited))
            except ReposError as exc:
                failures.append((url_key, str(exc)))
        return results, failures

    def list_repos(self) -> list[RepoInfo]:
        rows: list[RepoInfo] = []
        for key, snaps in sorted(self._snapshots_by_id().items()):
            rows.append(
                RepoInfo(
                    key=key,
                    url=key_to_synthetic_url(url_key_of(key)),
                    snapshots=len(snaps),
                    last_refresh=snaps[-1]["time"] if snaps else None,
                )
            )
        return rows

    def timeline(self, target: str) -> list[TimelineEntry]:
        key = self._timeline_key(target)
        snaps = self._snapshots_by_id().get(key, [])
        entries: list[TimelineEntry] = []
        for index, snap in enumerate(snaps):
            tags = self._tag_map(snap)
            tip = tags.get("tip", "")
            if tags.get("event") == "force-push":
                kind = "force-push"
                detail = f"segment boundary — prior tip {tags.get('prev-tip', '?')[:12]} preserved"
            elif index == 0:
                kind = "initial"
                detail = None
            else:
                kind = "fast-forward"
                detail = None
            entries.append(
                TimelineEntry(time=snap["time"], snapshot=snap["short_id"], tip=tip, kind=kind, detail=detail)
            )
        return entries

    def who(self, target: str) -> list[Edge]:
        url_key = self._url_key(target)
        prefix = f"child:{vault_id(url_key)}@"
        edges: list[Edge] = []
        for snap in self.vault.all_git_snapshots():
            parent = self._snapshot_key(snap)
            if not parent:
                continue
            for tag in snap.get("tags", []):
                if tag.startswith(prefix):
                    edges.append(Edge(parent_key=parent, child_key=tag.removeprefix("child:")))
        edges.sort(key=lambda edge: (edge.parent_key, edge.child_key))
        return edges

    def verify(self, target: str) -> list[dict[str, str]]:
        key = self._exact_key(target)
        with tempfile.TemporaryDirectory(prefix="gitvault-verify-") as tmp:
            bundle = self.vault.get(vault_id(key), Path(tmp))
            # `git bundle verify` needs a repository context to resolve prerequisites against;
            # our callers run from anywhere, so give it a throwaway one (the --all bundle is
            # self-contained, so an empty repo is enough to confirm it is well-formed).
            scratch = Path(tmp) / "verify-repo"
            git(["init", "-q", str(scratch)])
            result = git(["bundle", "verify", str(bundle)], cwd=scratch, check=False)
            ok = result.returncode == 0
            return [
                {
                    "key": key,
                    "status": "OK" if ok else "FAILED",
                    "detail": "" if ok else (result.stderr or result.stdout).strip(),
                }
            ]

    def clone(self, target: str, dest: Path | None, snapshot: str | None = None) -> Path:
        key = self._exact_key(target)
        dest = dest or Path.cwd() / Path(url_key_of(key)).name
        if dest.exists():
            raise ReposError(f"destination already exists: {dest}")
        with tempfile.TemporaryDirectory(prefix="gitvault-clone-") as tmp:
            bundle = self.vault.get(vault_id(key), Path(tmp), snapshot=snapshot)
            dest.parent.mkdir(parents=True, exist_ok=True)
            git(["clone", str(bundle), str(dest)])
        return dest

    # ---------------------------------------------------------- target plumbing

    def _is_key(self, value: str) -> bool:
        value = value.strip()
        return "@" in value and is_probable_key(value)

    def _url_key(self, value: str) -> str:
        return url_key_of(value.strip()) if self._is_key(value) else canonicalize_url(value)

    def _exact_key(self, value: str) -> str:
        value = value.strip().strip("/")
        if self._is_key(value):
            return value
        raise ReposError(f"expected a snapshot key like url@ref: {value}")

    def _timeline_key(self, value: str) -> str:
        return value.strip() if self._is_key(value) else make_key(self._url_key(value), "HEAD")

    def _source_url(self, value: str) -> str:
        if self._is_key(value):
            return key_to_synthetic_url(url_key_of(value.strip()))
        return sanitize_url_for_storage(value)

    # ----------------------------------------------------------------- archive

    def _archive(self, target: str, ref: str | None, *, visited: set[str]) -> CommandResult:
        url_key = self._url_key(target)
        src = self._source_url(target)
        kind, want = self._classify_ref(src, ref)
        if kind == "tag":
            return self._archive_tag(url_key, src, want, visited)
        if kind == "head":
            return self._archive_head(url_key, src, visited)
        return self._archive_sha(url_key, src, want, visited)

    def _refresh_url(self, url_key: str, src: str, visited: set[str]) -> list[CommandResult]:
        results: list[CommandResult] = []
        # Advance an existing @HEAD snapshot (fast-forward or force-push, both archived).
        if self.vault.has(vault_id(make_key(url_key, "HEAD"))):
            results.append(self._archive_head(url_key, src, visited))
        # Ensure the latest tag is archived (additive; immutable no-op if already present).
        latest = self._highest_semver(self._ls_remote_tags(src))
        if latest:
            results.append(self._archive_tag(url_key, src, latest, visited))
        # A tagless repo with nothing archived yet: snapshot HEAD fresh.
        if not results:
            results.append(self._archive_head(url_key, src, visited))
        return results

    def _archive_tag(self, url_key: str, src: str, tag: str, visited: set[str]) -> CommandResult:
        key = make_key(url_key, tag)
        if key in visited:
            return CommandResult(key, "SKIPPED", "already visited")
        visited.add(key)
        if self.vault.has(vault_id(key)):
            return CommandResult(key, "OK", "immutable (already archived)")
        with temp_bare_hub() as hub:
            git(["fetch", src, f"+refs/tags/{tag}:refs/incoming"], cwd=hub)
            sha = git_out(["rev-parse", "refs/incoming^{commit}"], cwd=hub)
            self._set_archive(hub, sha)
            self._prune_to_archive(hub)
            children = self._archive_submodules(key, src, hub, sha, visited)
            self._store(key, hub, {"ref": tag, "tip": sha}, children)
        return CommandResult(key, "OK")

    def _archive_head(self, url_key: str, src: str, visited: set[str]) -> CommandResult:
        key = make_key(url_key, "HEAD")
        if key in visited:
            return CommandResult(key, "SKIPPED", "already visited")
        visited.add(key)

        branch_ref, _ = self._ls_remote_head(src)
        prev = self.vault.latest(vault_id(key))
        with temp_bare_hub() as hub:
            old: str | None = None
            if prev:
                self._restore_into_hub(vault_id(key), hub, prev["short_id"])
                old = rev_parse(hub, ARCHIVE_REF)
            git(["fetch", src, f"+{branch_ref or 'HEAD'}:refs/incoming"], cwd=hub)
            new = git_out(["rev-parse", "refs/incoming^{commit}"], cwd=hub)

            event: str | None = None
            if old is not None:
                if old == new:
                    delete_ref(hub, "refs/incoming")
                    return CommandResult(key, "OK", "unchanged")
                if not is_ancestor(hub, old, new):
                    event = "force-push"
            delete_ref(hub, "refs/incoming")

            self._set_archive(hub, new)
            self._prune_to_archive(hub)
            children = self._archive_submodules(key, src, hub, new, visited)
            facets = {"ref": "HEAD", "tip": new}
            if event:
                facets["event"] = event
                facets["prev-tip"] = old or ""
            self._store(key, hub, facets, children)
        if event:
            return CommandResult(key, "OK", f"force-push (prev {old[:12] if old else '?'})")
        return CommandResult(key, "OK", "fast-forward" if prev else "new")

    def _archive_sha(
        self,
        url_key: str,
        src: str,
        want: str,
        visited: set[str],
        *,
        source_hints: tuple[Path, ...] = (),
        pin_context: tuple[str, str] | None = None,
    ) -> CommandResult:
        with temp_bare_hub() as hub:
            if not self._populate_until_present(hub, src, want, source_hints):
                if pin_context:
                    raise UnanchorablePinError(pin_context[0], make_key(pin_context[1], want), want)
                raise ReposError(f"cannot locate commit {want} for {url_key}")
            full = git_out(["rev-parse", f"{want}^{{commit}}"], cwd=hub)
            key = make_key(url_key, full)
            if key in visited:
                return CommandResult(key, "SKIPPED", "already visited")
            visited.add(key)
            if self.vault.has(vault_id(key)):
                return CommandResult(key, "OK", "immutable (already archived)")
            self._set_archive(hub, full)
            self._prune_to_archive(hub)
            children = self._archive_submodules(key, src, hub, full, visited)
            self._store(key, hub, {"ref": full, "tip": full}, children)
        return CommandResult(key, "OK")

    def _archive_submodules(
        self, parent_key: str, parent_url: str, hub: Path, commit: str, visited: set[str]
    ) -> list[str]:
        modules = self._gitmodules_from_commit(hub, commit)
        if not modules:
            return []
        gitlinks = self._gitlinks_from_commit(hub, commit)
        pinned = [(module, gitlinks[module.path]) for module in modules if module.path in gitlinks]
        if not pinned:
            return []
        resolved = self._resolve_submodule_urls(hub, parent_url, commit, [m for m, _ in pinned])
        child_ids: list[str] = []
        seen: set[tuple[str, str]] = set()
        for module, pin in pinned:
            target = resolved.get(module.path)
            if not target:
                continue
            child_url_key = canonicalize_url(target)
            dedup = (child_url_key, pin)
            if dedup in seen:
                continue
            seen.add(dedup)
            result = self._archive_sha(
                child_url_key,
                sanitize_url_for_storage(target),
                pin,
                visited,
                source_hints=self._local_pin_sources(parent_url, module.path, pin),
                pin_context=(parent_key, child_url_key),
            )
            child_ids.append(vault_id(result.key))
        return child_ids

    # ------------------------------------------------------------------ storage

    def _store(self, key: str, hub: Path, facets: dict[str, str], child_ids: list[str]) -> None:
        tags: list[tuple[str, str]] = [("ns", "git"), ("repo", url_key_of(key))]
        tags += list(facets.items())
        tags += [("child", child_id) for child_id in child_ids]
        with tempfile.TemporaryDirectory(prefix="gitvault-bundle-") as tmp:
            bundle = Path(tmp) / f"{key.replace('/', '_').replace('@', '_')}.bundle"
            git(["bundle", "create", str(bundle), "--all"], cwd=hub)
            verify = git(["bundle", "verify", str(bundle)], cwd=hub, check=False)
            if verify.returncode != 0:
                raise ReposError((verify.stderr or verify.stdout).strip())
            self.vault.put(vault_id(key), bundle, tags)

    def _restore_into_hub(self, vid: str, hub: Path, snapshot: str) -> None:
        with tempfile.TemporaryDirectory(prefix="gitvault-restore-") as tmp:
            bundle = self.vault.get(vid, Path(tmp), snapshot=snapshot)
            git(["fetch", str(bundle), "+refs/*:refs/*"], cwd=hub)
            git(["symbolic-ref", "HEAD", ARCHIVE_REF], cwd=hub)

    def _set_archive(self, repo: Path, commit: str) -> None:
        git(["update-ref", ARCHIVE_REF, commit], cwd=repo)
        git(["symbolic-ref", "HEAD", ARCHIVE_REF], cwd=repo)

    def _prune_to_archive(self, repo: Path) -> None:
        for ref in git_lines(["for-each-ref", "--format=%(refname)", "refs"], cwd=repo):
            if ref != ARCHIVE_REF:
                delete_ref(repo, ref)

    def _clear_namespace(self, repo: Path, prefix: str) -> None:
        for ref in git_lines(["for-each-ref", "--format=%(refname)", prefix], cwd=repo):
            delete_ref(repo, ref)

    # ---------------------------------------------------------- ref resolution

    def _classify_ref(self, src: str, ref: str | None) -> tuple[str, str]:
        if ref is None:
            latest = self._highest_semver(self._ls_remote_tags(src))
            return ("tag", latest) if latest else ("head", "HEAD")
        ref = ref.strip()
        if ref.upper() == "HEAD":
            return ("head", "HEAD")
        if self._is_sha(ref):
            return ("sha", ref.lower())
        return ("tag", ref)

    @staticmethod
    def _is_sha(value: str) -> bool:
        return 7 <= len(value) <= 40 and all(c in "0123456789abcdef" for c in value.lower())

    @staticmethod
    def _highest_semver(tags: list[str]) -> str | None:
        parsed: list[tuple[Version, str]] = []
        for tag in tags:
            try:
                parsed.append((Version(tag), tag))
            except InvalidVersion:
                continue
        if not parsed:
            return None
        finals = [vt for vt in parsed if not vt[0].is_prerelease]
        return max(finals or parsed, key=lambda vt: vt[0])[1]

    def _ls_remote_tags(self, src: str) -> list[str]:
        tags: list[str] = []
        for line in git_lines(["ls-remote", "--tags", src]):
            if line.endswith("^{}"):
                continue
            _sha, _tab, ref = line.partition("\t")
            if ref.startswith("refs/tags/"):
                tags.append(ref.removeprefix("refs/tags/"))
        return tags

    def _ls_remote_head(self, src: str) -> tuple[str | None, str | None]:
        branch_ref: str | None = None
        sha: str | None = None
        for line in git_lines(["ls-remote", "--symref", src, "HEAD"]):
            if line.startswith("ref:"):
                branch_ref = line.split()[1]
            else:
                value, _tab, ref = line.partition("\t")
                if ref.strip() == "HEAD":
                    sha = value
        return branch_ref, sha

    # --------------------------------------------------------- object plumbing

    def _populate_until_present(self, repo: Path, src: str, want: str, sources) -> bool:
        for source in [src, *sources]:
            if source is None:
                continue
            git(
                [
                    "fetch",
                    str(source),
                    "+refs/heads/*:refs/srctmp/h/*",
                    "+refs/tags/*:refs/srctmp/t/*",
                ],
                cwd=repo,
                check=False,
            )
            present = object_exists(repo, f"{want}^{{commit}}")
            self._clear_namespace(repo, "refs/srctmp")
            if present:
                return True
        return False

    def _local_pin_sources(self, parent_url: str, path: str, pin: str) -> tuple[Path, ...]:
        parent_path = self._local_path_from_url(parent_url)
        if parent_path is None or not parent_path.exists():
            return ()
        hints: list[Path] = []
        worktree = parent_path / path
        if worktree.exists() and object_exists(worktree, f"{pin}^{{commit}}"):
            hints.append(worktree)
        git_path = git(["rev-parse", "--git-path", f"modules/{path}"], cwd=parent_path, check=False)
        if git_path.returncode == 0:
            module_dir = Path(git_path.stdout.strip())
            if not module_dir.is_absolute():
                module_dir = parent_path / module_dir
            if module_dir.exists() and object_exists(module_dir, f"{pin}^{{commit}}"):
                hints.append(module_dir)
        return tuple(hints)

    def _local_path_from_url(self, url: str) -> Path | None:
        parsed = urlparse(url)
        if parsed.scheme == "file":
            return Path(parsed.path).expanduser()
        if parsed.scheme:
            return None
        path = Path(url).expanduser()
        return path if path.exists() else None

    # -------------------------------------------------------------- submodules

    def _resolve_submodule_urls(
        self, hub: Path, parent_url: str, commit: str, modules: list[ModuleEntry]
    ) -> dict[str, str]:
        resolved = {m.path: m.url for m in modules if self._is_absolute(m.url)}
        relative = [m for m in modules if not self._is_absolute(m.url)]
        if relative:
            with tempfile.TemporaryDirectory(prefix="gitvault-resolve-") as tmp:
                checkout = Path(tmp) / "checkout"
                git(["clone", "--local", "--no-checkout", str(hub), str(checkout)])
                git(["checkout", "--detach", commit], cwd=checkout)
                for module in relative:
                    resolved[module.path] = self._resolve_relative_submodule_url(
                        checkout, parent_url, module, context=f"{commit}:{module.path}"
                    )
        return resolved

    def _is_absolute(self, url: str) -> bool:
        return looks_like_url(url) or Path(url).expanduser().is_absolute()

    def _resolve_relative_submodule_url(
        self, checkout: Path, parent_url: str, module: ModuleEntry, *, context: str
    ) -> str:
        original = git(["config", "--get", "remote.origin.url"], cwd=checkout, check=False)
        original_url = original.stdout.strip()
        try:
            git(["config", "remote.origin.url", parent_url], cwd=checkout)
            git(["submodule", "init", "--", module.path], cwd=checkout)
            resolved = git_out(["config", "--get", f"submodule.{module.name}.url"], cwd=checkout)
        finally:
            if original.returncode == 0:
                git(["config", "remote.origin.url", original_url], cwd=checkout, check=False)
            else:
                git(["config", "--unset", "remote.origin.url"], cwd=checkout, check=False)
        if not resolved:
            raise ReposError(f"could not resolve submodule URL for {context}")
        return resolved

    def _gitmodules_from_commit(self, repo: Path, commit: str) -> list[ModuleEntry]:
        if not object_exists(repo, f"{commit}:.gitmodules"):
            return []
        result = git(
            ["config", "--blob", f"{commit}:.gitmodules", "--get-regexp", r"^submodule\..*\.(path|url)$"],
            cwd=repo,
            check=False,
        )
        if result.returncode != 0:
            return []
        return self._parse_gitmodules_config(result.stdout)

    def _gitlinks_from_commit(self, repo: Path, commit: str) -> dict[str, str]:
        result = git(["ls-tree", "-rz", "--full-tree", commit], cwd=repo)
        gitlinks: dict[str, str] = {}
        for entry in result.stdout.split("\0"):
            if not entry:
                continue
            header, _, path = entry.partition("\t")
            parts = header.split()
            if path and len(parts) >= 3 and parts[0] == "160000":
                gitlinks[path] = parts[2]
        return gitlinks

    def _parse_gitmodules_config(self, output: str) -> list[ModuleEntry]:
        by_name: dict[str, dict[str, str]] = {}
        for key, value in (line.split(" ", 1) for line in output.splitlines() if " " in line):
            if key.endswith((".path", ".url")):
                name, field = key.removeprefix("submodule.").rsplit(".", 1)
                by_name.setdefault(name, {})[field] = value
        return [
            ModuleEntry(name=name, path=values["path"], url=values["url"])
            for name, values in by_name.items()
            if "path" in values and "url" in values
        ]

    # ------------------------------------------------------------------ derive

    def _snapshots_by_id(self) -> dict[str, list[dict]]:
        groups: dict[str, list[dict]] = {}
        for snap in self.vault.all_git_snapshots():
            key = self._snapshot_key(snap)
            if key:
                groups.setdefault(key, []).append(snap)
        for snaps in groups.values():
            snaps.sort(key=lambda s: s["time"])
        return groups

    @staticmethod
    def _snapshot_key(snap: dict) -> str | None:
        for tag in snap.get("tags", []):
            if tag.startswith("id:git:"):
                return tag.removeprefix("id:git:")
        return None

    @staticmethod
    def _tag_map(snap: dict) -> dict[str, str]:
        out: dict[str, str] = {}
        for tag in snap.get("tags", []):
            facet, _, value = tag.partition(":")
            out[facet] = value
        return out


# --- CLI ----------------------------------------------------------------------

app = typer.Typer(
    help=__doc__,
    no_args_is_help=True,
    add_completion=False,
)


def _run(action):
    try:
        return action(GitVault())
    except ReposError as exc:
        typer.secho(str(exc), fg=typer.colors.RED, err=True)
        raise typer.Exit(code=1) from exc


def _print_result(result: CommandResult) -> None:
    detail = f" ({result.detail})" if result.detail else ""
    typer.echo(f"{result.key}: {result.status}{detail}")


def _print_json(data) -> None:
    typer.echo(json.dumps(data, indent=2))


def _print_rows(title: str, headers, rows) -> None:
    typer.echo(title)
    typer.echo("\t".join(headers))
    for row in rows:
        typer.echo("\t".join("" if value is None else str(value) for value in row))


def _version(value: bool) -> None:
    if value:
        typer.echo(__version__)
        raise typer.Exit()


@app.callback()
def _root(
    version: bool = typer.Option(False, "--version", callback=_version, is_eager=True, help="Show version and exit."),
) -> None:
    """URL-keyed append-only Git archival on top of the content vault."""


@app.command()
def add(
    url: str,
    ref: str | None = typer.Argument(None, help="Tag, HEAD, or sha to pin. Default: highest semver tag, else HEAD."),
) -> None:
    """Archive a snapshot of URL (and its submodules) into the vault."""
    _print_result(_run(lambda manager: manager.add(url, ref)))


@app.command()
def refresh(
    target: str | None = typer.Argument(None),
    all_repos: bool = typer.Option(False, "--all", help="Refresh every archived repository."),
) -> None:
    """Advance @HEAD (archiving force-pushes) and pick up newer tags, additively."""
    if all_repos and target:
        raise typer.BadParameter("pass either TARGET or --all, not both")
    if not all_repos and not target:
        raise typer.BadParameter("pass TARGET or --all")
    if not all_repos:
        for result in _run(lambda manager: manager.refresh(target or "")):
            _print_result(result)
        return
    results, failures = _run(lambda manager: manager.refresh_all())
    for result in results:
        _print_result(result)
    for key, detail in failures:
        typer.secho(f"{key}: FAILED ({detail})", fg=typer.colors.RED, err=True)
    if failures:
        raise typer.Exit(code=1)


@app.command()
def key(url: str) -> None:
    """Print the canonical archive key for URL (no network, no vault)."""
    try:
        typer.echo(canonicalize_url(url))
    except ReposError as exc:
        typer.secho(str(exc), fg=typer.colors.RED, err=True)
        raise typer.Exit(code=1) from exc


@app.command(name="list")
def list_repos(json_output: bool = typer.Option(False, "--json", help="Emit JSON.")) -> None:
    """List archived snapshots."""
    rows = _run(lambda manager: manager.list_repos())
    if json_output:
        _print_json([asdict(row) for row in rows])
        return
    _print_rows(
        "Archived snapshots",
        ("Key", "Snapshots", "Last refresh"),
        ((row.key, row.snapshots, row.last_refresh) for row in rows),
    )


@app.command()
def timeline(
    target: str,
    json_output: bool = typer.Option(False, "--json", help="Emit JSON."),
) -> None:
    """Show a repo's @HEAD (or url@ref) history, marking force-push segment boundaries."""
    entries = _run(lambda manager: manager.timeline(target))
    if json_output:
        _print_json([asdict(entry) for entry in entries])
        return
    if not entries:
        typer.echo("(no snapshots)")
        return
    marker = {"initial": "•", "fast-forward": "→", "force-push": "⚠"}
    for entry in entries:
        label = entry.kind if entry.kind != "fast-forward" else "fast-forward"
        line = f"{marker.get(entry.kind, ' ')} {entry.time}  {entry.tip[:12]:<12}  {label}"
        if entry.detail:
            line += f" — {entry.detail}"
        typer.echo(line)


@app.command()
def who(target: str, json_output: bool = typer.Option(False, "--json", help="Emit JSON.")) -> None:
    """Show which archived superprojects embed TARGET as a submodule."""
    edges = _run(lambda manager: manager.who(target))
    if json_output:
        _print_json([asdict(edge) for edge in edges])
        return
    _print_rows("Embedders", ("Parent", "Child"), ((edge.parent_key, edge.child_key) for edge in edges))


@app.command()
def verify(target: str, json_output: bool = typer.Option(False, "--json", help="Emit JSON.")) -> None:
    """Verify a snapshot's bundle integrity."""
    rows = _run(lambda manager: manager.verify(target))
    if json_output:
        _print_json(rows)
        return
    _print_rows(
        "Bundle verification",
        ("Key", "Status", "Detail"),
        ((row["key"], row["status"], row["detail"]) for row in rows),
    )


@app.command()
def clone(
    target: str,
    dest: str | None = typer.Argument(None, help="Destination path. Default: ./<repo-name>."),
    at: str | None = typer.Option(
        None, "--at", help="Clone a specific timeline snapshot id (e.g. a pre-force-push segment)."
    ),
) -> None:
    """Restore a snapshot's bundle and git-clone it into DEST."""
    typer.echo(str(_run(lambda manager: manager.clone(target, Path(dest) if dest else None, at))))


if __name__ == "__main__":
    app(prog_name=",gitvault")
