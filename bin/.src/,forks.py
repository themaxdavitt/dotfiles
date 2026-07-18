#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.14"
# dependencies = [
#   "PyGithub",
#   "typer",
# ]
# [tool.uv]
# exclude-newer = "2026-07-18T21:32:23Z"
# ///
"""Find recursively discovered GitHub forks with commits beyond a repository.

Scans at most 500 forks by default. Pass ``--max-forks`` to change the cap or
``--all`` to remove it. Authenticate with ``--token`` or ``GH_TOKEN``.
"""

from __future__ import annotations

import json
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from enum import Enum
from typing import Annotated, Any
from urllib.parse import urlparse

import typer
from github import Auth, Github, GithubException, RateLimitExceededException
from rich.console import Console
from rich.live import Live
from rich.markup import escape
from rich.table import Table

DEFAULT_MAX_FORKS = 500
REQUEST_TIMEOUT = 30

app = typer.Typer(add_completion=False, no_args_is_help=True, pretty_exceptions_enable=False, help=__doc__)
console = Console()


class OutputFormat(str, Enum):
    table = "table"
    json = "json"


@dataclass(frozen=True)
class Repository:
    owner: str
    name: str
    full_name: str
    default_branch: str
    stars: int
    forks_count: int
    pushed_at: str


@dataclass(frozen=True)
class UsefulFork:
    repository: str
    url: str
    stars: int
    forks: int
    ahead: int
    behind: int
    pushed_at: str


@dataclass(frozen=True)
class ScanResult:
    forks: list[UsefulFork]
    scanned: int
    capped: bool


ProgressCallback = Callable[[int, list[UsefulFork]], None]


def parse_repository(value: str) -> tuple[str, str]:
    """Return owner and name from OWNER/REPO or a github.com URL."""
    shorthand = value.strip().removesuffix(".git")
    if shorthand.count("/") == 1 and not shorthand.startswith(("http://", "https://")):
        owner, name = shorthand.split("/", maxsplit=1)
    else:
        parsed = urlparse(value)
        if parsed.hostname not in {"github.com", "www.github.com"}:
            raise ValueError("repository must be OWNER/REPO or a github.com URL")
        parts = [part for part in parsed.path.split("/") if part]
        if len(parts) < 2:
            raise ValueError("repository URL must include an owner and repository")
        owner, name = parts[:2]
        name = name.removesuffix(".git")

    if not owner or not name:
        raise ValueError("repository must include an owner and repository")
    return owner, name


def repository_from_api(repository: Any) -> Repository:
    """Project the PyGithub object to the fields needed by the scanner."""
    pushed_at = repository.pushed_at
    return Repository(
        owner=repository.owner.login,
        name=repository.name,
        full_name=repository.full_name,
        default_branch=repository.default_branch,
        stars=repository.stargazers_count,
        forks_count=repository.forks_count,
        pushed_at=pushed_at.date().isoformat() if pushed_at else "",
    )


def is_rate_limit(error: GithubException) -> bool:
    message = str(error.data.get("message", "")).casefold() if isinstance(error.data, dict) else ""
    return isinstance(error, RateLimitExceededException) or error.status == 429 or "rate limit" in message


def useful_forks(
    root_api: Any,
    limit: int | None,
    on_progress: ProgressCallback | None = None,
) -> ScanResult:
    """Walk the fork tree breadth-first and retain forks ahead of ``root_api``."""
    root = repository_from_api(root_api)
    pending = deque([root_api])
    seen = {root.full_name.casefold()}
    found: list[UsefulFork] = []
    scanned = 0
    capped = False

    def report_progress() -> None:
        if on_progress is not None:
            on_progress(scanned, found)

    while pending:
        parent = pending.popleft()
        for fork_api in parent.get_forks():
            fork = repository_from_api(fork_api)
            key = fork.full_name.casefold()
            if key in seen:
                continue
            if limit is not None and scanned >= limit:
                capped = True
                pending.clear()
                break

            seen.add(key)
            scanned += 1
            if fork.forks_count:
                pending.append(fork_api)

            try:
                comparison = root_api.compare(root.default_branch, f"{fork.owner}:{fork.default_branch}")
            except GithubException as error:
                if is_rate_limit(error):
                    raise
                if error.status != 404:
                    typer.echo(f"warning: skipping {fork.full_name}: {error}", err=True)
                report_progress()
                continue

            if comparison.ahead_by <= 0:
                report_progress()
                continue
            found.append(
                UsefulFork(
                    repository=fork.full_name,
                    url=f"https://github.com/{fork.full_name}",
                    stars=fork.stars,
                    forks=fork.forks_count,
                    ahead=comparison.ahead_by,
                    behind=comparison.behind_by,
                    pushed_at=fork.pushed_at,
                )
            )
            report_progress()
        if capped:
            break

    return ScanResult(
        forks=sorted_forks(found),
        scanned=scanned,
        capped=capped,
    )


