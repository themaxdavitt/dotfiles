#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.14"
# dependencies = ["typer"]
# [tool.uv]
# exclude-newer = "TODO: stamp with date -u +%Y-%m-%dT%H:%M:%SZ"
# ///
"""TODO: one-line description — shown by --help."""

import typer

app = typer.Typer(add_completion=False)


@app.command(help=__doc__)
def main() -> None:
    pass


if __name__ == "__main__":
    app(prog_name=",NAME")
