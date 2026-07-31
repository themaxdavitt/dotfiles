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
"""Count tokens (or dump token IDs) for files or stdin with a Hugging Face tokenizer.

Fetches the model's own tokenizer from Hugging Face — cached under `~/.cache/huggingface`
after the first call, so only the first run needs the network — then encodes each input
and reports either its token count or its raw token IDs as JSON.

Several FILEs are concatenated into a single total by default, which answers "does this
whole prompt fit". Pass `--per-file` to size each one separately instead: counts print as
`<count><TAB><path>` (so `cut -f1` and `sort -n` work) followed by a `total` row, and IDs
print as a JSON object keyed by path rather than one flat array.
"""

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
    per_file: bool = typer.Option(False, "--per-file", "-p", help="size each file separately instead of one total"),
    files: list[str] | None = typer.Argument(None, metavar="[FILE]...", help="files to read, if empty, stdin is used"),
) -> None:
    if files:
        texts = [(name, open(name).read()) for name in files]
    else:
        texts = [("-", sys.stdin.read())]

    tokenizer = Tokenizer.from_pretrained(model)

    if fmt == Format.CNT:
        counts = [(name, len(tokenizer.encode(text).tokens)) for name, text in texts]
        if not per_file:
            print(sum(count for _, count in counts))
            return
        for name, count in counts:
            print(f"{count}\t{name}")
        if len(counts) > 1:
            print(f"{sum(count for _, count in counts)}\ttotal")
    else:  # fmt == Format.IDS
        if per_file:
            json.dump({name: tokenizer.encode(text).ids for name, text in texts}, sys.stdout)
        else:
            json.dump([i for _, text in texts for i in tokenizer.encode(text).ids], sys.stdout)


if __name__ == "__main__":
    app(prog_name=",tik")
