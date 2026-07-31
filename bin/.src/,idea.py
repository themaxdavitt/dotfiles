#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.14"
# dependencies = [
#   "openai",
#   "typer",
# ]
# [tool.uv]
# exclude-newer = "2026-05-17T00:00:00Z"
# ///
"""Harvest idea candidates from a deliberately over-hot LLM, keeping detected
spirals as selectable spoiler text rather than letting the salad dominate."""

import os
import re
import sys
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, wait
from dataclasses import dataclass
from queue import Empty, SimpleQueue
from typing import Literal

import typer
from openai import OpenAI
from rich.console import Console
from rich.live import Live
from rich.spinner import Spinner
from rich.style import Style
from rich.table import Table
from rich.text import Text

app = typer.Typer(add_completion=False)
output_console = Console()
activity_console = Console(stderr=True)
DISCARDED_STYLE = Style(color="bright_black", bgcolor="bright_black")

# High temperature + min_p walks a cliff edge on purpose: the gems and the
# noise spirals are the same mechanism. Once a surprising token lands, the
# top-token probability collapses, the min_p floor (relative to it) drops,
# and a flat tail of garbage pours in — positive feedback.
#
# Detection is lexical: any of three window scores over the last
# GIBBERISH_WINDOW words, checked against a held output buffer so a trip
# can conceal the salad as a selectable spoiler. (A logprobs tripwire would
# fire a sentence earlier, but no allowed provider serves min_p + logprobs
# together as of 2026-07.) Calibrated 2026-07 against real spirals
# (deepseek-v4-pro, reasoning off) vs 22 clean candidates:
# - salad words (code shards, mixed scripts, mixed alphanumerics,
#   pseudo-English absent from the system dictionary): clean peaks at
#   5/25, spirals reach 7-15/25;
# - stopword collapse (grammatical salad is real words with no function
#   words between them): clean never dips below 4/25, spirals hit 0/25;
# - mid-sentence capitalization mania: clean peaks at 10/25, the
#   Capitalized-real-word salads reach 11-13/25.
GIBBERISH_WINDOW = 25
GIBBERISH_TRIP = 6
STOPWORD_FLOOR = 2
MIDCAP_TRIP = 12

WORD_RE = re.compile(r"\S+")
SENTENCE_END = re.compile(r"[.!?…][\"'”’)\]]*(?=\s)")
SENTENCE_END_AT_EOS = re.compile(r"[.!?…][\"'”’)\]]*$")

STOPWORDS = set(
    """the a an and or but of to in on at for with from by as is are was were be been being
    it its it's this that these those he she they we you i his her their our your my me him
    them us not no nor so if then than because while when where which who whom what how there
    here just do does did done have has had having will would can could should shall may might
    must about into over under again very only own same too also all any both each few more
    most other some such once during before after above below up down out off""".split()
)

try:
    DICT = {w.strip().lower() for w in open("/usr/share/dict/words")}
except OSError:
    DICT = set()


def in_dict(core: str) -> bool:
    if not DICT:
        return True
    w = core.lower().rstrip("’'").removesuffix("'s").removesuffix("’s")
    if not w:
        return True
    for cand in (
        w,
        w.rstrip("s"),
        w.removesuffix("es"),
        w.removesuffix("ed"),
        w.removesuffix("ing"),
        w.removesuffix("ly"),
        w.removesuffix("d"),
    ):
        if cand in DICT:
            return True
    if "-" in w:
        parts = [p for p in w.split("-") if p]
        if parts and all(in_dict(p) for p in parts):
            return True
    return False


def core_of(word: str) -> str:
    return word.strip("\"'“”‘’()[]{}<>,.;:!?…*~—–_-")


def gibberish(word: str) -> bool:
    core = core_of(word)
    if not core or core.isdigit():
        return False
    if len(core) > 18 or re.search(r"[a-z][A-Z]", core):
        return True
    if any(c in "_{}[]<>\\/=@#$%^&+|." for c in core):
        return True
    if any(ord(c) > 0x24F and c not in "’‘“”—–…" for c in core):
        return True
    if any(c.isdigit() for c in core):
        return True
    return core.islower() and core.isalpha() and len(core) > 3 and not in_dict(core)


def last_match_end(pattern: re.Pattern, text: str, endpos: int | None = None) -> int | None:
    last = None
    for last in pattern.finditer(text, 0, endpos if endpos is not None else len(text)):
        pass
    return last.end() if last else None


