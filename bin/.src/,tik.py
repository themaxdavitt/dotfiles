#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.14"
# dependencies = [
#   "tokenizers",
#   "typer",
# ]
# [tool.uv]
# exclude-newer = "2026-06-19T20:53:08Z"
# ///
"""Count tokens (or dump token IDs) for files or stdin with a Hugging Face tokenizer."""

import json
import sys
from enum import Enum

import typer
from tokenizers import Tokenizer

app = typer.Typer(add_completion=False)


class Format(str, Enum):
    CNT = "cnt"
    IDS = "ids"


@app.command(help=__doc__)
def main(
    fmt: Format = typer.Option(Format.CNT, "--format", "-f", help="desired output format (count or IDs)"),
    model: str = typer.Option("zai-org/GLM-5.2", "--model", "-m", help="model to tokenize for"),
    files: list[str] | None = typer.Argument(None, metavar="[FILE]...", help="files to read, if empty, stdin is used"),
) -> None:
    handles = [open(f) for f in files] if files else [sys.stdin]

    tokenizer = Tokenizer.from_pretrained(model)

    if fmt == Format.CNT:
        cnt = 0
        for f in handles:
            cnt += len(tokenizer.encode(f.read()).tokens)
            f.close()
        print(cnt, end="")
    else:  # fmt == Format.IDS
        raw = []
        for f in handles:
            raw += tokenizer.encode(f.read()).ids
            f.close()
        json.dump(raw, sys.stdout)


if __name__ == "__main__":
    app(prog_name=",tik")