def sorted_forks(forks: list[UsefulFork]) -> list[UsefulFork]:
    return sorted(forks, key=lambda fork: (-fork.stars, fork.repository.casefold()))


def table_console() -> Console:
    """Keep piped tables wide enough for GitHub's maximum owner/repository name."""
    return console if console.is_terminal else Console(width=240)


def fork_table(forks: list[UsefulFork], caption: str | None = None) -> Table:
    table = Table(caption=caption)
    table.add_column("Repository")
    table.add_column("Stars")
    table.add_column("Forks")
    table.add_column("Ahead")
    table.add_column("Behind")
    table.add_column("Last push")
    for fork in sorted_forks(forks):
        table.add_row(
            f"[link={fork.url}]{escape(fork.repository)}[/link]",
            f"{fork.stars:,}",
            f"{fork.forks:,}",
            str(fork.ahead),
            str(fork.behind),
            fork.pushed_at,
        )
    return table


def print_table(forks: list[UsefulFork]) -> None:
    if not forks:
        table_console().print("No useful forks found.")
        return
    table_console().print(fork_table(forks))


def print_json(forks: list[UsefulFork]) -> None:
    print(
        json.dumps(
            [
                {
                    "repository": fork.repository,
                    "url": fork.url,
                    "stars": fork.stars,
                    "forks": fork.forks,
                    "ahead": fork.ahead,
                    "behind": fork.behind,
                    "pushed_at": fork.pushed_at,
                }
                for fork in forks
            ],
            indent=2,
        )
    )


@app.command()
def main(
    repository: Annotated[str, typer.Argument(metavar="REPOSITORY", help="OWNER/REPO or a GitHub repository URL.")],
    token: Annotated[
        str | None,
        typer.Option("--token", envvar="GH_TOKEN", help="GitHub token (defaults to GH_TOKEN)."),
    ] = None,
    max_forks: Annotated[
        int,
        typer.Option("--max-forks", min=1, help="Maximum discovered forks to scan."),
    ] = DEFAULT_MAX_FORKS,
    all_forks: Annotated[
        bool,
        typer.Option("--all", help="Remove the fork scan limit; may exhaust GitHub API limits."),
    ] = False,
    output_format: Annotated[
        OutputFormat,
        typer.Option("--format", case_sensitive=False, help="Output format."),
    ] = OutputFormat.table,
) -> None:
    """Scan recursively for forks with commits beyond REPOSITORY's default branch."""
    if not token:
        raise typer.BadParameter("pass --token or set GH_TOKEN", param_hint="--token")

    try:
        owner, name = parse_repository(repository)
        with Github(
            auth=Auth.Token(token), per_page=100, timeout=REQUEST_TIMEOUT, user_agent="useful-forks-cli"
        ) as github:
            root = github.get_repo(f"{owner}/{name}")
            limit = None if all_forks else max_forks
            if output_format is OutputFormat.table and console.is_terminal:
                with Live(
                    fork_table([], "Scanning 0 forks · 0 useful"),
                    console=console,
                    refresh_per_second=4,
                    transient=True,
                ) as live:

                    def update_live(scanned: int, found: list[UsefulFork]) -> None:
                        live.update(fork_table(found, f"Scanning {scanned} forks · {len(found)} useful"))

                    result = useful_forks(root, limit, on_progress=update_live)
            else:
                result = useful_forks(root, limit)
    except (GithubException, ValueError) as error:
        typer.echo(f",forks: {error}", err=True)
        raise typer.Exit(2) from error

    if output_format is OutputFormat.json:
        print_json(result.forks)
    else:
        print_table(result.forks)

    cap_note = " (cap reached)" if result.capped else ""
    typer.echo(f"Scanned {result.scanned} fork(s); found {len(result.forks)} useful fork(s){cap_note}.", err=True)


if __name__ == "__main__":
    app(prog_name=",forks")
