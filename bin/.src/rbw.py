#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.14"
# dependencies = ["typer"]
# [tool.uv]
# exclude-newer = "2026-07-03T01:13:26Z"
# ///

# Just wasn't too interested in using a third-party client. Seems to work on macOS but _buyer beware!_

from __future__ import annotations

import json
import subprocess
import sys
from typing import Any

import typer

RBW_VERSION = "1.15.0"
TYPE_MAP = {0: "text", 1: "hidden", 2: "boolean", 3: "linked"}
FIELD_MAP = {
    "note": "notes",
    "notes": "notes",
    "user": "username",
    "username": "username",
    "password": "password",
    "url": "uri",
    "uri": "uri",
    "code": "totp",
    "totp": "totp",
}


def as_dict(value: object) -> dict[Any, Any]:
    return value if isinstance(value, dict) else {}


def as_list(value: object) -> list[Any]:
    return value if isinstance(value, list) else []


def run(args: list[str], *, want_json: bool = False):
    proc = subprocess.run(
        ["bwbio", *args],
        capture_output=True,
        text=True,
    )
    if proc.returncode:
        sys.stdout.write(proc.stdout)
        sys.stderr.write(proc.stderr)
        raise SystemExit(proc.returncode)
    if not want_json:
        return proc.stdout
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        sys.stderr.write(f"backend returned invalid JSON for {' '.join(args)}\n")
        raise SystemExit(1)


def get_item(needle: str) -> dict[str, Any]:
    item = run(["get", "item", needle], want_json=True)
    if not isinstance(item, dict):
        sys.stderr.write("backend returned non-object item JSON\n")
        raise SystemExit(1)
    return item


def rbw_raw(item: dict[str, Any]) -> dict[str, Any]:
    login = as_dict(item.get("login"))
    uris = as_list(login.get("uris"))
    fields = as_list(item.get("fields"))
    history = as_list(item.get("passwordHistory"))
    return {
        "id": item.get("id"),
        "folder": None,
        "name": item.get("name"),
        "data": {
            "username": login.get("username"),
            "password": login.get("password"),
            "totp": login.get("totp"),
            "uris": [{"uri": uri.get("uri"), "match_type": uri.get("match")} for uri in uris if isinstance(uri, dict)]
            or None,
        },
        "fields": [
            {
                "name": field.get("name"),
                "value": field.get("value"),
                "type": TYPE_MAP.get(field.get("type"), field.get("type")),
            }
            for field in fields
            if isinstance(field, dict)
        ],
        "notes": item.get("notes"),
        "history": [
            {
                "last_used_date": entry.get("lastUsedDate"),
                "password": entry.get("password"),
            }
            for entry in history
            if isinstance(entry, dict)
        ],
    }


def custom_field(item: dict, name: str) -> str | None:
    exact = []
    contains = []
    for field in item.get("fields") or []:
        if not isinstance(field, dict) or not isinstance(field.get("name"), str):
            continue
        value = field.get("value")
        text = value if isinstance(value, str) else "" if value is None else str(value)
        if field["name"].casefold() == name.casefold():
            exact.append(text)
        elif name.casefold() in field["name"].casefold():
            contains.append(text)
    if exact:
        return exact[0]
    if contains:
        return contains[0]
    return None


def write_text(value: str | None) -> None:
    if value is None:
        return
    sys.stdout.write(value)
    if not value.endswith("\n"):
        sys.stdout.write("\n")


app = typer.Typer(add_completion=False)


def version_callback(value: bool) -> None:
    if value:
        print(f"rbw {RBW_VERSION}")
        raise typer.Exit()


@app.callback()
def main(
    version: bool = typer.Option(False, "--version", callback=version_callback, is_eager=True),
) -> None:
    pass


@app.command()
def get(
    needle: str,
    field: str | None = typer.Option(None, "--field", "-f"),
    raw: bool = typer.Option(False, "--raw"),
) -> None:
    if raw:
        json.dump(rbw_raw(get_item(needle)), sys.stdout, indent=2)
        sys.stdout.write("\n")
        return
    if field is None:
        sys.stdout.write(run(["get", "password", needle]))
        return
    mapped = FIELD_MAP.get(field.lower(), field)
    if mapped in {"username", "password", "notes", "uri", "totp"}:
        sys.stdout.write(run(["get", mapped, needle]))
        return
    write_text(custom_field(get_item(needle), field))


@app.command()
def code(needle: str) -> None:
    sys.stdout.write(run(["get", "totp", needle]))


# `rbw code` alias, matching upstream rbw's `code`/`totp` pair.
@app.command(name="totp", hidden=True)
def totp(needle: str) -> None:
    code(needle)


app()