def window_trips(window: list[str], prev_word: str | None) -> bool:
    """Score one GIBBERISH_WINDOW-sized run of words; True means spiral."""
    if sum(gibberish(w) for w in window) >= GIBBERISH_TRIP:
        return True
    if sum(core_of(w).lower().rstrip("’'") in STOPWORDS for w in window) <= STOPWORD_FLOOR:
        return True
    midcaps = 0
    prev = prev_word
    for w in window:
        core = w.strip("\"'“”‘’()[]{}<>,*~—–_-")
        if core and core[0].isupper() and prev is not None and not SENTENCE_END_AT_EOS.search(prev):
            midcaps += 1
        prev = w
    return midcaps >= MIDCAP_TRIP


CandidateState = Literal["queued", "generating", "complete", "truncated", "failed"]


@dataclass(frozen=True)
class GenerationResult:
    kept: str
    discarded: str
    printed: int
    total: int
    spiral: bool
    provider: str | None


@dataclass(frozen=True)
class ActivityUpdate:
    candidate: int
    state: CandidateState
    received_words: int = 0
    provider: str | None = None


@dataclass
class CandidateActivity:
    state: CandidateState = "queued"
    received_words: int = 0
    provider: str | None = None


def generate(
    client: OpenAI,
    prompt: str,
    max_tokens: int,
    detect: bool,
    session_id: str,
    on_activity: Callable[[int, str | None], None] | None = None,
) -> GenerationResult:
    """Collect one candidate, concealing a detected spiral after its last sentence."""
    buf = ""
    spiral = False
    provider = None

    with client.chat.completions.create(
        model="deepseek/deepseek-v4-pro",
        stream=True,
        max_tokens=max_tokens,
        extra_body={
            "provider": {
                "require_parameters": True,
            },
            # v4-pro is reasoning-trained: left on, CoT eats the token budget
            # before any content arrives and stabilizes the very excursions
            # this tool exists to harvest.
            "reasoning": {"enabled": False},
            "temperature": 1.6,
            "min_p": 0.05,
            "top_p": 0.97,
            # OpenRouter sticky-routing key; doubles as an activity-dashboard
            # filter for debugging.
            "session_id": session_id,
        },
        messages=[
            {
                "role": "user",
                "content": prompt,
            },
        ],
    ) as stream:
        for chunk in stream:
            chunk_provider = getattr(chunk, "provider", None)
            if chunk_provider:
                provider = str(chunk_provider)
            if not chunk.choices:
                continue
            text = chunk.choices[0].delta.content or ""
            if not text:
                continue

            buf += text
            if on_activity is not None:
                on_activity(len(WORD_RE.findall(buf)), provider)
            if not detect:
                continue

            words = list(WORD_RE.finditer(buf))
            if words and not buf[-1].isspace():
                words = words[:-1]  # last word may still be streaming in
            if len(words) >= GIBBERISH_WINDOW:
                prev = words[-GIBBERISH_WINDOW - 1].group() if len(words) > GIBBERISH_WINDOW else None
                if window_trips([m.group() for m in words[-GIBBERISH_WINDOW:]], prev):
                    spiral = True
                    break

    if spiral:
        # Keep up to the last clean sentence; make the remaining text selectable
        # without letting it dominate the harvest visually.
        cut = last_match_end(SENTENCE_END, buf)
        kept, discarded = (buf[:cut], buf[cut:]) if cut else ("", buf)
    else:
        kept, discarded = buf, ""
    return GenerationResult(
        kept=kept,
        discarded=discarded,
        printed=len(WORD_RE.findall(kept)),
        total=len(WORD_RE.findall(buf)),
        spiral=spiral,
        provider=provider,
    )


def generate_candidate(
    candidate: int,
    prompt: str,
    max_tokens: int,
    detect: bool,
    session_id: str,
    updates: SimpleQueue[ActivityUpdate] | None,
    openrouter_api_key: str,
) -> GenerationResult:
    """Generate one candidate and send UI updates without touching Rich off-thread."""
    if updates is not None:
        updates.put(ActivityUpdate(candidate, "generating"))

    def on_activity(received_words: int, provider: str | None) -> None:
        if updates is not None:
            updates.put(ActivityUpdate(candidate, "generating", received_words, provider))

    client = OpenAI(base_url="https://openrouter.ai/api/v1", api_key=openrouter_api_key)
    try:
        result = generate(client, prompt, max_tokens, detect, session_id, on_activity)
    except Exception:
        if updates is not None:
            updates.put(ActivityUpdate(candidate, "failed"))
        raise
    finally:
        client.close()

    if updates is not None:
        state: CandidateState = "truncated" if result.spiral else "complete"
        updates.put(ActivityUpdate(candidate, state, result.total, result.provider))
    return result


