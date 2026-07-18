#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.14"
# dependencies = [
#   "haikunator",
#   "typer",
# ]
# [tool.uv]
# exclude-newer = "2026-04-08T12:00:00Z"
# ///
"""Generate a random Heroku-style name (haikunator), e.g. `weathered-wildflower-737`."""

import typer
from haikunator import Haikunator

app = typer.Typer(add_completion=False)


@app.command(help=__doc__)
def main(
    token_length: int = typer.Option(2, "--token-length", "-l"),
    delimiter: str = typer.Option("-", "--delimiter", "-d"),
) -> None:
    print(Haikunator().haikunate(token_length=token_length, delimiter=delimiter))


if __name__ == "__main__":
    app(prog_name=",name")
