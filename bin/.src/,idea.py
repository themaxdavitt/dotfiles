#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.14"
# dependencies = [
#   "openai"
# ]
# [tool.uv]
# exclude-newer = "2026-05-17T00:00:00Z"
# ///

import argparse
import os
import re
import sys
import time

from openai import OpenAI

# High temperature + min_p walks a cliff edge on purpose: the gems and the
# noise spirals are the same mechanism. Once a surprising token lands, the
# top-token probability collapses, the min_p floor (relative to it) drops,
# and a flat tail of garbage pours in — positive feedback.
#
# Detection is lexical: any of three window scores over the last
# GIBBERISH_WINDOW words, checked against a held-back output buffer so a
# trip truncates before the salad ever prints. (A logprobs tripwire would
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
CLAUSE_END = re.compile(r"[,;:—–][\"'”’)\]]*(?=\s)")
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


def generate(client, prompt, max_tokens, detect, session_id):
    """Stream one candidate to stdout, holding the tail back so a detected
    spiral is truncated at a clean boundary before it ever prints."""
    buf = ""  # generated text withheld from stdout
    printed_words = 0
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
            provider = getattr(chunk, "provider", None) or provider
            if not chunk.choices:
                continue
            text = chunk.choices[0].delta.content or ""
            if not text:
                continue

            if not detect:
                print(text, flush=True, end="")
                printed_words += len(WORD_RE.findall(text))
                continue

            buf += text
            words = list(WORD_RE.finditer(buf))
            if words and not buf[-1].isspace():
                words = words[:-1]  # last word may still be streaming in

            if len(words) >= GIBBERISH_WINDOW:
                prev = words[-GIBBERISH_WINDOW - 1].group() if len(words) > GIBBERISH_WINDOW else None
                if window_trips([m.group() for m in words[-GIBBERISH_WINDOW:]], prev):
                    spiral = True
                    break

            # Flush everything before the held window, preferring a sentence
            # boundary (then clause, then word) so that a later trip leaves
            # stdout ending cleanly. Unpunctuated run-on rants fall back to
            # word flushing after 3x the window.
            if len(words) > GIBBERISH_WINDOW:
                held_start = words[len(words) - GIBBERISH_WINDOW].start()
                cut = last_match_end(SENTENCE_END, buf, held_start)
                if cut is None and len(words) > GIBBERISH_WINDOW * 3:
                    cut = last_match_end(CLAUSE_END, buf, held_start) or held_start
                if cut:
                    print(buf[:cut], flush=True, end="")
                    printed_words += len(WORD_RE.findall(buf[:cut]))
                    buf = buf[cut:]

    total_words = printed_words + len(WORD_RE.findall(buf))
    if spiral:
        # Truncate back: keep the held text only up to its last full sentence.
        cut = last_match_end(SENTENCE_END, buf)
        buf = buf[:cut] if cut else ""
    print(buf, end="")
    printed_words += len(WORD_RE.findall(buf))
    print(flush=True)
    return {
        "printed": printed_words,
        "total": total_words,
        "spiral": spiral,
        "provider": provider,
    }


def main():
    parser = argparse.ArgumentParser(",idea")
    parser.add_argument("prompt", type=str, help="")
    parser.add_argument(
        "--openrouter-api-key",
        type=str,
        help="OpenRouter API key",
        default=os.getenv("OPENROUTER_API_KEY", ""),
    )
    parser.add_argument(
        "-n",
        "--candidates",
        type=int,
        default=1,
        help="generate N candidates separated by ---; harvest the best",
    )
    parser.add_argument(
        "--max-tokens",
        type=int,
        default=500,
        help="per-candidate token cap; gems need runway before the cliff",
    )
    parser.add_argument(
        "--no-detect",
        action="store_true",
        help="raw stream, no spiral detection or truncation",
    )
    args = parser.parse_args()

    client = OpenAI(
        base_url="https://openrouter.ai/api/v1",
        api_key=args.openrouter_api_key,
    )
    # Per-candidate suffix: sticky routing would pin every candidate to one
    # provider, and the harvest wants provider variance, not consistency.
    # The shared prefix still filters the activity dashboard.
    session_base = f"idea-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}-{os.getpid()}"

    detect = not args.no_detect
    for i in range(args.candidates):
        if i:
            print("---")
        session_id = f"{session_base}-c{i + 1}"
        result = generate(client, args.prompt, args.max_tokens, detect, session_id)
        if (result["spiral"] or args.candidates > 1) and result["total"]:
            note = f"kept {result['printed']}/{result['total']} words"
            if result["spiral"]:
                note += ", spiral truncated"
            if result["provider"]:
                note += f" [{result['provider']}]"
            print(f",idea: [{i + 1}/{args.candidates}] {note}", file=sys.stderr)


if __name__ == "__main__":
    main()