def activity_status(activity: CandidateActivity) -> Text | Spinner:
    match activity.state:
        case "queued":
            return Text("queued", style="dim")
        case "generating":
            return Spinner("dots", Text("generating", style="cyan"))
        case "complete":
            return Text("complete", style="green")
        case "truncated":
            return Text("spiral truncated", style="yellow")
        case "failed":
            return Text("failed", style="red")
        case _:
            return Text("unknown", style="red")


def activity_table(activities: list[CandidateActivity]) -> Table:
    """Build the TTY-only dashboard; Rich animates each braille spinner."""
    table = Table(title="Brewing ideas", show_edge=False)
    table.add_column("Candidate", justify="right")
    table.add_column("Activity")
    table.add_column("Received", justify="right")
    table.add_column("Provider", overflow="ellipsis")
    for candidate, activity in enumerate(activities, start=1):
        words = f"{activity.received_words} words" if activity.received_words else "—"
        table.add_row(str(candidate), activity_status(activity), words, activity.provider or "—")
    return table


def drain_activity_updates(updates: SimpleQueue[ActivityUpdate], activities: list[CandidateActivity]) -> None:
    """Apply worker updates from the main thread, which exclusively owns Rich."""
    while True:
        try:
            update = updates.get_nowait()
        except Empty:
            return
        activity = activities[update.candidate]
        activity.state = update.state
        activity.received_words = max(activity.received_words, update.received_words)
        activity.provider = update.provider or activity.provider


def generate_parallel(
    candidates: int,
    prompt: str,
    max_tokens: int,
    detect: bool,
    session_base: str,
    openrouter_api_key: str,
) -> list[GenerationResult]:
    """Run candidate requests together, preserving index order for final output."""
    show_activity = activity_console.is_terminal and candidates > 1
    updates = SimpleQueue[ActivityUpdate]() if show_activity else None
    activities = [CandidateActivity() for _ in range(candidates)]
    with ThreadPoolExecutor(max_workers=candidates, thread_name_prefix="idea") as executor:
        futures = [
            executor.submit(
                generate_candidate,
                candidate,
                prompt,
                max_tokens,
                detect,
                f"{session_base}-c{candidate + 1}",
                updates,
                openrouter_api_key,
            )
            for candidate in range(candidates)
        ]
        if show_activity:
            assert updates is not None
            with Live(
                activity_table(activities),
                console=activity_console,
                refresh_per_second=12,
                transient=True,
            ) as live:
                pending = set(futures)
                while pending:
                    drain_activity_updates(updates, activities)
                    live.update(activity_table(activities))
                    _, pending = wait(pending, timeout=0.05)
                drain_activity_updates(updates, activities)
                live.update(activity_table(activities))

    return [future.result() for future in futures]


def print_candidate(result: GenerationResult) -> None:
    """Print one candidate, making a detector-discarded tail a spoiler span."""
    text = Text(result.kept)
    text.append(result.discarded, style=DISCARDED_STYLE)
    output_console.print(text, soft_wrap=True)


@app.command(help=__doc__)
def main(
    prompt: str = typer.Argument(...),
    openrouter_api_key: str = typer.Option("", envvar="OPENROUTER_API_KEY", help="OpenRouter API key"),
    candidates: int = typer.Option(
        1, "--candidates", "-n", min=1, help="generate N candidates separated by ---; harvest the best"
    ),
    max_tokens: int = typer.Option(500, help="per-candidate token cap; gems need runway before the cliff"),
    no_detect: bool = typer.Option(False, "--no-detect", help="raw output, no spiral detection or truncation"),
) -> None:
    # Per-candidate suffix: sticky routing would pin every candidate to one
    # provider, and the harvest wants provider variance, not consistency.
    # The shared prefix still filters the activity dashboard.
    session_base = f"idea-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}-{os.getpid()}"

    results = generate_parallel(
        candidates,
        prompt,
        max_tokens,
        not no_detect,
        session_base,
        openrouter_api_key,
    )
    for i, result in enumerate(results):
        if i:
            output_console.print("---")
        print_candidate(result)
        if (result.spiral or candidates > 1) and result.total:
            note = f"kept {result.printed}/{result.total} words"
            if result.spiral:
                note += ", spiral truncated"
            if result.provider:
                note += f" [{result.provider}]"
            print(f",idea: [{i + 1}/{candidates}] {note}", file=sys.stderr)


if __name__ == "__main__":
    app(prog_name=",idea")
