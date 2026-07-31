#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.14"
# dependencies = [
#   "anyio",
#   "gepa",
#   "pydantic",
#   "pydantic-ai-slim[openai,openrouter,retries,spec]",
#   "pyrate-limiter",
#   "python-frontmatter",
#   "typer",
# ]
# [tool.uv]
# exclude-newer = "2026-06-28T00:00:00Z"
# ///
"""LLM-backed agent-guidance linting with multi-model voting."""

# TODO: eventually use `httpx2` when `pydantic_ai` supports it because `httpx` is dead
# TODO: route model calls through `pi` (via "$(mise which pi)" — the wrapper's
#       interaction with pre-existing sandboxes is unsettled, so don't use the
#       wrapper) instead of raw OpenRouter: it can also draw on the Codex
#       subscription alongside the OpenRouter key.

import hashlib
import inspect
import json
import math
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import textwrap
import threading
from collections.abc import AsyncIterator, Callable, Iterable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from enum import Enum
from functools import lru_cache, partial
from pathlib import Path
from statistics import mode as stat_mode
from typing import Annotated, Literal, Optional, TypeVar, cast

import anyio
import anyio.from_thread
import anyio.to_thread
import frontmatter
import httpx
import typer
import yaml
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    create_model,
)
from pydantic_ai import Agent, Embedder
from pydantic_ai.embeddings.openai import OpenAIEmbeddingModel
from pydantic_ai.embeddings.settings import EmbeddingSettings
from pydantic_ai.models.openrouter import OpenRouterModel, OpenRouterModelSettings
from pydantic_ai.output import NativeOutput, OutputSpec
from pydantic_ai.profiles import InlineDefsJsonSchemaTransformer, ModelProfile, merge_profile
from pydantic_ai.providers.openrouter import OpenRouterProvider
from pydantic_ai.retries import AsyncTenacityTransport, RetryConfig, wait_retry_after
from pyrate_limiter import Duration, Limiter, Rate
from tenacity import retry_if_exception, stop_after_attempt, wait_random_exponential


DEFAULT_MODEL = "z-ai/glm-5.2"
DEFAULT_RUNS = 3
# Drops are irreversible, so the ablation that justifies them runs hotter than the
# judge lane's default; noise that merely re-asks a judge would here delete a rule.
DEFAULT_IMPROVE_RUNS = 5
# Pair nomination hands its shortlist to a judge, so weak geometry there costs only a
# few wasted votes. Clustering has no such backstop: its groupings ARE the output, read
# straight by a human deciding how to organise skills, so the embedding carries the
# whole signal and is worth paying for.
DEFAULT_EMBEDDING_MODEL = "qwen/qwen3-embedding-8b"
OutputT = TypeVar("OutputT")


def program_name() -> str:
    name = Path(sys.argv[0] or __file__).name
    if name.startswith("executable_"):
        return name.removeprefix("executable_")
    return name


def envvar_prefix() -> str:
    prefix = program_name().lstrip(",")
    return prefix or program_name()


def config_name() -> str:
    # Strip any source-file extension so `uv run bin/.src/,llint.py` resolves
    # the same config dirs as the deployed `,llint`.
    name = Path(program_name()).stem.lstrip(",")
    return name or program_name()


def help_notes() -> str:
    name = config_name()
    return textwrap.dedent(
        f"""
        ### What Each Command Spends

        - Free, no network: `atoms`, `plan`, `rules`.

        - Judge calls (cheap, cached by content hash): `check`.

        - Consumer ablation runs (expensive — every atom re-measured against every
          case on every consumer): `improve`.

        - `improve` is the only command that writes. `--dry-run` measures and reports
          everything without touching the file.

        ### Configuration

        - Rules: `.{name}/rules`, `~/.config/dotfiles/{name}/rules`

        - Agent specs: `.{name}/agents`, `~/.config/dotfiles/{name}/agents`

        - Passing `--rules-dir` or `--agent-spec-dir` replaces that default search path.

        ### Rule Files

        - Rules are Markdown `.md` files with YAML frontmatter.

        - Required frontmatter: `id`, `title`, `severity`, `scope`, `why`, `tests`.

        - The Markdown body is the check description.

        - Optional frontmatter: `input` (`file`, `eval-prompt`, `coverage`,
          `directive-pair`; defaults to `file`). Rules sharing an input shape and a
          document are judged together in one call.

        ### Agent Spec Files

        - YAML files with `models` (list) or `model` (string), optional
          `instructions` and `retries`.

        - The `lint` agent is used for text-judgment linting (multi-model voting).

        - The `consumer` agent is used for behavioral eval ablation runs.

        ### Suppressions

        - Whole file: `<!-- {name}-disable-file all -->`

        - Rule id anywhere in file: `<!-- {name}-disable-file rule/id another/rule -->`

        ### Skill Evals (Behavioral Ablation)

        - Measure without changing anything: `{name} improve --dry-run <skill-dir>`,
          where `<skill-dir>` holds `SKILL.md` and `evals/`; a guidance file instead
          takes its cases from `.evals/<name lowercased>/` beside it
          (`AGENTS.md` -> `.evals/agents/`).

        - Each eval case: `evals/<case>/prompt.md` + `evals/<case>/grade.sh`.

        - `grade.sh` reads the consumer's plan on stdin; exit 0 = insight present.

        - Verdicts: `redundant` (model already has insight), `effective` (skill adds it),
          `ineffective` (guidance not landing in either condition — usually a grader
          demanding one exact phrasing, not a skill that fails to teach).
        """
    ).strip()


# --- Prompts -------------------------------------------------------------------

SYSTEM_PROMPT = (
    "You are a precise agent-guidance lint rule evaluator. Return findings that match "
    "the structured output schema. Only report violations you are confident about; "
    "prefer false negatives over speculative or noisy findings."
)
TASK_PROMPT = """
Evaluate one Markdown file against every lint rule given below.

Answer for each rule separately. The output has one field per rule id and every
one of them must be present: give a rule an empty array when it does not clearly
fire, which is the expected answer for most rules on most files. Judge each rule
only against its own criteria — a violation of one rule is not evidence for any
other. Report at most 10 findings per rule. Prefer false negatives over noisy or
speculative findings.
""".strip()


# --- Rule schema ---------------------------------------------------------------

NonEmptyStr = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
Severity = Literal["suggestion", "warning", "error"]
# Only `scopes_for` produces these, so a scope it never returns is a rule that can
# never run. "all" is the consumer-side wildcard and stays; producer-side values do
# not get added until something classifies a file as one.
Scope = Literal["agent-guidance", "skill-definition", "all"]
MAX_JUDGE_OUTPUT_TOKENS = 16_000

# One effort for every judge call, not a per-rule knob. Rules are batched now, so a
# call applies several rules at once and there is no coherent per-rule answer to give;
# the old per-rule values were guesses anyway, and the choice between them was never
# measured. Medium is the middle of the range and the default worth beating.
JUDGE_REASONING_EFFORT = "medium"
# What a rule reads. `scope` says which KIND of document a rule judges; `input` says
# what gets assembled and handed to it, which is a different axis: a directive pair
# drawn from two files is not itself an agent-guidance file. Keeping them separate is
# what lets every rule live in one directory and still reach the right material.
InputShape = Literal["file", "directive-pair", "coverage", "eval-prompt"]


class RuleTest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    bad: str
    good: str


class Rule(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: NonEmptyStr
    title: NonEmptyStr
    severity: Severity
    scope: list[Scope]
    input: InputShape = "file"
    why: NonEmptyStr
    check: NonEmptyStr
    tests: Annotated[list[RuleTest], Field(min_length=1)]
    source: str

    def coerce_scope(cls, value: object) -> object:  # noqa: N805
        return [value] if isinstance(value, str) else value

    def __init__(self, **data):  # type: ignore[no-untyped-def]
        if isinstance(data.get("scope"), str):
            data["scope"] = [data["scope"]]
        super().__init__(**data)


# --- Model output schemas ------------------------------------------------------
# No `quote` field — findings are per (rule, file), dedup and voting happen
# at that granularity. No `confidence` field — confidence comes from voting.


class LintFinding(BaseModel):
    model_config = ConfigDict(extra="forbid")

    message: str
    suggestion: str


class LintResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    findings: list[LintFinding]


@lru_cache(maxsize=None)
def batch_result_model(rule_ids: tuple[str, ...]) -> type[BaseModel]:
    """An output type with one required field per rule in the batch.

    A batch asks about several rules at once, so the answer has to say which rule each
    finding belongs to. Two shapes can express that; only this one makes a wrong answer
    impossible to represent:

      - findings tagged with a free `rule_id` — the model can invent an id, or answer
        for four of five rules and look like it found nothing in the fifth;
      - one field per rule, which is what this builds — every id is a fixed property
        name, so an invented rule and a skipped rule are both ValidationErrors.

    The second matters more than it looks. Silence is this judge's most common output
    (rules are told to prefer false negatives, and ~2% of rule-file pairs fire), so
    "no findings" and "never considered it" are indistinguishable by inspection. A
    required field per rule forces the model to answer for each one.

    A dict[str, list[...]] would say the same thing far more briefly, but it compiles
    to `additionalProperties`, which strict json_schema forbids — the arbitrary keys
    are exactly what strict mode rules out, and fixed property names are the way back
    in. Rule ids are hyphenated and cannot be Python identifiers, hence the aliases.

    Cached per rule-set: a batch's model is rebuilt on every file otherwise, and the
    set is stable across a whole run.
    """
    fields = {
        f"rule_{index}": (
            list[LintFinding],
            Field(alias=rule_id, description=f"Findings for rule {rule_id!r}. Empty list if it does not fire."),
        )
        for index, rule_id in enumerate(rule_ids)
    }
    return create_model(  # ty: ignore[no-matching-overload]
        "BatchLintResult",
        __config__=ConfigDict(extra="forbid", populate_by_name=True),
        **fields,
    )


def findings_by_rule(result: BaseModel, rule_ids: tuple[str, ...]) -> dict[str, list[LintFinding]]:
    """Undo batch_result_model's aliasing, back to {rule_id: findings}."""
    return {rule_id: getattr(result, f"rule_{index}") for index, rule_id in enumerate(rule_ids)}


# --- Agent config loading ------------------------------------------------------
# Extends the bare YAML agent spec with multi-model support.
# Supports both new format (models: [...]) and old format (model: ...).


@dataclass
class LlintAgentConfig:
    models: list[str]
    instructions: Optional[str] = None
    retries: int = 2
    # Raw `context:` block, resolved per target by `deployed_context`. Kept unresolved
    # here because which layers apply depends on the file under test, which the spec
    # cannot know. Absent means the old behaviour: the skill measured on its own.
    context: dict = field(default_factory=dict)


AGENT_SPEC_DIRS: tuple[Path, ...] = ()


def default_agent_spec_dirs() -> list[Path]:
    dirs: list[Path] = []
    dirs.append(Path.cwd() / f".{config_name()}" / "agents")
    dirs.append(Path.home() / ".config" / "dotfiles" / config_name() / "agents")
    return dirs


def configure_agent_spec_dirs(agent_spec_dir: Optional[list[Path]]) -> None:
    global AGENT_SPEC_DIRS
    dirs = [path.expanduser() for path in agent_spec_dir] if agent_spec_dir else default_agent_spec_dirs()
    AGENT_SPEC_DIRS = tuple(dirs)


def load_agent_raw(name: str) -> Optional[dict]:
    """Merge agent specs across the search path, nearest directory winning.

    First-wins would force a repo that wants to redirect one context path to restate the
    whole model list, and the two copies would then drift apart silently. Scalars take the
    nearest definition; `context` merges key by key, so a repo can override `user` without
    discarding the shared `preamble`."""
    found: list[dict] = []
    for directory in AGENT_SPEC_DIRS:
        for suffix in (".yaml", ".yml", ".json"):
            path = directory / f"{name}{suffix}"
            if path.is_file():
                found.append(yaml.safe_load(path.read_text(encoding="utf-8")) or {})
                break
    if not found:
        return None
    merged: dict = {}
    for raw in reversed(found):  # farthest first, so the nearest spec overwrites it
        for key, value in raw.items():
            if key == "context" and isinstance(value, dict):
                merged.setdefault("context", {}).update(value)
            else:
                merged[key] = value
    return merged


def load_agent_config(name: str, default_model: str) -> LlintAgentConfig:
    raw = load_agent_raw(name)
    if raw is None:
        return LlintAgentConfig(models=[default_model])

    # Resolve model list
    if "models" in raw and isinstance(raw["models"], list):
        models = [str(m) for m in raw["models"]]
    elif "model" in raw:
        model_id = str(raw["model"]).removeprefix("openrouter:")
        models = [model_id]
    else:
        models = [default_model]

    return LlintAgentConfig(
        models=models,
        instructions=raw.get("instructions"),
        retries=int(raw.get("retries", 2)),
        context=raw.get("context") or {},
    )


# A deployed consumer never meets a skill cold. It is already holding the harness's own
# system prompt, then user-level guidance, then repo guidance, and reads the skill last.
# Measuring the skill alone asks a question nobody is ever asked, and it biases toward
# keeping directives that merely restate an outer layer: those change behaviour when the
# outer layer is absent, so they score `effective` and survive, while in deployment they
# are pure token rent. Ordering is load-bearing twice over — it mirrors real precedence
# (specific guidance last), and everything above the skill text is byte-identical across
# every candidate in a run, which is the only reason prompt caching can engage at all.
#
# Which files those layers are lives in the `consumer` agent spec, never here: this tool
# should not know that some repo keeps user guidance at `dot_claude/CLAUDE.md`.
def discovered_repo_guidance() -> list[Path]:
    """Root-level agent guidance, found by the same names `check` already recognises, so
    a repo writing CLAUDE.md instead of AGENTS.md needs no configuration. SKILL.md is
    excluded: skills load on demand, they are not context a consumer permanently holds."""
    return [path for name in sorted(GUIDANCE_NAMES - {"SKILL.md"}) if (path := Path(name)).is_file()]


def deployed_context(spec: dict, target: Path) -> str:
    """Assemble the guidance a real consumer already holds before it reads `target`.

    `preamble` is literal text standing in for the harness's own persona. `user` paths
    always apply. Repo guidance is discovered from the working tree unless `repo:` names
    it explicitly, and is skipped entirely for a user-level target — detected as one
    resolving inside a `user` path's own directory, which is how a user-scoped skill kept
    beside user-scoped guidance is recognised without hardcoding any layout. Measuring a
    global skill against one repo's conventions would score its directives redundant on
    evidence that does not generalise, which is the opposite of what a global skill wants.
    A layer that IS the target is always dropped, since grading a file against itself
    scores every directive redundant.

    Guidance rides inside `<project_context>` because that is how the real harness
    delimits it (pi's system-prompt.ts), and delimiters change how a model weighs text.
    """
    if not spec:
        return ""
    resolved_target = target.resolve()
    user_paths = [Path(p).expanduser() for p in spec.get("user") or []]
    user_roots = [p.resolve().parent for p in user_paths if p.exists()]
    target_is_user_level = any(root in resolved_target.parents for root in user_roots)

    if target_is_user_level:
        repo_paths: list[Path] = []
    elif "repo" in spec:
        repo_paths = [Path(p).expanduser() for p in spec["repo"] or []]
    else:
        repo_paths = discovered_repo_guidance()

    documents: list[str] = []
    for path in user_paths + repo_paths:
        if not path.exists():
            # Silence here would quietly restore the biased measurement this exists to fix.
            print(f"{program_name()}: warning: context layer {path} not found; skipping", file=sys.stderr)
            continue
        if path.resolve() == resolved_target:
            continue
        if body := read_text(path).strip():
            documents.append(body)

    layers: list[str] = []
    if preamble := str(spec.get("preamble") or "").strip():
        layers.append(preamble)
    if documents:
        layers.append("<project_context>\n" + "\n\n".join(documents) + "\n</project_context>")
    return "\n\n".join(layers)


# --- Rule loading --------------------------------------------------------------


def default_rule_dirs() -> list[Path]:
    dirs: list[Path] = []
    dirs.append(Path.cwd() / f".{config_name()}" / "rules")
    dirs.append(Path.home() / ".config" / "dotfiles" / config_name() / "rules")
    return dirs


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return path.read_text(encoding="utf-8", errors="replace")


def load_rule(path: Path) -> Rule:
    if path.suffix != ".md":
        raise ValueError(f"{path}: rule files must be Markdown")
    post = frontmatter.loads(read_text(path))
    if not post.metadata:
        raise ValueError(f"{path}: Markdown rules require YAML frontmatter")
    return Rule.model_validate({**post.metadata, "check": post.content, "source": path.as_posix()})


def load_rules(rule_dirs: list[Path], ids: Optional[set[str]]) -> list[Rule]:
    rules: list[Rule] = []
    for directory in rule_dirs:
        if not directory.exists():
            continue
        if not directory.is_dir():
            raise ValueError(f"{directory}: not a directory")
        for path in sorted(directory.rglob("*.md")):
            rule = load_rule(path)
            if ids is None or rule.id in ids:
                rules.append(rule)

    if ids is not None:
        missing = sorted(ids - {rule.id for rule in rules})
        if missing:
            raise ValueError(f"rule(s) not found: {', '.join(missing)}")
    return rules


# --- Inputs -------------------------------------------------------------------

VCS_DIRS = {".git", ".hg", ".svn"}


def markdownish(path: str) -> bool:
    return path.endswith(".md")


def discover(root: Path) -> list[Path]:
    found: list[Path] = []
    for current, dirnames, filenames in os.walk(root):
        dirnames[:] = [name for name in dirnames if name not in VCS_DIRS]
        for name in filenames:
            if markdownish(name.lower()):
                found.append(Path(current) / name)
    return sorted(found)


def input_for_path(path: Path, scopes: list[str]) -> dict:
    text = read_text(path)
    return {"display": path.as_posix(), "scopes": scopes, "text": text}


def collect_inputs(paths: list[Path], stdin_filename: str, scopes: list[str]) -> list[dict]:
    inputs = []
    for raw in paths or [Path(".")]:
        if str(raw) == "-":
            text = sys.stdin.read()
            inputs.append({"display": stdin_filename, "scopes": scopes, "text": text})
            continue

        path = raw.expanduser()
        if path.is_dir():
            inputs.extend(input_for_path(child, scopes) for child in discover(path))
        elif path.is_file():
            inputs.append(input_for_path(path, scopes))
        else:
            raise FileNotFoundError(f"no such file or directory: {raw}")

    return list({item["display"]: item for item in inputs}.values())


def rule_applies(rule: Rule, scopes: list[str]) -> bool:
    if not scopes:
        return True
    return "all" in rule.scope or bool(set(rule.scope) & set(scopes))


# --- Prompting -----------------------------------------------------------------


class SourceTooLong(Exception):
    """A document did not fit the judge's budget, so it cannot be judged honestly."""


def checked_source(text: str, max_chars: int, display: str = "input") -> str:
    """The document, or an error — never a silent prefix of it.

    This used to truncate and warn, and only for one hardcoded rule id that no longer
    existed, so in practice it truncated in total silence. Every verdict downstream is
    then a verdict about a prefix while reporting itself as a verdict about the file:
    a rule that would fire on the missing tail reads as a clean pass, which is the
    single worst failure a linter can have. Refusing is the honest answer, and the
    limit is a flag away.
    """
    if len(text) <= max_chars:
        return text
    raise SourceTooLong(
        f"{display} is {len(text):,} characters, over the {max_chars:,} limit. "
        f"Judging a truncated file would report a clean pass for anything in the part "
        f"that was cut. Raise --max-chars, or split the file."
    )


def test_block_excluding(rule: Rule, exclude_index: Optional[int] = None) -> str:
    """Build the test block, optionally holding out the case at exclude_index (1-based)."""
    blocks = []
    for i, test in enumerate(rule.tests, 1):
        if i == exclude_index:
            continue
        blocks.append(f"Bad example:\n{test.bad}\n\nGood example:\n{test.good}")
    return "\n\n---\n\n".join(blocks)


def rule_prompt(rule: Rule, exclude_test_index: Optional[int] = None) -> str:
    return textwrap.dedent(
        f"""
        Rule id: {rule.id}
        Rule title: {rule.title}

        Check:
        {rule.check}

        Why:
        {rule.why}

        Examples:
        {test_block_excluding(rule, exclude_test_index)}
        """
    ).strip()


def source_prompt(input_file: dict, max_chars: int, rules: Iterable[Rule] = ()) -> str:
    text = checked_source(input_file["text"], max_chars, input_file["display"])
    return textwrap.dedent(
        f"""
        File: {input_file["display"]}
        Scopes: {", ".join(input_file["scopes"]) or "(none)"}

        Source to inspect:
        <SOURCE>
        {text}
        </SOURCE>
        """
    ).strip()


def judge_instructions(config: "LlintAgentConfig", rules: list[Rule], exclude_test_index: Optional[int] = None) -> str:
    """The judge's system prompt: persona, task, and every rule in the batch.

    All of it is constant for as long as this rule set is being applied; only the
    document varies. Keeping it here rather than in the user turn is what it means
    anyway — a lint rule is standing instruction, not something the model is being
    asked about — and it is also the only arrangement a prompt cache can use, since
    the breakpoint sits at the end of the instructions.

    Batching is what makes that cache worth having. Measured on the real corpus
    2026-07-27, a single rule's prefix is 309..515 tokens and clears no provider's
    minimum, so per-rule calls cached nothing at all; the 5- and 7-rule batches this
    builds are 1,593 and 2,172 tokens and cache cleanly. The document also stops
    being re-sent once per rule, which is where most of the saving actually comes
    from: 81 calls and ~88k effective tokens per pass become 13 and ~19k.
    """
    return "\n\n".join(
        [config.instructions or SYSTEM_PROMPT, TASK_PROMPT, *(rule_prompt(r, exclude_test_index) for r in rules)]
    )


def lint_prompt(input_file: dict, max_chars: int, rules: Iterable[Rule] = ()) -> str:
    """The user turn: the document under review, and nothing else."""
    return source_prompt(input_file, max_chars, rules)


# --- HTTP and model building ---------------------------------------------------

OPENROUTER_RETRY_STATUS_CODES = {408, 429, 502, 503, 504}
# The mirror image: statuses no retry can fix within the run, because the key is
# rejected, out of credit, or past its spend cap. The cap is usually raisable, but
# not by anything happening in this process, which is exactly why retrying is not
# merely useless but destructive — hitting one on 2026-07-27 became 12,676 doomed
# requests and ~10 hours of cumulative backoff sleep, buried the single fact that
# mattered under 3,169 identical warnings, and left the run grinding on toward a
# verdict it could no longer measure. Unattended, it would never have finished.
OPENROUTER_TERMINAL_STATUS_CODES = {401, 402, 403}

# A dead key is a property of the RUN, not of the call that happens to discover it,
# so the first thread to see one records it and every other lane stops spending.
_budget_lost: list[str] = []
_budget_lock = threading.Lock()


def note_if_terminal(error: BaseException) -> bool:
    """True when `error` means no further request can succeed, recording it once."""
    if getattr(error, "status_code", None) not in OPENROUTER_TERMINAL_STATUS_CODES:
        return False
    with _budget_lock:
        if not _budget_lost:
            _budget_lost.append(str(error))
    return True


def budget_lost() -> Optional[str]:
    with _budget_lock:
        return _budget_lost[0] if _budget_lost else None


# Prompt-cache accounting, measured rather than assumed. A prefix under the
# provider's minimum length is skipped SILENTLY — no error, no warning — and a
# breakpoint on a block that varies per request writes every time and reads never.
# Both failures look exactly like success from the outside, which is how the
# top-level `cache_control` sent before 2026-07-27 went unnoticed. Real minimums
# differ per model and move every release, so this deliberately tracks no table:
# it reports what the responses actually said and lets the numbers speak.
_cache_tokens: dict[str, int] = {"read": 0, "write": 0, "input": 0}
_cache_tokens_lock = threading.Lock()


def note_usage(usage: object) -> None:
    """Fold one response's token accounting into the run totals."""
    with _cache_tokens_lock:
        for field, key in (("cache_read_tokens", "read"), ("cache_write_tokens", "write"), ("input_tokens", "input")):
            _cache_tokens[key] += getattr(usage, field, 0) or 0


def cache_report() -> Optional[str]:
    """One line on how the prompt cache actually performed, or None if nothing ran.

    `input` is the provider's total prompt count, which already includes the cached
    reads (OpenAI's convention, and what OpenRouter normalizes every provider into),
    so the ratio below is share-of-prompt-served-from-cache. A run that reads ~0%
    while writing steadily is the silent-failure signature worth chasing.
    """
    with _cache_tokens_lock:
        read, write, total = _cache_tokens["read"], _cache_tokens["write"], _cache_tokens["input"]
    if not total:
        return None
    return f"prompt cache: {read / total:.0%} of {total:,} input tokens read from cache ({write:,} written)"


# Two layers, deliberately different sizes. The transport retries a FAILED HTTP
# call, which costs one round trip, so it can afford to be patient with a 429.
# The caller loop below re-runs a whole completion to replace an unusable body,
# which costs a full generation — and the two multiply, so keeping the expensive
# one small matters more than keeping the cheap one small.
OPENROUTER_HTTP_RETRY_ATTEMPTS = 6
OPENROUTER_SIMPLE_RETRY_ATTEMPTS = 4


def should_retry_openrouter_error(error: BaseException) -> bool:
    # OpenRouter documents 429/502/503/504 as retryable and only *may* send a
    # Retry-After header — a header-less 429 still deserves a retry (the wait
    # strategy falls back to exponential backoff), otherwise eval runs shrink
    # `n` silently and verdicts get harder to read.
    if isinstance(error, httpx.TransportError):
        return True
    if not isinstance(error, httpx.HTTPStatusError):
        return False
    return error.response.status_code in OPENROUTER_RETRY_STATUS_CODES


def retrying_http_client() -> httpx.AsyncClient:
    def raise_retryable_status(response: httpx.Response) -> None:
        if response.status_code in OPENROUTER_RETRY_STATUS_CODES:
            response.raise_for_status()

    transport = AsyncTenacityTransport(
        config=RetryConfig(
            retry=retry_if_exception(should_retry_openrouter_error),
            # Jittered, not plain exponential: openrouter_slot lets many requests run
            # concurrently, and a header-less 429 would otherwise back every one of
            # them off by the identical interval and re-fire them as one burst.
            wait=wait_retry_after(
                fallback_strategy=wait_random_exponential(multiplier=2, max=30),
                max_wait=float("inf"),
            ),
            stop=stop_after_attempt(OPENROUTER_HTTP_RETRY_ATTEMPTS),
            reraise=True,
        ),
        validate_response=raise_retryable_status,
    )
    return httpx.AsyncClient(transport=transport)


_models: dict[str, OpenRouterModel] = {}


def build_model(model_id: str, api_key: str) -> OpenRouterModel:
    """One model — and so one HTTP client — per model id, for the whole run.

    This used to build a fresh model per attempt, because run_sync spins its own event
    loop per call and an httpx.AsyncClient must not cross loops. One loop for the whole
    process removes that constraint, and with it a client, a connection pool and a TLS
    handshake per request. At the in-flight ceiling that is the difference between a
    hundred-odd clients and one.
    """
    if (existing := _models.get(model_id)) is not None:
        return existing
    provider = OpenRouterProvider(api_key=api_key, http_client=retrying_http_client())
    # Inline nested $ref/$defs so every OpenRouter provider gets a self-contained schema.
    # Force native structured output: pydantic-ai's OpenRouter profiles
    # conservatively claim glm/claude can't do response_format json_schema, but
    # their current providers can, and require_parameters filters routing to
    # ones that do. Without this the judge panel silently shrinks to gpt-only.
    profile_override: ModelProfile = {
        "json_schema_transformer": InlineDefsJsonSchemaTransformer,
        "supports_json_schema_output": True,
    }
    profile = merge_profile(provider.model_profile(model_id), profile_override)
    _models[model_id] = OpenRouterModel(model_id, provider=provider, profile=profile)
    return _models[model_id]


# One id per invocation: OpenRouter uses it as the sticky-routing key (same provider
# within a session helps cache hits) and it filters the activity dashboard when
# debugging. Load-bearing for caching, not just diagnostics — Z.AI in particular is
# sent a session affinity key derived from it, so dropping this would scatter requests
# across caches that each then have to be written again.
SESSION_ID = f"llint-{datetime.now(UTC):%Y%m%dT%H%M%SZ}-{os.getpid()}"


def model_settings() -> OpenRouterModelSettings:
    # No sampling params: closed-weight frontier models increasingly reject
    # them outright, real harnesses mostly run defaults, and run-to-run
    # diversity for voting/ablation comes from provider defaults just fine.
    settings: OpenRouterModelSettings = {
        "openrouter_provider": {"require_parameters": True},
        # An EXPLICIT breakpoint at the end of the instructions, not the top-level
        # `cache_control` this sent until 2026-07-27. Top-level is Anthropic's
        # *automatic* mode, which places the breakpoint on the last cacheable block —
        # here the document being judged, which differs on every single call. Writes
        # happen only at the breakpoint, and the backward lookback finds only entries
        # that earlier requests actually wrote, so a prefix hash that never repeats
        # never hits: "you pay for a fresh cache write on every request and never get
        # a read", which is Anthropic's own worked example of this exact trap. It was
        # billing every judge input token at the 2x 1h-write rate for zero reads.
        # Marking the instructions instead puts the breakpoint on the real static
        # prefix. Cleanly ignored by non-Anthropic judges (verified in the request
        # body: their system message stays a plain string).
        #
        # Two breakpoints, both 5m, covering the two axes a judge call repeats on:
        #
        #   instructions — persona, task, and every rule in the batch. Shared across the
        #     FILES this rule set judges. Batching is what makes it worth caching at
        #     all: measured 2026-07-27, a single rule's prefix is 309..515 tokens and
        #     clears no provider's floor, while the 5- and 7-rule batches are 1,593 and
        #     2,172 and cache cleanly.
        #   messages — the document. Shared across the `runs` repeats of one file, which
        #     are byte-identical requests differing only in sampling. Without it every
        #     repeat re-paid the whole document to re-ask what it had just asked; with
        #     it, 1.50x cheaper at the default 3 runs and 1.87x at 5.
        #
        # The second one pays off because vote_rules repeats SEQUENTIALLY, so the first
        # write has landed before the second call asks. The consumer lane deliberately
        # has no equivalent — see consumer_model_settings().
        #
        # 5m rather than the 1h the instructions carried until this pair existed. TTL
        # should track the reuse INTERVAL, not the run's length, and a cache read
        # refreshes the entry for free — so a prefix re-hit every batch or two never
        # lapses, however long the pass runs. 1h only ever paid for gaps that batching
        # removed, and it bills writes at 2x base input instead of 1.25x. Equal TTLs
        # also sidestep Anthropic's ordering rule, which rejects a 1h breakpoint
        # appearing after a 5m one in the tools -> system -> messages sequence.
        #
        # These settings only emit breakpoints for Anthropic, which is the ONLY provider
        # here that needs them — not the only one that caches. Z.AI, Moonshot and OpenAI
        # all cache automatically off the literal prefix, so they were already hitting on
        # repeat runs, document included; these two breakpoints bring Anthropic to parity
        # rather than turning caching on. What actually serves the automatic providers is
        # the ORDERING — stable content first, the varying document last — which is why
        # that layout matters even though nothing in the request names it.
        #
        # Undersized prefixes are skipped silently, with no error, and real floors vary
        # per model and go stale every release — so none are tabulated here. The run
        # summary reports what actually happened, which is the only claim that stays
        # true.
        "openrouter_cache_instructions": "5m",
        "openrouter_cache_messages": "5m",
        "extra_body": {
            "session_id": SESSION_ID,
            # Repair malformed JSON server-side (trailing commas, markdown
            # fences, …) before it reaches pydantic validation — glm-5.2 burns
            # its output retries on this otherwise. Non-streaming json_schema
            # requests only (our case); can't fix max_tokens truncation.
            "plugins": [{"id": "response-healing"}],
        },
        "openrouter_reasoning": {"effort": JUDGE_REASONING_EFFORT},
        # Bounded because a batch answers for every rule in one response, so the
        # ceiling scales with batch size rather than staying one rule's worth. Sized
        # well clear of reality: findings measured ~145 tokens and ~2% of rule-file
        # pairs fire, so even every rule firing several times lands far under this.
        # Truncation here fails closed — the body stops parsing as json_schema, and
        # the response-healing plugin explicitly cannot repair a max_tokens cut — so
        # a run that hits it is dropped from the vote rather than counted as clear.
        "max_tokens": MAX_JUDGE_OUTPUT_TOKENS,
    }
    return settings


def make_lint_agent(
    llm: OpenRouterModel, config: LlintAgentConfig, output_type: OutputSpec[OutputT], instructions: str
) -> Agent[object, OutputT]:
    # NativeOutput sends response_format json_schema instead of pydantic-ai's
    # default tool-call output mode — required for OpenRouter's response-healing
    # plugin to engage (it only heals response_format requests), and
    # require_parameters already filters to providers that support it.
    return cast(
        Agent[object, OutputT],
        Agent(
            llm,
            output_type=NativeOutput(output_type),
            instructions=instructions,
            retries=config.retries,
        ),
    )


# --- Suppression (file-level only) --------------------------------------------
# Near-quote proximity suppression is dropped since there are no quotes.


def comment_rule_ids(comment_body: str) -> set[str]:
    ids = {item for item in re.split(r"[\s,]+", comment_body.strip()) if item}
    return ids or {"all"}


def suppressed_by_file(text: str, rule_id: str) -> bool:
    pattern = rf"<!--\s*{re.escape(config_name())}-disable-file(?:\s+([^>]*?))?\s*-->"
    for match in re.finditer(pattern, text):
        ids = comment_rule_ids(match.group(1) or "")
        if "all" in ids or rule_id in ids:
            return True
    return False


def drop_suppressed(findings: list[dict], text: str) -> list[dict]:
    """Findings for rules this document has not disabled.

    Suppression is applied to the ANSWER, not to the batch. Dropping a rule from the
    batch instead would give every distinct suppression set its own rule list, its own
    instructions, and so its own cache prefix — one `disable-file` comment would stop a
    file sharing the prefix that every other file is reusing. Asking about a rule and
    discarding its verdict costs a little output; fragmenting the prefix costs the
    cache. It also leaves the stored row complete, so removing a comment later reuses
    a verdict already paid for instead of re-asking.
    """
    return [finding for finding in findings if not suppressed_by_file(text, finding["rule_id"])]


# --- Cache ---------------------------------------------------------------------


CACHE_DIR = Path.home() / ".cache" / "llint"
CACHE_DB = CACHE_DIR / "cache.db"

_CACHE_MISS = object()


_connections = threading.local()


def _db() -> sqlite3.Connection:
    """Both caches in one file. Was one JSON file per entry, which cost a 4 KB
    block to store a 16-byte `{"result": null}` — 10x the actual bytes — and
    made pruning an unlink storm.

    One connection PER THREAD, not one shared: every lane here fans out over a
    ThreadPoolExecutor, and a shared handle raises ProgrammingError on the
    worker threads (check_same_thread), which the non-fatal write path would
    swallow — a cache that silently stores nothing. WAL plus the busy timeout
    keeps concurrent writers correct both across threads and across processes.

    What that does NOT cover is prune_cache racing a second `,llint` process:
    each computes a live set from its own corpus, so a pruner can evict votes a
    concurrent run just paid for. Writes stay consistent — the cost is re-spend,
    never a wrong verdict — and hk runs the one batched step, so this is a note
    rather than a lock.
    """
    conn = getattr(_connections, "conn", None)
    if conn is None:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(CACHE_DB, timeout=30.0)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")  # a lost cache entry costs one re-ask
        conn.execute("CREATE TABLE IF NOT EXISTS votes (key TEXT PRIMARY KEY, result TEXT NOT NULL)")
        conn.execute("CREATE TABLE IF NOT EXISTS plans (key TEXT PRIMARY KEY, result TEXT NOT NULL)")
        conn.commit()
        _connections.conn = conn
    return conn


# Disk-cache accounting, per table. The remote prompt cache saves money on work
# that still happens; this one skips the work outright, so the two answer different
# questions and both belong in the summary. A miss rate that jumps between runs of
# the same target is the tell that something silently changed a cache key.
_disk_cache_stats: dict[str, dict[str, int]] = {}
_disk_cache_lock = threading.Lock()


def _note_cache(table: str, outcome: str) -> None:
    with _disk_cache_lock:
        _disk_cache_stats.setdefault(table, {"hit": 0, "miss": 0, "write": 0})[outcome] += 1


def disk_cache_report() -> list[str]:
    """One line per table touched; empty when nothing used the cache."""
    with _disk_cache_lock:
        stats = {table: dict(counts) for table, counts in _disk_cache_stats.items()}
    lines = []
    for table, counts in sorted(stats.items()):
        looked_up = counts["hit"] + counts["miss"]
        if not looked_up:
            continue
        share = f"{counts['hit'] / looked_up:.0%}"
        lines.append(
            f"{table} cache: {counts['hit']:,}/{looked_up:,} reused ({share}), {counts['write']:,} newly stored"
        )
    return lines


def print_cache_summary() -> None:
    """Both cache layers at the end of a run, on stderr so `--format json` stdout
    stays parseable. Silent when neither cache was touched (e.g. a fully cached
    narrow run that issued no requests)."""
    lines = disk_cache_report()
    if remote := cache_report():
        lines.append(remote)
    for line in lines:
        print(f"  {line}", file=sys.stderr)


def _cache_has(table: str, key: str) -> bool:
    """Existence probe that deliberately does NOT move the counters: callers use it
    to plan work they have not done yet, and scoring a lookahead as a hit would
    inflate the very number the report exists to make trustworthy."""
    try:
        return _db().execute(f"SELECT 1 FROM {table} WHERE key = ? LIMIT 1", (key,)).fetchone() is not None
    except sqlite3.OperationalError:
        return False


def _cache_read(table: str, key: str) -> object:
    try:
        row = _db().execute(f"SELECT result FROM {table} WHERE key = ?", (key,)).fetchone()
    except sqlite3.OperationalError:
        _note_cache(table, "miss")
        return _CACHE_MISS  # locked or unreadable: re-ask rather than fail the run
    if row is None:
        _note_cache(table, "miss")
        return _CACHE_MISS
    try:
        value = json.loads(row[0])
    except json.JSONDecodeError:
        _note_cache(table, "miss")
        return _CACHE_MISS
    _note_cache(table, "hit")
    return value


def _cache_write(table: str, key: str, payload: dict) -> None:
    # Only OperationalError is tolerated. Swallowing every sqlite3.Error once hid
    # a ProgrammingError on every threaded write, so the cache stored nothing and
    # said nothing; a misuse bug must not look like a cache miss.
    try:
        with _db() as conn:
            conn.execute(
                f"INSERT OR REPLACE INTO {table} (key, result) VALUES (?, ?)",
                (key, json.dumps(payload)),
            )
        _note_cache(table, "write")
    except sqlite3.OperationalError:
        pass


# Bumped when the judge's prompt LAYOUT changes, as distinct from its content. The
# fields below cover every input the judge reads, but not how those inputs are
# arranged across system and user turns — and a model can vote differently on the
# same text depending on which turn carries it. Without this, moving TASK_PROMPT and
# the rule into the instructions (2026-07-27) would have kept serving votes cast
# under the old arrangement, mixing two prompt shapes under one verdict and hiding
# any shift the move caused.
JUDGE_PROMPT_LAYOUT = 3


def _cache_key(rules: list[Rule], file_display: str, model_list: list[str], runs: int, content: str) -> str:
    # Every rule's full definition (check text, tests, reasoning effort) shapes the
    # prompt, so editing any of them must invalidate the batch's cached votes. The
    # whole SET is the key because the batch is judged in one call: the same rule
    # asked alongside different neighbours is a different question, and pretending
    # otherwise would serve a vote the model never cast under these conditions.
    data = json.dumps(
        {
            "rules": sorted(rule.model_dump_json() for rule in rules),
            "file": file_display,
            "models": sorted(model_list),
            "runs": runs,
            "content": content,
            "layout": JUDGE_PROMPT_LAYOUT,
        },
        sort_keys=True,
    )
    return hashlib.sha256(data.encode()).hexdigest()


def cache_get(key: str) -> object:
    return _cache_read("votes", key)


def cache_set(key: str, findings: list[dict]) -> None:
    # Plural: one batch produces a verdict for every rule it asked about, so the row
    # holds the findings that fired rather than the single Optional a per-rule call
    # used to store. An empty list is a real, cacheable answer — every rule stayed
    # clear — and must not be confused with a miss.
    _cache_write("votes", key, {"results": findings})


def prune_cache(live: set[str]) -> int:
    """Drop judge votes outside `live`, returning how many went.

    A key covers the rule's full definition and the file's full content, so an
    entry the current corpus does not name can never be hit again — the prune is
    exact, not a heuristic guess at staleness. Only the caller knows whether it
    computed the *whole* live set: a run narrowed by --rule/--shape/paths names
    a subset, and pruning against that would evict entries the next full run
    still wants. Consumer plans live in their own table and are never swept —
    nothing enumerates the set of skill revisions worth keeping.
    """
    try:
        with _db() as conn:
            conn.execute("CREATE TEMP TABLE IF NOT EXISTS live_keys (key TEXT PRIMARY KEY)")
            conn.execute("DELETE FROM live_keys")
            conn.executemany("INSERT OR IGNORE INTO live_keys VALUES (?)", ((key,) for key in live))
            removed = conn.execute("DELETE FROM votes WHERE key NOT IN (SELECT key FROM live_keys)").rowcount
        if removed:
            conn.commit()
            conn.execute("VACUUM")  # outside any transaction; reclaims the pages
        return removed
    except sqlite3.OperationalError:
        return 0


# --- Voting engine ------------------------------------------------------------
# For each (rule, file): run N times per model; keep if ≥ 50% of total runs
# return at least one finding. Confidence = recurrence fraction.
# Findings are per (rule, file) — no quote, no line number.


async def _run_single(
    llm: OpenRouterModel,
    agent: Agent[object, OutputT],
    rules: list[Rule],
    input_file: dict,
    max_chars: int,
) -> OutputT:
    prompt = lint_prompt(input_file, max_chars, rules)
    async with openrouter_slot():
        result = await agent.run(prompt, model_settings=model_settings())
    note_usage(result.usage)
    return result.output


def _tally_finding(rule: Rule, input_file: dict, tally: dict, total: int, log: list[str]) -> Optional[dict]:
    """Turn one rule's per-run tallies into a finding dict, or None if it stayed clear."""
    completed, fired = tally["completed"], tally["fired"]
    support = fired / completed
    if support < 0.5:
        log.append(f"    {rule.id}: clear ({fired}/{completed})")
        return None
    best_msg = stat_mode(tally["messages"]) if tally["messages"] else rule.title
    best_sug = stat_mode(tally["suggestions"]) if tally["suggestions"] else ""
    log.append(f"    {rule.id}: FIRED ({fired}/{completed}) {best_msg}")
    return {
        "path": input_file["display"],
        "severity": rule.severity,
        "rule_id": rule.id,
        "title": rule.title,
        "message": best_msg,
        "suggestion": best_sug,
        "support": support,
        "runs_fired": fired,
        "completed_runs": completed,
        "total_runs": total,
        "why": rule.why,
    }


async def vote_rules(
    config: LlintAgentConfig,
    rules: list[Rule],
    input_file: dict,
    api_key: str,
    runs: int,
    max_chars: int,
    use_cache: bool = True,
) -> list[dict]:
    """Judge every rule in `rules` against one document, in one call per run.

    N×models × N runs as before, and the majority vote is still taken per rule — the
    batch changes how the question is asked, not how it is counted. Returns the rules
    that fired, in the order given.

    Per-run completion is tracked per rule rather than per call because a run that
    errors mid-flight yields nothing for any rule, and a rule's support must be a
    fraction of the runs that actually answered *it*.

    `disable-file` comments are honoured on the way out rather than by shrinking the
    batch — see drop_suppressed for why the batch stays whole.
    """
    if not rules:
        return []

    if use_cache:
        key = _cache_key(rules, input_file["display"], config.models, runs, input_file["text"])
        cached = cache_get(key)
        if cached is not _CACHE_MISS:
            return drop_suppressed(cast(list[dict], cast(dict, cached).get("results") or []), input_file["text"])

    rule_ids = tuple(rule.id for rule in rules)
    output_type = batch_result_model(rule_ids)
    instructions = judge_instructions(config, rules)
    total = len(config.models) * runs
    tallies: dict[str, dict] = {
        rule.id: {"completed": 0, "fired": 0, "messages": [], "suggestions": []} for rule in rules
    }

    # Buffered, not printed as it goes: callers run several documents at once, and
    # interleaved per-run chatter from four batches is unreadable. One block per
    # document, emitted whole, stays legible however many are in flight.
    log = [f"  {input_file['display']}  ({len(rules)} rules)"]
    # Sequential, and model_settings() quietly depends on it: its second cache
    # breakpoint marks the document so the repeats below — byte-identical requests
    # differing only in sampling — read it instead of re-paying it. That only works
    # while the first call's cache write lands before the second call asks. Running
    # these in a pool would not fail anything; it would silently turn those reads into
    # concurrent writes and make the breakpoint cost money instead of saving it, which
    # is exactly the trap the top-level `cache_control` fell into. Throughput comes from
    # running separate DOCUMENTS at once — they have their own prefixes and do not race.
    for model_id in config.models:
        llm = build_model(model_id, api_key)
        agent = make_lint_agent(llm, config, output_type, instructions)
        for i_run in range(runs):
            if budget_lost():
                break  # nothing below can succeed; let the caller report it once
            try:
                result = await _run_single(llm, agent, rules, input_file, max_chars)
            except Exception as e:
                note_if_terminal(e)
                log.append(f"    warning: {model_id} [{i_run + 1}/{runs}]: {e}")
                continue
            # Validation guarantees every rule is answered for, so one successful call
            # is one completed run for each of them.
            for rule_id, found in findings_by_rule(result, rule_ids).items():
                tally = tallies[rule_id]
                tally["completed"] += 1
                if found:
                    tally["fired"] += 1
                    tally["messages"].extend(f.message.strip() for f in found if f.message.strip())
                    tally["suggestions"].extend(f.suggestion.strip() for f in found if f.suggestion.strip())

    if total == 0:
        return []
    if all(tally["completed"] == 0 for tally in tallies.values()):
        # Transient provider failure — report, and skip the cache so the next
        # run retries instead of trusting a vote that never happened.
        log.append(f"    → no completed runs (0/{total}); skipping cache")
        print("\n".join(log), file=sys.stderr, flush=True)
        return []

    results = [
        finding
        for rule in rules
        if tallies[rule.id]["completed"]
        if (finding := _tally_finding(rule, input_file, tallies[rule.id], total, log)) is not None
    ]
    print("\n".join(log), file=sys.stderr, flush=True)
    # Store every rule's verdict, then filter: the row stays useful if the document's
    # suppression comments change later.
    if use_cache:
        cache_set(key, results)  # type: ignore[possibly-undefined]
    return drop_suppressed(results, input_file["text"])


# --- Self-check ---------------------------------------------------------------
# De-circularized: the case under test is held out from the examples in the prompt.


def test_input(rule: Rule, index: int, kind: str, text: str) -> dict:
    display = f"{rule.id} test {index} {kind}"
    scopes = [scope for scope in rule.scope if scope != "all"] or ["agent-guidance"]
    return {"display": display, "scopes": scopes, "text": text}


async def run_self_check(
    config: LlintAgentConfig,
    rules: list[Rule],
    api_key: str,
    max_chars: int,
) -> list[dict]:
    results = []
    for rule in rules:
        for index, test in enumerate(rule.tests, 1):
            for kind, should_flag in (("bad", True), ("good", False)):
                input_file = test_input(rule, index, kind, getattr(test, kind))

                # A batch of one: self-check asks whether THIS rule fires on its own
                # test case, so batching it with neighbours would measure something
                # else. Hold out the case under test — it lives in the rule text, so
                # the exclusion belongs to the instructions, not the user turn.
                prompt = lint_prompt(input_file, max_chars, [rule])
                held_out = judge_instructions(config, [rule], exclude_test_index=index)
                output_type = batch_result_model((rule.id,))

                all_fired: list[bool] = []
                errored = 0
                for model_id in config.models:
                    llm = build_model(model_id, api_key)
                    agent = make_lint_agent(llm, config, output_type, held_out)
                    try:
                        async with openrouter_slot():
                            result = await agent.run(prompt, model_settings=model_settings())
                        note_usage(result.usage)
                        all_fired.append(bool(findings_by_rule(result.output, (rule.id,))[rule.id]))
                    except Exception:
                        # An errored call is no vote at all — counting it as
                        # "did not fire" would fail bad-cases on provider flake.
                        errored += 1

                # Majority vote across models that actually answered
                fired_count = sum(all_fired)
                total = len(all_fired)
                majority_fired = fired_count > total / 2 if total > 0 else False
                passed = majority_fired if should_flag else not majority_fired

                results.append(
                    {
                        "rule_id": rule.id,
                        "test": index,
                        "kind": kind,
                        "passed": passed,
                        "expected": "finding" if should_flag else "no finding",
                        "fired": majority_fired,
                        "fired_count": fired_count,
                        "total_runs": total,
                        "errored": errored,
                    }
                )
    return results


# --- Consumer ablation substrate ----------------------------------------------
# One path for "run a consumer model on a task under some guidance text, N
# times, and measure how often a grader passes." Shared by `eval` (whole-skill
# redundant/effective/ineffective) and the `ablate`/`compress`/`compile` family
# (per-atom deltas / minimal-subset search). These used to be two tools on two
# HTTP stacks, so the noise policy and retry hardening had to land twice; now
# finish_reason classification, the disk cache, and the in-flight bound live
# here once. Consumers emit free text (graded by grade.sh), so this stack skips
# the judge lane's NativeOutput/response-healing entirely.

# Above honest answer sizes for a "write a plan" task, but low enough that a
# consumer that never stops reasoning hits `length` (an incomplete run) instead
# of an unbounded bill. Part of the cache key: a different cap grades different
# text, so measurements taken under different caps must never mix.
MAX_CONSUMER_OUTPUT_TOKENS = 8000

# The consumer persona, held byte-identical across eval and the compile family
# so their support numbers stay directly comparable — they had drifted by one
# word ("the task" vs "the given task") while the tools were separate.
BASE_CONSUMER_INSTRUCTIONS = (
    "You are a capable AI assistant. Answer the task directly and concisely. "
    "When asked to write a plan, outline the steps you would take."
)

# OpenRouter limits a RATE, and rate is only in-flight-count divided by latency —
# so a semaphore alone controls the wrong quantity. Latency here swings ~8x between
# stages (the no-guidance arm returns far shorter plans than the full-text one)
# and ~10x across consumers, which is how one unchanged Semaphore(12) produced
# both 0.5 and 4.3 batches/min inside a single 2026-07-27 run.
#
# Every call bills against the same key regardless of which model serves it, so
# one global bucket is the right shape. Acquisition blocks, supplying backpressure.
#
# Nothing upstream offers RATE limiting: tenacity is retry-only, and pydantic-ai's
# concurrency module limits concurrent requests rather than requests per minute (its
# ConcurrencyLimitedModel would replace the in-flight cap below, not this). PyrateLimiter
# ships an httpx transport, but it subclasses AsyncHTTPTransport directly and accepts no
# inner transport, so it cannot stack under AsyncTenacityTransport either. Hence a plain
# wrapper at the request site, which is also the only place a *shared* budget can live:
# build_model makes a fresh httpx client per attempt, so anything bound to a transport
# would be per-client rather than global.
OPENROUTER_RPM = 300

# The second half of the pair, and a CEILING rather than a control. Little's Law gives
# the concurrency a rate implies — N = rate x latency — and latency here is not one
# number: a judge completion is ~2.5s, while a consumer plan runs to
# MAX_CONSUMER_OUTPUT_TOKENS and takes tens of seconds. Sustaining ~250 req/min
# (4.17/s) therefore needs ~10 open requests on the judge lane and ~125 on the consumer
# lane. Sizing this for the slower one is what keeps it from binding: the limiter above
# then sets the pace on both, and in-flight count settles at rate x latency by itself.
#
# Sized at 10 it was the binding control on the slow lane rather than a ceiling, holding
# `improve` to ~20 req/min where the budget allowed ~250.
#
# Distinct from the Semaphore(12) this resembles: that one WAS the rate control, and
# steering a rate by in-flight count fails precisely because latency moves. Here the
# limiter owns rate and this owns what rate cannot — the resource footprint of an open
# request and the size of any opening burst, since a leaky bucket would otherwise permit
# a full window at once. It is held for the WHOLE call rather than just the send; that
# is the difference between bounding in-flight work and bounding submissions.
#
# 125 is affordable because a request in flight is a coroutine, not a thread: one event
# loop and one HTTP client serve all of them. Under the previous thread-per-request
# shape this number would have meant 125 threads, 125 event loops and 125 clients, which
# is what made it worth rewriting.
#
# This is the only concurrency number to set. Both commands size their fan-out from it
# rather than exposing a parallelism flag: a second dial for the same quantity can only
# disagree with the first, and neither could raise the rate anyway — extra tasks just
# queue here.
MAX_REQUESTS_IN_FLIGHT = 125


_openrouter_limiter: Optional[Limiter] = None
_in_flight: Optional[anyio.CapacityLimiter] = None


@asynccontextmanager
async def openrouter_slot() -> AsyncIterator[None]:
    """Hold one in-flight slot for the duration of a request, within the rate budget.

    Concurrency is taken first and the rate token second, so a task waiting for a slot is
    not sitting on a token it cannot use yet — spending the token immediately before the
    request goes out is what keeps the measured rate equal to the configured one.

    `try_acquire_async` rather than `try_acquire`: the sync form blocks the calling
    thread, which on a single event loop would stall every other request in flight
    instead of just this one.

    Both are built on first use rather than at import: a Limiter starts a background leak
    thread and a CapacityLimiter must be created from inside a running loop, and `--help`
    must pay for neither.
    """
    global _openrouter_limiter, _in_flight
    if _in_flight is None:
        _in_flight = anyio.CapacityLimiter(MAX_REQUESTS_IN_FLIGHT)
    if _openrouter_limiter is None:
        _openrouter_limiter = Limiter(Rate(OPENROUTER_RPM, Duration.MINUTE))
    async with _in_flight:
        await _openrouter_limiter.try_acquire_async("openrouter")
        yield


# finish_reasons a retry cannot change for a given (model, prompt): the provider
# deterministically filtered the content or hit the token cap.
_TERMINAL_INCOMPLETE = ("content_filter", "length")


def response_detail(response: object) -> str:
    """Why a 200 came back unusable.

    An upstream failure reaches us as finish_reason='error' on an otherwise-fine HTTP
    response — pydantic-ai flattens every upstream reason to that one token, so it
    names nothing on its own. provider_details keeps what actually happened, and
    `is_byok` in particular separates "your own upstream key is exhausted" from
    "OpenRouter's pooled capacity flaked". On 2026-07-27 a BYOK exhaustion showed up
    as two bare `finish_reason=error` warnings and stayed unexplained until the
    account page was checked by hand.

    TODO: once a few real native reasons have been logged, classify the exhaustion
          ones as terminal like the 401/402/403 statuses. Not guessed at now, because
          nothing here has yet seen the strings upstreams actually send.
    """
    details = getattr(response, "provider_details", None) or {}
    parts = [f"finish_reason={getattr(response, 'finish_reason', None)}"]
    if native := details.get("finish_reason"):
        parts.append(f"native={native}")
    if provider := details.get("downstream_provider"):
        parts.append(f"provider={provider}")
    if details.get("is_byok"):
        parts.append("byok=yes")
    return ", ".join(parts)


def _pct(value: Optional[float]) -> str:
    return "n/a" if value is None else f"{value:.0%}"


def consumer_model_settings() -> OpenRouterModelSettings:
    # Distinct from the judge's model_settings(): free-text output means no
    # NativeOutput/response-healing (both only engage on response_format). No
    # sampling params — real consumer harnesses run provider defaults. max_tokens
    # both caps cost and turns runaway reasoning into a `length` finish.
    #
    # Caching was correctly absent while the system prompt was nothing but churning
    # skill text, which cleared no provider's prefix minimum. Sending deployed
    # context (2026-07-27) inverted that: `context` now leads the prompt at ~2331
    # tokens, byte-identical across every call, and clears the ~1024-token floor
    # assumed for frontier models. Without an opt-in the two Anthropic consumers
    # re-paid that prefix on every one of ~20k calls, wasting the stable-first
    # ordering built to make it cacheable.
    #
    # The first attempt at the opt-in set a top-level `cache_control`, which is
    # Anthropic's *automatic* mode and lands the breakpoint on the last cacheable
    # block — the per-case prompt, which changes on every call. That is strictly
    # worse than no caching: a fresh write every request, never a read. See the
    # judge lane's model_settings() for the mechanism. This marks the instructions
    # instead, whose last block is the true end of the static prefix.
    #
    # Anthropic is the only consumer needing the opt-in; kimi-k3, glm-5.2 and the two
    # gpt-5.6 models cache automatically off the literal prefix. The stable-first
    # ordering below is what earns their hits, and it is doing most of the work here —
    # the system prompt is ~2331+ tokens against a ~58-token case prompt.
    #
    # 5m rather than the judge lane's 1h: TTL should track the reuse INTERVAL, not
    # the run's length. improve's measure() runs one candidate's whole grid inside a
    # single pool, so this prefix is re-hit densely and 5m never lapses — billing
    # writes at 1.25x instead of 2x. The judge lane reuses a rule's prefix across
    # interleaved documents and measured 1h as the better buy.
    #
    # Second breakpoint on the message, matching the judge lane. It earns much less
    # here — the varying part is one eval prompt (58 tokens median, 120 at the largest,
    # measured across all 79 cases) against a ~2331-token prefix — and which way it
    # lands depends on whether the repeats fit in one wave of consumer_plans' pool:
    #
    #   candidate arm, 5 runs / 5 workers: all concurrent, so all 5 miss and all 5
    #     write. 290 -> 362 tokens. A small loss.
    #   baseline arm, 15 runs / 6 workers: 6 miss, the remaining 9 start after a write
    #     has landed and read. 870 -> 487 tokens. A larger win.
    #
    # Kept on both arms rather than tuned per arm, because the amounts are noise beside
    # the prefix and an unexplained asymmetry between the two lanes costs more attention
    # than it saves tokens. What is NOT done to chase the candidate arm is serialising
    # the first run: that halves the batch's concurrency, and improve measured
    # latency-bound rather than rate-limit-bound (~2-4.3 batches/min against a 300 RPM
    # budget), so it would trade real throughput for ~70 tokens.
    #
    # The big prefix is safe either way — warm_consumers is a barrier, so the
    # instructions block is written before any burst starts.
    #
    # The prefix ends after the skill text, so a NEW candidate re-writes the whole
    # thing, `context` included. Splitting those into two breakpoints would need the
    # skill text out of the system prompt (pydantic-ai's second lever is CachePoint,
    # user-message only) — i.e. deliberately measuring a prompt shape no real
    # consumer harness uses. Not worth trading measurement fidelity for cache hits.
    return {
        "max_tokens": MAX_CONSUMER_OUTPUT_TOKENS,
        "openrouter_cache_instructions": "5m",
        "openrouter_cache_messages": "5m",
        "extra_body": {
            "session_id": SESSION_ID,
        },
    }


def _consumer_cache_key(
    model_id: str, skill_text: str, prompt: str, runs: int, base_instructions: str, context: str
) -> str:
    # `context` is part of the key because it is part of the system prompt: a plan
    # produced without the surrounding guidance answers a different question than one
    # produced with it, and reusing the former would silently re-introduce the bias
    # that sending context exists to remove.
    return hashlib.sha256(
        json.dumps(
            {
                "model": model_id,
                "skill": skill_text,
                "prompt": prompt,
                "runs": runs,
                "max_tokens": MAX_CONSUMER_OUTPUT_TOKENS,
                "base": base_instructions,
                "context": context,
            },
            sort_keys=True,
        ).encode()
    ).hexdigest()


async def _one_consumer_run(model_id: str, system: str, prompt: str, api_key: str) -> tuple[str, bool]:
    """One consumer completion -> (plan, complete). content_filter/length are
    terminal-incomplete (a retry cannot change them); empty 200s and
    finish_reason 'error' (partial content that must not reach a grader) retry
    like transport errors."""
    last = "no response"
    for attempt in range(OPENROUTER_SIMPLE_RETRY_ATTEMPTS):
        # Another task already proved the key is finished; spending a request to
        # rediscover that is what turned one 403 into thousands.
        if budget_lost():
            return "", False
        try:
            agent: Agent[object, str] = Agent(build_model(model_id, api_key), output_type=str, instructions=system)
            async with openrouter_slot():
                result = await agent.run(prompt.strip(), model_settings=consumer_model_settings())
            note_usage(result.usage)
            plan = result.output or ""
            finish = result.response.finish_reason
            if finish in _TERMINAL_INCOMPLETE:
                return plan, False
            if finish != "error" and plan.strip():
                return plan, True
            last = f"unusable response ({response_detail(result.response)})"
        except Exception as error:
            last = str(error)
            if note_if_terminal(error):
                return "", False
        if attempt < OPENROUTER_SIMPLE_RETRY_ATTEMPTS - 1:
            await anyio.sleep(2 * (attempt + 1))
    print(
        f"{program_name()}: warning: {model_id} call failed after retries ({last}); run counted incomplete",
        file=sys.stderr,
    )
    return "", False


def consumer_system(skill_text: str, base_instructions: str, context: str) -> str:
    """The consumer's system prompt.

    Stable-to-varying, which is both real precedence (the skill is the most specific
    layer, so it reads last) and the only order a prompt cache can exploit: `context`
    is byte-identical across every candidate, so it stays one reusable prefix while
    `skill_text` churns beneath it.

    Shared with the cache warm-up rather than rebuilt there, because the warm-up is
    only useful if its prefix is byte-identical to the one the real calls send. Two
    copies of this join would drift into writing an entry nothing ever reads, and
    nothing would report it — the run would just cost more.
    """
    return "\n\n".join(part for part in (context.strip(), skill_text.strip(), base_instructions) if part)


async def warm_consumer_prefix(model_id: str, system: str, api_key: str) -> None:
    """Write the shared instructions prefix into one consumer's cache, once.

    Without this, each candidate opens with a stampede: measure() runs many batches at
    once and they all share this one system prompt, but a cache entry "only becomes
    available after the first response begins" — so every request in that opening wave
    misses and every one pays a full-prefix write. One small request first converts all
    of them into reads.

    Nearly free: it pays a write the run owed anyway, and max_tokens=1 means
    essentially no output billing. Errors are swallowed on purpose — a cold cache is
    slower and costlier, never wrong, so failing the measurement over it would trade
    a real result for a cheaper one.
    """
    if budget_lost():
        return
    settings = consumer_model_settings()
    settings["max_tokens"] = 1
    # Mark the instructions only. The message breakpoint the real calls carry would
    # here key an entry to the "warmup" placeholder — a suffix no measured request ever
    # sends, so the write is paid for and never read. Anthropic's pre-warm guidance
    # names this directly: put the breakpoint on the last block SHARED with the
    # follow-up request, not on the placeholder.
    settings.pop("openrouter_cache_messages", None)
    try:
        agent: Agent[object, str] = Agent(build_model(model_id, api_key), output_type=str, instructions=system)
        async with openrouter_slot():
            result = await agent.run("warmup", model_settings=settings)
        note_usage(result.usage)
    except Exception as error:
        note_if_terminal(error)


async def warm_consumers(model_ids: Iterable[str], system: str, api_key: str) -> None:
    """Warm `system` on every listed consumer, returning only once all have answered."""
    models = list(model_ids)
    if not models:
        return
    async with anyio.create_task_group() as group:
        for model_id in models:
            group.start_soon(warm_consumer_prefix, model_id, system, api_key)


def consumer_plans_cached(
    model_id: str, skill_text: str, prompt: str, runs: int, base_instructions: str, context: str
) -> bool:
    """Is this batch already on disk? Lets the warm-up skip models with no cold work,
    so resuming a mostly-cached run spends nothing warming caches it never reads."""
    return _cache_has("plans", _consumer_cache_key(model_id, skill_text, prompt, runs, base_instructions, context))


async def consumer_plans(
    model_id: str,
    skill_text: str,
    prompt: str,
    runs: int,
    api_key: str,
    base_instructions: str = BASE_CONSUMER_INSTRUCTIONS,
    context: str = "",
) -> list[tuple[str, bool]]:
    """`runs` (plan, complete) pairs for `prompt` under `skill_text`, disk-cached
    by content so repeat measurements — and re-runs across stages — are free."""
    key = _consumer_cache_key(model_id, skill_text, prompt, runs, base_instructions, context)
    cached = _cache_read("plans", key)
    if cached is not _CACHE_MISS:
        try:
            return [(row["plan"], row["complete"]) for row in cast(dict, cached)["runs"]]
        except (KeyError, TypeError):
            pass

    system = consumer_system(skill_text, base_instructions, context)
    # One run alone, then the rest together. Every run here sends a byte-identical
    # request and differs only in sampling, so the first response is what puts this
    # exact prompt in the provider's cache and the burst behind it reads rather than
    # each paying for the same prefix again. Fired as one flat wave they all miss at
    # once, which is why the breakpoint in consumer_model_settings() needs this shape
    # to pay off at all.
    #
    # Costs one extra round trip per batch. That is a real trade, but a smaller one
    # than it looks: openrouter_slot caps requests in flight globally, so a batch left
    # open is not the scarce resource — measure() simply runs enough batches to keep
    # that ceiling fed.
    #
    # The rest go at once. This used to be capped at 6 on the theory that larger bursts
    # of IDENTICAL prompts provoke empty 200s from some providers (Moonshot, 2026-07-08
    # sweeps), but that was one provider on one day, and an empty 200 is already handled
    # where every other unusable body is: _one_consumer_run retries it with backoff. A
    # recurrence costs a retry; the cap cost every batch a narrower fan-out forever.
    # openrouter_slot is the real bound, and it is global.
    results: list[tuple[str, bool]] = [await _one_consumer_run(model_id, system, prompt, api_key)]
    if runs > 1:
        # Indexed rather than appended: a task group finishes in completion order, and
        # `runs` is a sample size whose order must stay stable for the disk cache.
        rest: list[tuple[str, bool]] = [("", False)] * (runs - 1)

        async def one(slot: int) -> None:
            rest[slot] = await _one_consumer_run(model_id, system, prompt, api_key)

        async with anyio.create_task_group() as group:
            for slot in range(runs - 1):
                group.start_soon(one, slot)
        results.extend(rest)

    # Skip the cache when a whole batch completed nothing: that is usually a
    # transient provider outage, and caching it would poison every future read
    # (llint's judge cache skips the same way). A partially-complete batch is
    # real signal and gets stored.
    if any(complete for _, complete in results):
        _cache_write("plans", key, {"runs": [{"plan": plan, "complete": complete} for plan, complete in results]})
    return results


async def graded_support(
    model_id: str,
    skill_text: str,
    prompt: str,
    grader: Path,
    runs: int,
    api_key: str,
    base_instructions: str = BASE_CONSUMER_INSTRUCTIONS,
    context: str = "",
) -> tuple[Optional[float], int]:
    """(support, completed_count). support = fraction of COMPLETED runs whose
    grader passes; None when under half the runs completed — a case measured on
    a two-sample fluke is unmeasurable, and comparisons must skip it rather than
    trust it."""
    results = await consumer_plans(model_id, skill_text, prompt, runs, api_key, base_instructions, context)
    completed = [plan for plan, complete in results if complete]
    if len(completed) < (runs + 1) // 2:
        return None, len(completed)
    graded = [await grade_plan(grader, plan) for plan in completed]
    return sum(graded) / len(completed), len(completed)


def _pooled_support(samples: Iterable[tuple[Optional[float], int]]) -> tuple[float, int]:
    """Aggregate one arm's support across consumers, weighted by completed runs and
    skipping any consumer unmeasurable in that arm. Weighting matters: a model that
    finished two of five runs must not vote as loudly as one that finished all five,
    or a single flaky consumer swings the verdict for the whole case."""
    numerator = denominator = 0.0
    for support, completed in samples:
        if support is not None and completed > 0:
            numerator += support * completed
            denominator += completed
    return (numerator / denominator if denominator else 0.0), int(denominator)


# --- Eval (behavioral ablation) -----------------------------------------------


def eval_verdict(without_support: float, with_support: float) -> str:
    """Ablation verdict: the consumer already had the insight (redundant), gained it from the skill (effective), or lacked it either way (ineffective)."""
    if without_support >= 0.5:
        return "redundant"
    if with_support >= 0.5:
        return "effective"
    return "ineffective"


async def grade_plan(grade_script: Path, plan: str) -> bool:
    """Run grader script with plan on stdin. Returns True if insight is present (exit 0).

    Off the event loop: graders are arbitrary shell scripts that can block for up to the
    timeout, and running one inline would stall every request in flight behind it.
    """

    def run() -> bool:
        try:
            proc = subprocess.run(
                [str(grade_script)],
                input=plan,
                text=True,
                capture_output=True,
                timeout=30,
            )
            return proc.returncode == 0
        except (subprocess.TimeoutExpired, OSError) as e:
            print(f"{program_name()}: warning: grader {grade_script.name} failed: {e}", file=sys.stderr)
            return False

    return await anyio.to_thread.run_sync(run)


# --- Guidance compilation: atoms, ablation, compression, subset selection -----
# Ported from the former `,gcompile`. Parses a SKILL.md / AGENTS.md into keepable
# "atoms" (the philosophy paragraph + each directive), measures each atom's
# contribution on the shared consumer substrate above, and searches for the
# smallest / shortest text that still holds eval support per consumer model.


@dataclass
class Atom:
    id: str
    section: str
    text: str  # verbatim block, including trailing newline(s)
    sep: str = "\n"  # separator before this atom within its section ("\n" or "\n\n")

    @property
    def summary(self) -> str:
        first = self.text.strip().splitlines()[0]
        return first[:110] + ("…" if len(first) > 110 else "")


@dataclass
class Skill:
    frontmatter: str  # verbatim, may be empty
    sections: list[tuple[str, list[str]]]  # (heading line, atom ids in order)
    atoms: dict[str, Atom]
    refs: str  # trailing reference-link definitions, always kept

    def render(self, keep: set[str]) -> str:
        chunks: list[str] = []
        for heading, atom_ids in self.sections:
            kept = [self.atoms[a] for a in atom_ids if a in keep]
            if not kept:
                continue
            body = kept[0].text.rstrip("\n")
            for atom in kept[1:]:
                body += atom.sep + atom.text.rstrip("\n")
            chunks.append(heading + "\n\n" + body)
        if self.refs:
            chunks.append(self.refs.rstrip("\n"))
        body = "\n\n".join(chunks) + "\n"
        return (self.frontmatter + "\n" + body) if self.frontmatter else body


def parse_skill(text: str) -> Skill:
    frontmatter = ""
    body = text
    if text.startswith("---\n"):
        end = text.find("\n---\n", 4)
        if end != -1:
            frontmatter = text[: end + 5]
            body = text[end + 5 :]

    lines = body.splitlines()
    sections: list[tuple[str, list[str]]] = []
    atoms: dict[str, Atom] = {}
    refs_lines: list[str] = []
    current_heading = ""
    current_ids: list[str] = []
    block: list[str] = []
    block_kind = ""  # "prose" | "bullet"
    block_sep = "\n"  # separator that preceded the current block
    counter = 0

    def flush_block() -> None:
        nonlocal block, block_kind, counter
        content = "\n".join(block).strip("\n")
        block = []
        kind, block_kind = block_kind, ""
        if not content.strip():
            return
        if kind == "prose" and current_heading.lstrip("# ").strip().lower() == "philosophy":
            atom_id = "phil"
        else:
            counter += 1
            atom_id = f"d{counter:02d}"
        atoms[atom_id] = Atom(id=atom_id, section=current_heading, text=content + "\n", sep=block_sep)
        current_ids.append(atom_id)

    def flush_section() -> None:
        nonlocal current_ids
        flush_block()
        if current_heading:
            sections.append((current_heading, current_ids))
        current_ids = []

    for line in lines:
        if re.match(r"^#{1,6} ", line):
            flush_section()
            current_heading = line
        elif re.match(r"^\[[^\]]+\]:", line):
            flush_block()
            refs_lines.append(line)
        elif line.startswith("- "):
            sep = "\n\n" if block and not block[-1].strip() else "\n"
            flush_block()
            block = [line]
            block_kind = "bullet"
            block_sep = sep
        elif block:
            block.append(line)
        elif line.strip():
            block = [line]
            block_kind = "prose"
            block_sep = "\n\n"
    flush_section()

    refs = ("\n".join(refs_lines) + "\n") if refs_lines else ""
    return Skill(frontmatter=frontmatter, sections=sections, atoms=atoms, refs=refs)


@dataclass
class EvalCase:
    name: str
    prompt: str
    grader: Path


def load_cases(evals_dir: Path) -> list[EvalCase]:
    if not evals_dir.is_dir():
        raise FileNotFoundError(f"no eval cases directory at {evals_dir}")
    cases = []
    for case_dir in sorted(p for p in evals_dir.iterdir() if p.is_dir()):
        prompt, grader = case_dir / "prompt.md", case_dir / "grade.sh"
        if prompt.exists() and grader.exists():
            cases.append(EvalCase(case_dir.name, prompt.read_text(encoding="utf-8"), grader))
    if not cases:
        raise ValueError(f"no usable eval cases in {evals_dir}")
    return cases


async def case_support(
    model_id: str,
    skill_text: str,
    case: EvalCase,
    runs: int,
    api_key: str,
    base_instructions: str = BASE_CONSUMER_INSTRUCTIONS,
    context: str = "",
) -> Optional[float]:
    """Support fraction for one eval case: a wrapper over the shared graded_support
    (None when the case is unmeasurable for this text)."""
    return (
        await graded_support(model_id, skill_text, case.prompt, case.grader, runs, api_key, base_instructions, context)
    )[0]


def holds_baseline(candidate: dict[str, Optional[float]], baseline: dict[str, Optional[float]], margin: float) -> bool:
    """True when every case measurable at baseline stays within margin of it. A case
    measurable at baseline but unmeasurable under the candidate FAILS — matching
    compile certification's None-fails semantics; otherwise a rewrite that induces
    reasoning explosions (all-`length` runs) gets a free pass on exactly the cases
    it broke. Cases with no baseline anchor are skipped."""
    for name, support in candidate.items():
        base = baseline[name]
        if base is None:
            continue
        if support is None or support < base - margin - 1e-9:
            return False
    return True


def gate(rendered: str, agents_mode: bool = False) -> Optional[str]:
    """Run the repo's deterministic lanes on a candidate. None = pass, str = failure output."""
    cwd = Path.cwd()
    schema = ".mdschema-agents.yml" if agents_mode else ".mdschema-skill.yml"
    if not (cwd / schema).exists() or not (cwd / ".vale.ini").exists():
        return None  # not in the dotfiles repo; gates unavailable
    tmp_dir = cwd / ".llint-tmp"
    tmp_dir.mkdir(exist_ok=True)
    tmp = tmp_dir / ("AGENTS.md" if agents_mode else "SKILL.md")
    tmp.write_text(rendered, encoding="utf-8")
    try:
        checks = [
            ["mdschema", "check", "--schema", schema, str(tmp.relative_to(cwd))],
            ["vale", "--output=line", str(tmp.relative_to(cwd))],
            [".lints/constraint-density.sh", str(tmp.relative_to(cwd))],
        ]
        for cmd in checks:
            if shutil.which(cmd[0]) is None and not Path(cmd[0]).exists():
                continue
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
            if proc.returncode != 0:
                return f"gate `{cmd[0]}` failed:\n{proc.stdout}\n{proc.stderr}".strip()
        return None
    finally:
        tmp.unlink(missing_ok=True)
        try:
            tmp_dir.rmdir()
        except OSError:
            pass


def make_reflector(model_id: str, api_key: str):
    """Reflection LM as a pydantic-ai str agent, so the compile family stays off raw
    httpx. Accepts a plain str prompt or GEPA's openai-style message list."""

    async def reflect(prompt) -> str:
        text = (
            prompt
            if isinstance(prompt, str)
            else "\n\n".join(f"{m.get('role', 'user')}: {m.get('content', '')}" for m in prompt)
        )
        agent: Agent[object, str] = Agent(build_model(model_id, api_key), output_type=str)
        async with openrouter_slot():
            result = await agent.run(
                text, model_settings={"max_tokens": 4000, "extra_body": {"session_id": SESSION_ID}}
            )
        note_usage(result.usage)
        return result.output or ""

    return reflect


def sync_reflector(reflect, portal: anyio.from_thread.BlockingPortal):
    """The same reflector, callable from GEPA's worker threads.

    Only subset search needs this: it drives its search synchronously, so it cannot
    await. Bridging back through the portal rather than letting it open its own client
    is what keeps those requests under the same rate budget and in-flight ceiling as
    everything else, instead of a second, unlimited request stack.
    """

    def lm(prompt) -> str:
        return portal.call(partial(reflect, prompt))

    return lm


# The reflector sees ONLY the atom text — never eval prompts or grader
# contents, or the optimizer learns to embed grader tokens instead of meaning.
REWRITE_PROMPT = """\
Rewrite the following block from an agent-guidance file to use as few tokens \
as possible while preserving every constraint, fact, example, and reference \
it carries. Requirements: coherent English a human maintainer can read; keep \
the Markdown shape (a top-level `- ALWAYS:`/`- NEVER:` bullet keeps its token \
and stays one bullet; a prose paragraph stays prose); keep reference-style \
link usages intact. Produce {k} alternative rewrites, from most conservative \
to most aggressive, separated by lines containing only `---`. Output nothing \
else.

Block:

{block}"""


def render_override(parsed: Skill, overrides: dict[str, str], keep: Optional[set[str]] = None) -> str:
    """Render with `overrides` substituted; `keep` restricts which atoms survive
    (default: all of them, which is what compression alone wants)."""
    atoms = {aid: (replace(a, text=overrides[aid]) if aid in overrides else a) for aid, a in parsed.atoms.items()}
    return Skill(parsed.frontmatter, parsed.sections, atoms, parsed.refs).render(set(atoms) if keep is None else keep)


def _load(skill: Path) -> tuple[Skill, list[EvalCase], str, bool]:
    """Load a skill dir (SKILL.md + evals/) or a bare guidance file (AGENTS.md +
    .evals/<name lowercased>/ beside it). Returns (parsed, cases, text, agents_mode)."""
    if skill.is_file() and skill.name != "SKILL.md":
        text = skill.read_text(encoding="utf-8")
        evals_dir = skill.parent / ".evals" / skill.stem.lower().replace("_", "-")
        return parse_skill(text), load_cases(evals_dir), text, True
    skill_dir = skill if skill.is_dir() else skill.parent
    text = (skill_dir / "SKILL.md").read_text(encoding="utf-8")
    return parse_skill(text), load_cases(skill_dir / "evals"), text, False


def _candidate_text(candidate: dict[str, str]) -> str:
    return next(iter(candidate.values())) if isinstance(candidate, dict) else str(candidate)


def _candidate_bytes(parsed: Skill, candidate: dict[str, str]) -> int:
    ids = {t.strip() for t in _candidate_text(candidate).replace("\n", ",").split(",") if t.strip()}
    ids &= set(parsed.atoms)
    return len(parsed.render(ids).encode())


# --- Output -------------------------------------------------------------------

SEVERITY_RANK = {"suggestion": 0, "warning": 1, "error": 2}


def print_finding(finding: dict) -> None:
    support_pct = f"{finding['support']:.0%}" if "support" in finding else ""
    denom = finding.get("completed_runs", finding.get("total_runs"))
    support_str = f" [{finding['runs_fired']}/{denom} runs, {support_pct}]" if support_pct else ""
    print(f"{finding['path']}: {finding['severity']}: {finding['message']} [{finding['rule_id']}]{support_str}")
    if finding.get("suggestion"):
        print(f"  suggestion: {finding['suggestion']}")
    if finding.get("why"):
        print(f"  why: {finding['why']}")


def print_self_check_result(result: dict) -> None:
    status = "pass" if result["passed"] else "FAIL"
    errored = f", {result['errored']} errored" if result.get("errored") else ""
    print(
        f"{status}: {result['rule_id']} test {result['test']} "
        f"{result['kind']} expected {result['expected']} "
        f"(fired {result['fired_count']}/{result['total_runs']}{errored})"
    )


def should_fail_on(findings: list[dict], fail_on: str) -> bool:
    threshold = SEVERITY_RANK.get(fail_on, 0)
    return any(SEVERITY_RANK.get(f.get("severity", ""), 0) >= threshold for f in findings)


# --- Duplicate directives ------------------------------------------------------
# Two-stage, because neither stage works alone. Lexical overlap cannot nominate
# candidates: measured across this repo's guidance, genuine duplicates score
# 33-60% word containment and legitimate cross-references score the same range,
# so no threshold separates them. Embeddings do separate them — but a cosine
# score still cannot tell "the same rule restated" from "a directive pointing at
# the skill that owns the detail", which is a distinction about intent. So the
# embedding pass only nominates pairs, cheaply and exhaustively, and the judge
# decides. Recall lives in stage one, precision in stage two.

DIRECTIVE_START = re.compile(r"^- (?:ALWAYS|NEVER):")


@dataclass(frozen=True)
class Directive:
    path: str  # repo-relative, for reporting
    text: str  # the whole top-level bullet, continuation lines included

    @property
    def summary(self) -> str:
        first = self.text.strip().splitlines()[0]
        return first[:100] + ("…" if len(first) > 100 else "")


def parse_directives(text: str, display: str) -> list[Directive]:
    """Top-level ALWAYS/NEVER bullets, each carrying its indented continuation."""
    found: list[Directive] = []
    current: list[str] = []
    for line in text.splitlines():
        if DIRECTIVE_START.match(line):
            if current:
                found.append(Directive(display, "\n".join(current)))
            current = [line]
        elif current:
            # Continuation: indented body or sub-bullet. A new top-level bullet
            # or an unindented line ends the directive.
            if line.startswith((" ", "\t")) or not line.strip():
                current.append(line)
            else:
                found.append(Directive(display, "\n".join(current)))
                current = []
    if current:
        found.append(Directive(display, "\n".join(current)))
    return [d for d in found if d.text.strip()]


async def embed_texts(texts: list[str], api_key: str, model_id: str) -> list[list[float]]:
    model = OpenAIEmbeddingModel(model_id, provider=OpenRouterProvider(api_key=api_key))
    # Carries the run's SESSION_ID like every completion does. Embeddings are the one
    # call type that used to omit it, so a run's rows split into "the session" plus a
    # few orphans — precisely when reading the dashboard to account for a run's cost.
    async with openrouter_slot():
        result = await Embedder(model).embed_documents(
            texts, settings=EmbeddingSettings(extra_body={"session_id": SESSION_ID})
        )
    return [list(vector) for vector in result.embeddings]


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    norm = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
    return dot / norm if norm else 0.0


def nominate_pairs(
    directives: list[Directive], vectors: list[list[float]], floor: float, limit: int
) -> list[tuple[float, Directive, Directive]]:
    """Cross-file pairs above the similarity floor, most similar first."""
    scored: list[tuple[float, Directive, Directive]] = []
    for i in range(len(directives)):
        for j in range(i + 1, len(directives)):
            # Same file: the author already sees both directives together.
            if directives[i].path == directives[j].path:
                continue
            score = cosine(vectors[i], vectors[j])
            if score >= floor:
                scored.append((score, directives[i], directives[j]))
    scored.sort(key=lambda row: row[0], reverse=True)
    return scored[:limit]


# --- Input discovery -----------------------------------------------------------
# One place decides WHAT gets checked; a hook's globs only decide WHEN to run. Split
# the other way — hook globs picking files, the tool re-deriving its own — and the two
# disagree silently, which is how a cross-file check ends up blind to half its corpus.

GUIDANCE_NAMES = frozenset({"AGENTS.md", "AGENTS.local.md", "AGENTS.override.md", "CLAUDE.md", "SKILL.md"})


@dataclass
class CheckInputs:
    guidance: list[Path]
    prompts: list[Path]
    targets: list[Path]  # skill dirs / guidance files that own eval cases


def scopes_for(path: Path) -> list[str]:
    """A SKILL.md is judged both as guidance and as a skill definition; everything
    else is guidance only. Inferring here keeps `--scope` out of the hook config."""
    return ["agent-guidance", "skill-definition"] if path.name == "SKILL.md" else ["agent-guidance"]


def evals_dir_for(path: Path) -> Optional[Path]:
    if path.name == "SKILL.md":
        candidate = path.parent / "evals"
    else:
        candidate = path.parent / ".evals" / path.stem.lower().replace("_", "-")
    return candidate if candidate.is_dir() else None


def discover_check_inputs(paths: list[Path]) -> CheckInputs:
    guidance: list[Path] = []
    prompts: list[Path] = []
    seen: set[str] = set()

    def add(bucket: list[Path], path: Path) -> None:
        key = str(path.resolve())  # the guide-to-guiding symlink is one skill, not two
        if key not in seen:
            seen.add(key)
            bucket.append(path)

    for raw in paths or [Path(".")]:
        root = raw.expanduser()
        candidates = [root] if root.is_file() else discover(root)
        for path in candidates:
            if path.name in GUIDANCE_NAMES:
                add(guidance, path)
            elif path.name == "prompt.md" and path.parent.parent.name == "evals":
                add(prompts, path)

    targets = [path for path in guidance if evals_dir_for(path)]
    # A skill's target is its directory, so `_load` finds SKILL.md and evals/ together.
    targets = [path.parent if path.name == "SKILL.md" else path for path in targets]
    return CheckInputs(guidance=sorted(guidance), prompts=sorted(prompts), targets=sorted(targets))


def coverage_input(display: str, directives: list[Directive], cases: list[EvalCase], scopes: list[str]) -> dict:
    """One document holding a target's directives beside every case that could cover
    them, so a single judge call can name the directives nothing exercises."""
    parts = [f"Guidance file: {display}", "", "DIRECTIVES:"]
    parts += [f"[D{index}] {item.text}" for index, item in enumerate(directives, 1)]
    parts += ["", "EVAL CASES:"]
    for case in cases:
        parts += [
            f"=== {case.name} ===",
            "task given to the model:",
            case.prompt.strip(),
            "grader:",
            read_text(case.grader).strip(),
            "",
        ]
    return {"display": display, "scopes": scopes, "text": "\n".join(parts)}


def pair_input(score: float, left: Directive, right: Directive, scopes: list[str]) -> dict:
    text = textwrap.dedent(
        f"""
        Directive A — from {left.path}:
        {left.text}

        Directive B — from {right.path}:
        {right.text}
        """
    ).strip()
    return {"display": f"{left.path} ⇔ {right.path} ({score:.2f})", "scopes": scopes, "text": text}


# --- CLI -----------------------------------------------------------------------


class OutputFormat(str, Enum):
    text = "text"
    json = "json"


class ScopeChoice(str, Enum):
    agent_guidance = "agent-guidance"
    skill_definition = "skill-definition"


class ShapeChoice(str, Enum):
    file = "file"
    directive_pair = "directive-pair"
    coverage = "coverage"
    eval_prompt = "eval-prompt"


class FailOnChoice(str, Enum):
    suggestion = "suggestion"
    warning = "warning"
    error = "error"


class LinkageChoice(str, Enum):
    average = "average"
    complete = "complete"
    single = "single"


ScopeOpt = Annotated[
    Optional[list[ScopeChoice]],
    typer.Option("--scope", help="Rule scope(s) to apply (repeatable). Default: every rule."),
]
PathsArg = Annotated[
    Optional[list[Path]],
    typer.Argument(metavar="PATHS...", help="Files, directories, or - for stdin (default: cwd)."),
]
RulesDirOpt = Annotated[
    Optional[list[Path]],
    typer.Option("--rules-dir", help="Directory of rule files (repeatable)."),
]
AgentSpecDirOpt = Annotated[
    Optional[list[Path]],
    typer.Option("--agent-spec-dir", help="Directory of agent spec files (repeatable)."),
]
RuleOpt = Annotated[
    Optional[list[str]],
    typer.Option("--rule", help="Rule id to run (repeatable)."),
]
ModelOpt = Annotated[
    str,
    typer.Option(help="OpenRouter model id (fallback when the lint agent spec has no models list)."),
]
ApiKeyOpt = Annotated[
    str,
    typer.Option("--openrouter-api-key", envvar="OPENROUTER_API_KEY"),
]
MaxCharsOpt = Annotated[int, typer.Option(help="Truncate each source to this many characters.")]
StdinNameOpt = Annotated[str, typer.Option(help="Virtual filename for stdin input.")]
FormatOpt = Annotated[OutputFormat, typer.Option("--format", help="Output format.")]
NoFailOpt = Annotated[bool, typer.Option("--no-fail", help="Always exit 0, even with findings.")]
FailOnOpt = Annotated[
    FailOnChoice,
    typer.Option("--fail-on", help="Minimum severity that causes a non-zero exit."),
]
RunsOpt = Annotated[int, typer.Option("--runs", help="Number of independent runs per model for voting.")]
SkillArg = Annotated[
    Path,
    typer.Argument(
        metavar="TARGET",
        help="Skill directory (SKILL.md + evals/) or a guidance .md file with cases in "
        ".evals/<name lowercased>/ beside it (AGENTS.md -> .evals/agents/).",
    ),
]
ConsumerOpt = Annotated[
    Optional[list[str]],
    typer.Option("--consumer", help="Consumer model id (repeatable; default: the consumer agent spec)."),
]
SimilarityOpt = Annotated[
    float,
    typer.Option("--similarity", help="Cosine floor for nominating a candidate pair."),
]
MaxPairsOpt = Annotated[int, typer.Option("--max-pairs", help="Judge at most the N most similar pairs.")]
EmbeddingModelOpt = Annotated[
    str,
    typer.Option("--embedding-model", help="OpenRouter embedding model used to shortlist pairs."),
]
NominateOnlyOpt = Annotated[
    bool,
    typer.Option("--nominate-only", help="Print the shortlist and exit, without judging it."),
]
ShowInputOpt = Annotated[
    bool,
    typer.Option("--show-input", help="Print the assembled judge input and exit, without judging it."),
]
ShapeOpt = Annotated[
    Optional[list[ShapeChoice]],
    typer.Option("--shape", help="Only run rules reading this input shape (repeatable). Default: every shape."),
]
SelfTestOpt = Annotated[
    bool,
    typer.Option("--self", help="Run the rules' own bad/good tests instead of checking the repo."),
]
NoPruneOpt = Annotated[
    bool,
    typer.Option("--no-prune", help="Keep cache entries the current corpus can no longer reach."),
]

app = typer.Typer(
    add_completion=False,
    context_settings={"auto_envvar_prefix": envvar_prefix()},
    epilog=help_notes(),
    no_args_is_help=True,
    pretty_exceptions_enable=False,
    rich_markup_mode="markdown",
    help=__doc__,
)


def _dispatch(action) -> None:
    """Run one command's body, sync or async, and own the process exit.

    The single place a loop is started. Every request in a run therefore shares one
    event loop and one HTTP client per model, which is what makes a 125-request
    ceiling cost 125 coroutines rather than 125 threads.
    """
    try:
        code = (anyio.run(action) if inspect.iscoroutinefunction(action) else action()) or 0
    except KeyboardInterrupt:
        print(f"{program_name()}: interrupted", file=sys.stderr)
        code = 130
    except Exception as error:
        print(f"{program_name()}: {error}", file=sys.stderr)
        code = 2

    # Every command exits through here, including the interrupted and aborted ones,
    # which is exactly when "what did that cost, and did the caches work?" is worth
    # asking. Silent for commands that touched neither cache.
    print_cache_summary()

    # Leave via os._exit instead of typer.Exit. This guarded a real failure under the
    # old thread-per-request shape, where a client built for one short-lived loop
    # outlived it and interpreter teardown closed it against a dead selector —
    # `ValueError: Invalid file descriptor: -1`, raised after the result had printed,
    # rewriting a certified `improve` into an apparent failure. One loop per process
    # should retire that, but the clients are now torn down by anyio's own shutdown
    # rather than ours, so this stays until a real run proves it unnecessary: an
    # unclean exit is far more expensive than an unnecessary one. Every cleanup it
    # skips (gate's temp dir, the cache commit) already ran inside `action`; only the
    # stream buffers need help, hence the explicit flush.
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(code)


def _resolve_rules(rules_dir: Optional[list[Path]], rule: Optional[list[str]]) -> list[Rule]:
    dirs = [path.expanduser() for path in rules_dir] if rules_dir else default_rule_dirs()
    loaded = load_rules(dirs, set(rule) if rule else None)
    if not loaded:
        raise ValueError(f"no rules found in {', '.join(path.as_posix() for path in dirs)}")
    return loaded


@app.command(epilog=help_notes())
def check(
    paths: PathsArg = None,
    rules_dir: RulesDirOpt = None,
    agent_spec_dir: AgentSpecDirOpt = None,
    rule: RuleOpt = None,
    shape: ShapeOpt = None,
    model: ModelOpt = DEFAULT_MODEL,
    embedding_model: EmbeddingModelOpt = DEFAULT_EMBEDDING_MODEL,
    openrouter_api_key: ApiKeyOpt = "",
    similarity: SimilarityOpt = 0.62,
    max_pairs: MaxPairsOpt = 40,
    max_chars: MaxCharsOpt = 60_000,
    self_test: SelfTestOpt = False,
    show_input: ShowInputOpt = False,
    output_format: FormatOpt = OutputFormat.text,
    no_fail: NoFailOpt = False,
    no_prune: NoPruneOpt = False,
    fail_on: FailOnOpt = FailOnChoice.suggestion,
    runs: RunsOpt = DEFAULT_RUNS,
) -> None:
    """Judge guidance against every rule: per file, across file pairs, and against eval cases.

    Every rule declares the `input:` shape it reads, and one run assembles all four:

    1. **file** — each discovered guidance document, kept only for rules whose `scope`
        matches what that path is (agent-guidance vs. skill-definition).
    2. **eval-prompt** — every `evals/*/prompt.md`; declaring the shape is what selects
        these, so `scope` does not gate them.
    3. **coverage** — per eval target, its directives beside the cases measuring them.
    4. **directive-pair** — every directive in the corpus, embedded in one paid call,
        then the `--max-pairs` closest pairs scoring at least `--similarity`.

    Rules that read the same input are asked together, in one call: a guidance file is
    judged against all of its applicable rules at once rather than once per rule, which
    stops the document being re-sent per rule and makes the shared instructions large
    enough for a provider to cache. Each batch goes to the `lint` agent `--runs` times
    per model in the spec, and the majority verdict is still counted per rule.

    Documents are judged in parallel, with no knob to set: request pacing is already
    handled by the shared rate budget and by backing off on a provider's own retry
    headers. The repeats within one document stay sequential on purpose — they are
    byte-identical requests, so the first one's cache write is what the rest read — but
    separate documents hold separate prefixes and never race. Findings are reported in
    corpus order regardless of scheduling.

    Verdicts cache in `~/.cache/llint/cache.db` keyed on the whole rule set + display
    path + model list + runs + content, so re-running unchanged files is free — but
    editing any rule in a batch changes that key and re-pays the batch's votes. Only an
    unnarrowed run sees the whole corpus, so only an unnarrowed run prunes votes no
    current batch can reach; `--rule`, `--shape`, explicit paths, or `--no-prune` all
    leave the cache untouched. Narrowing to `--rule` asks a batch of one, which is a
    different question from the full batch and so does not reuse its rows.

    Findings print worst-first and exit non-zero once one reaches `--fail-on`.
    `--show-input` dumps the assembled prompts and stops before spending anything;
    `--self` ignores the repo and runs each rule against its own `tests:` block instead.
    """

    async def action() -> int:
        loaded = _resolve_rules(rules_dir, rule)
        wanted = {item.value for item in shape} if shape else None
        active = [item for item in loaded if wanted is None or item.input in wanted]
        if not active:
            print(f"{program_name()}: no rules match the requested shapes", file=sys.stderr)
            return 2

        if self_test:
            if not openrouter_api_key:
                print(f"{program_name()}: OPENROUTER_API_KEY is required for --self", file=sys.stderr)
                return 2
            configure_agent_spec_dirs(agent_spec_dir)
            results = await run_self_check(load_agent_config("lint", model), active, openrouter_api_key, max_chars)
            return 0 if all(results) else 1

        found = discover_check_inputs(paths or [])
        # Rules that judge the SAME document are asked together, in one call: the
        # document stops being re-sent once per rule, and the shared instructions grow
        # past the size where a prompt cache will hold them. Only `file` rules ever
        # collide here — the other input shapes build a document per rule and fall out
        # as batches of one, which is what they should be.
        batches: dict[tuple[str, str], tuple[dict, list[Rule]]] = {}

        def enqueue(current_rule: Rule, document: dict) -> None:
            _, grouped = batches.setdefault((document["display"], document["text"]), (document, []))
            grouped.append(current_rule)

        for current_rule in active:
            if current_rule.input == "file":
                for path in found.guidance:
                    scopes = scopes_for(path)
                    if rule_applies(current_rule, scopes):
                        enqueue(current_rule, input_for_path(path, scopes))
            elif current_rule.input == "eval-prompt":
                # An eval prompt is not a guidance document, so `scope` does not gate it;
                # declaring the input shape is what selected this rule.
                for path in found.prompts:
                    enqueue(current_rule, input_for_path(path, []))
            elif current_rule.input == "coverage":
                for target in found.targets:
                    _, cases, text, _ = _load(target)
                    directives = parse_directives(text, target.as_posix())
                    if directives:
                        enqueue(current_rule, coverage_input(target.as_posix(), directives, cases, []))
            elif current_rule.input == "directive-pair":
                if not openrouter_api_key and not show_input:
                    print(f"{program_name()}: OPENROUTER_API_KEY is required to shortlist pairs", file=sys.stderr)
                    return 2
                directives = [
                    item for path in found.guidance for item in parse_directives(read_text(path), path.as_posix())
                ]
                if len(directives) < 2:
                    continue
                vectors = await embed_texts([item.text for item in directives], openrouter_api_key, embedding_model)
                pairs = nominate_pairs(directives, vectors, similarity, max_pairs)
                print(
                    f"  {len(directives)} directives → {len(pairs)} candidate pairs (cosine ≥ {similarity:.2f})",
                    file=sys.stderr,
                    flush=True,
                )
                for row in pairs:
                    enqueue(current_rule, pair_input(*row, []))

        if show_input:
            for document, grouped in batches.values():
                header = ", ".join(item.id for item in grouped)
                print(f"\n===== {header} :: {document['display']} =====\n{document['text']}")
            return 0
        if not openrouter_api_key:
            print(f"{program_name()}: OPENROUTER_API_KEY is required for check", file=sys.stderr)
            return 2

        configure_agent_spec_dirs(agent_spec_dir)
        config = load_agent_config("lint", model)
        # Across documents, never within one. Each document is its own cached prefix and
        # its own vote, so they do not race each other; the repeats INSIDE a batch must
        # stay sequential (see vote_rules). Results are collected in submission order so
        # the report does not reshuffle with scheduling.
        #
        # One task per document, and no width to guess: openrouter_slot bounds requests
        # in flight globally, so starting them all cannot outrun the budget — the extra
        # tasks just queue on the slot.
        per_document: list[list[dict]] = [[] for _ in batches]

        async def judge(slot: int, grouped: list[Rule], document: dict) -> None:
            per_document[slot] = await vote_rules(config, grouped, document, openrouter_api_key, runs, max_chars)

        async with anyio.create_task_group() as group:
            for slot, (document, grouped) in enumerate(batches.values()):
                group.start_soon(judge, slot, grouped, document)
        findings = [finding for batch in per_document for finding in batch]

        # Report a dead key before touching the cache: a run that could not vote has
        # no findings, and a clean "no findings" is exactly the wrong thing to tell a
        # caller who is about to trust it. Pruning here would also be sweeping on
        # behalf of a pass that never actually judged anything.
        if reason := budget_lost():
            print(
                f"\n{program_name()}: OpenRouter is refusing requests — {reason}\n"
                f"  Findings above cover only the rules that ran before it started refusing,\n"
                f"  so this is NOT a clean pass. Raise the key's limit or top up credit and\n"
                f"  re-run; votes already cast are cached.",
                file=sys.stderr,
            )
            raise typer.Exit(2)

        # Every judge entry this corpus can reach was just named by `batches`;
        # anything else is a verdict on a rule set or a file revision that no longer
        # exists. Only an unnarrowed run sees the whole corpus, so only it sweeps.
        if not (rule or shape or paths or no_prune):
            removed = prune_cache(
                {
                    _cache_key(grouped, document["display"], config.models, runs, document["text"])
                    for document, grouped in batches.values()
                }
            )
            if removed:
                print(f"  pruned {removed} unreachable judge votes", file=sys.stderr)

        if output_format is OutputFormat.json:
            print(json.dumps({"findings": findings}, indent=2))
        else:
            for finding in findings:
                print_finding(finding)
        if no_fail:
            return 0
        return 1 if should_fail_on(findings, fail_on.value) else 0

    _dispatch(action)


@app.command(epilog=help_notes())
def plan(
    paths: PathsArg = None,
    scope: ScopeOpt = None,
    rules_dir: RulesDirOpt = None,
    rule: RuleOpt = None,
    stdin_filename: StdinNameOpt = "STDIN.md",
) -> None:
    """Show which rules would run on each input, without calling the model.

    Free and offline. Resolves the rule set exactly as `check` does, then prints each
    discovered input with the scopes it was classified into and every rule matching
    those scopes. A rule that silently matches nothing shows up here rather than as a
    rule you assumed was running.
    """

    def action() -> int:
        loaded = _resolve_rules(rules_dir, rule)
        scopes = [item.value for item in scope] if scope else []
        inputs = collect_inputs(paths or [], stdin_filename, scopes)
        matched = [r.id for r in loaded if rule_applies(r, scopes)]
        for input_file in inputs:
            print(input_file["display"])
            print(f"  scopes: {', '.join(input_file['scopes']) or '-'}")
            for rule_id in matched:
                print(f"  - {rule_id}")
        return 0

    _dispatch(action)


@app.command(epilog=help_notes())
def rules(
    rules_dir: RulesDirOpt = None,
    rule: RuleOpt = None,
) -> None:
    """List the loaded rules.

    Free and offline. One tab-separated row per rule — id, severity, scopes, input
    shape, and the file it was loaded from — resolved through the same search path
    `check` uses, so this is what confirms a rule came from the directory you meant.
    """

    def action() -> int:
        loaded = _resolve_rules(rules_dir, rule)
        for current_rule in loaded:
            print(
                f"{current_rule.id}\t{current_rule.severity}\t"
                f"{', '.join(current_rule.scope)}\tinput={current_rule.input}\t{current_rule.source}"
            )
        return 0

    _dispatch(action)


# An atom that hands its rule to another guidance file is measured here with only its
# OWN file loaded, so whatever the other file teaches is invisible to the harness. A
# well-written pointer still names the concrete thing to do and stays measurable (the
# alerter pointer scored 0%->100% on 2026-07-25); one that names nothing measures inert
# and would be auto-deleted, taking the routing with it and reviving the duplicate it
# resolved. Too narrow a case to hardcode an exemption for, so drops that look like
# this get surfaced instead of applied.
#
# Placement reporting reads the same flag for the opposite reason: a pointer is SUPPOSED
# to sit closer to the file it routes to than to its own neighbours, so counting that as
# a misfiling flags the hub structure `AGENTS.md` exists to provide. Before this excluded
# them, the top six "misfiled" directives in the corpus were all pointers doing their job.
DELEGATES = re.compile(r"\b(AGENTS|CLAUDE|SKILL)\.md\b|\bowns\b|\bactivate the\b", re.IGNORECASE)


Linkage = Literal["average", "complete", "single"]
# How much closer to another file a directive must sit before its placement is worth
# questioning. Every file shares vocabulary with its neighbours, so a bare "closer
# elsewhere" fires constantly: across this corpus it flagged 25 of 106 directives at
# margin 0, versus 6 at 0.05. This output is advisory and prints on every run, so it is
# tuned for a list short enough to read rather than one exhaustive enough to skim.
MISFILED_MARGIN = 0.05
LINKAGE: dict[str, Callable[[list[float]], float]] = {
    "average": lambda scores: sum(scores) / len(scores),
    "complete": min,
    "single": max,
}


def _cluster(vectors: list[list[float]], floor: float, linkage: Linkage) -> list[list[int]]:
    """Agglomerative grouping over cosine similarity, merging until nothing clears `floor`.

    Linkage choice is the whole ballgame. Single linkage joins two groups when ANY pair
    across them is close, so one directive touching two subjects welds them together —
    on this corpus it swallowed 105 of 106 directives into a single cluster at cosine
    0.55, a result that cannot advise anyone about anything. Complete linkage is the
    default because it merges only when EVERY pair clears the floor, which is exactly
    the claim the report makes: these directives belong together.
    """
    groups = [[index] for index in range(len(vectors))]
    pairwise = {(i, j): cosine(vectors[i], vectors[j]) for i in range(len(vectors)) for j in range(i + 1, len(vectors))}
    combine = LINKAGE[linkage]

    while len(groups) > 1:
        best, merge = floor, None
        for a in range(len(groups)):
            for b in range(a + 1, len(groups)):
                score = combine([pairwise[(x, y) if x < y else (y, x)] for x in groups[a] for y in groups[b]])
                if score >= best:
                    best, merge = score, (a, b)
        if merge is None:  # nothing left clears the floor
            break
        a, b = merge
        groups[a] += groups[b]
        del groups[b]
    return sorted((group for group in groups if len(group) > 1), key=len, reverse=True)


def _misfiled(
    directives: list[Directive], vectors: list[list[float]], margin: float
) -> list[tuple[float, Directive, str, float, float]]:
    """Directives that sit closer to another file's subject matter than to their own."""
    by_file: dict[str, list[int]] = {}
    for index, directive in enumerate(directives):
        by_file.setdefault(directive.path, []).append(index)

    rows: list[tuple[float, Directive, str, float, float]] = []
    for index, directive in enumerate(directives):
        if DELEGATES.search(directive.text):
            continue  # a pointer belongs where it is, however close it sits to its target
        siblings = [other for other in by_file[directive.path] if other != index]
        if not siblings:
            continue  # a lone directive has no home topic to be off
        own = sum(cosine(vectors[index], vectors[other]) for other in siblings) / len(siblings)
        best_path, best = "", -1.0
        for path, members in by_file.items():
            if path == directive.path:
                continue
            score = sum(cosine(vectors[index], vectors[other]) for other in members) / len(members)
            if score > best:
                best_path, best = path, score
        if best_path and best > own + margin:
            rows.append((best - own, directive, best_path, own, best))
    rows.sort(key=lambda row: row[0], reverse=True)
    return rows


# constraint-density.sh's wording when a SKILL.md falls under its floor. Reaching it
# from the drop stage is not a compression failure: measurement has just said the file
# no longer carries enough behaviour to stand alone, and the floor's own remedy is to
# merge it into the skill that already owns the topic.
TOO_THIN = "too thin to be its own skill"


def _nearest_file(directives: list[Directive], vectors: list[list[float]], display: str) -> Optional[tuple[str, float]]:
    """The file whose subject matter `display`'s directives collectively sit closest to."""
    mine = [index for index, directive in enumerate(directives) if directive.path == display]
    if not mine:
        return None
    others: dict[str, list[int]] = {}
    for index, directive in enumerate(directives):
        if directive.path != display:
            others.setdefault(directive.path, []).append(index)
    best: Optional[tuple[str, float]] = None
    for path, members in others.items():
        score = sum(cosine(vectors[i], vectors[j]) for i in mine for j in members) / (len(mine) * len(members))
        if best is None or score > best[1]:
            best = (path, score)
    return best


def _organisation(
    directives: list[Directive],
    vectors: list[list[float]],
    display: str,
    floor: float,
    linkage: Linkage,
    margin: float,
) -> list[str]:
    """Where this file's directives sit in the corpus, as report lines.

    Two questions, both about placement rather than wording, so neither gates the
    result: does a topic here spill into other files (a skill waiting to be extracted),
    and does any single directive sit closer to another file's subject than its own
    (a directive waiting to be moved).
    """
    lines: list[str] = []
    for group in _cluster(vectors, floor, linkage):
        files = {directives[index].path for index in group}
        # A cluster inside one file is a well-organised section, not a finding; a
        # cluster this file has no part in belongs to some other run's report.
        if len(files) < 2 or display not in files:
            continue
        lines.append(f"  topic spanning {len(files)} files:")
        # A cluster held together only by pointers is the hub doing its job. Marking the
        # pointers costs one character and saves re-deriving that on every read.
        lines.extend(
            f"    {'→' if DELEGATES.search(directives[index].text) else ' '} "
            f"{directives[index].path}  {directives[index].summary}"
            for index in group
        )
    for _, directive, best_path, own, best in _misfiled(directives, vectors, margin):
        if directive.path == display:
            lines.append(f"  closer to {best_path} ({best:.2f}) than to this file ({own:.2f}):")
            lines.append(f"    {directive.summary}")
    return lines


@app.command(epilog=help_notes())
def improve(
    skill: SkillArg,
    consumer: ConsumerOpt = None,
    agent_spec_dir: AgentSpecDirOpt = None,
    model: ModelOpt = DEFAULT_MODEL,
    runs: RunsOpt = DEFAULT_IMPROVE_RUNS,
    baseline_runs: Annotated[int, typer.Option(help="Runs for the anchoring baseline (0 = 3x runs).")] = 0,
    floor: Annotated[
        float, typer.Option(help="Support a case must keep, absolutely — not merely relative to baseline.")
    ] = 0.5,
    proposals: Annotated[int, typer.Option(help="Rewrites requested per atom.")] = 3,
    reflector: Annotated[str, typer.Option(help="OpenRouter model proposing rewrites.")] = "anthropic/claude-opus-4.8",
    dry_run: Annotated[bool, typer.Option("--dry-run", help="Report the result without writing the file.")] = False,
    embedding_model: EmbeddingModelOpt = DEFAULT_EMBEDDING_MODEL,
    cluster_floor: Annotated[
        float, typer.Option(help="Cosine floor for merging a directive into a shared topic.")
    ] = 0.65,
    linkage: Annotated[
        LinkageChoice, typer.Option(help="How similarity is measured across a candidate merge.")
    ] = LinkageChoice.complete,
    subset_search: Annotated[
        bool, typer.Option("--subset-search", help="Search atom subsets after dropping (experimental, never landed).")
    ] = False,
    budget: Annotated[int, typer.Option(help="Subset-search metric calls (candidate x case evaluations).")] = 60,
    openrouter_api_key: ApiKeyOpt = "",
) -> None:
    """Drop what measurement cannot justify, compress what survives, certify once, then gate the result.

    Rewrites the target in place (use `--dry-run` to measure only). The most expensive
    command here: it re-measures the whole file against every eval case on every
    consumer once per directive, so cost scales with atoms x cases x consumers x runs.

    **Setup.** Measure two anchors at `--baseline-runs` (default 3x `--runs`): the
    untouched file, and the same cases with no guidance at all. Then drop any case
    whose baseline cannot clear `--floor` on a single consumer — such a case measures
    nothing, since the full text already fails it, so every candidate trivially
    "holds" it and it votes yes on any mutilation.

    **Stage 1, drop.** Only directives stand trial; a philosophy paragraph claims no
    behaviour, so ablation would score it inert and delete something the schema
    requires. Re-measure the file without each directive: any consumer that regresses
    keeps it (union — a wrong drop costs a capability on some model). A directive that
    nothing misses but that routes to another file is deferred, not dropped, since its
    own file cannot teach what the file it points at teaches.

    **Stage 1b, subset search** (`--subset-search`, off by default). Searches whole
    atom subsets against per-case floors instead of removing one atom at a time. It
    has never run outside development and considers only the first consumer, so it
    stays opt-in until a real run says whether it beats the greedy pass.

    **Stage 2, compress.** For each survivor the reflector proposes `--proposals`
    rewrites; accept the shortest that passes the deterministic lanes and holds on
    EVERY consumer (intersection — a missed compression costs only bytes). Verification
    is greedy-cumulative, each atom judged with all prior acceptances already in place.

    **Stage 3, certify.** Gate the assembled result, then re-measure it at baseline
    strength; every consumer must hold both relatively (no worse than baseline) and
    absolutely (still above `--floor` where it started above it). This is also where
    each case reports the verdict the old `eval` subcommand printed — its with-guidance
    arm against the no-guidance anchor, pooled across consumers and weighted by
    completed runs, as `redundant` / `effective` / `ineffective`. Two ways to stop
    here without writing: a regression, or a result so thin it breaks the density floor
    — the latter reports a MERGE SIGNAL naming the closest existing home by subject
    matter, because the measurement means this skill has no standalone content, not
    that the run failed. Placement clustering prints after certification and is purely
    advisory: no eval case beside one skill can settle where a directive belongs.

    **Stage 4, re-lint.** After writing, re-run the `file`-shape judge rules against
    what landed and exit non-zero on any finding — the producer must not hand back
    what `check` would reject.
    """

    async def action() -> int:
        if not openrouter_api_key:
            print(f"{program_name()}: OPENROUTER_API_KEY is required for improve", file=sys.stderr)
            return 2
        configure_agent_spec_dirs(agent_spec_dir)
        consumer_config = load_agent_config("consumer", model)
        consumers = consumer or consumer_config.models
        parsed, cases, _, agents_mode = _load(skill)
        if not cases:
            print(f"{program_name()}: no eval cases beside {skill}; nothing to measure against", file=sys.stderr)
            return 2

        target = skill / "SKILL.md" if skill.is_dir() else skill
        target_key = target.resolve()
        instructions = consumer_config.instructions or BASE_CONSUMER_INSTRUCTIONS
        context = deployed_context(consumer_config.context, target)
        if context:
            print(f"  deployed context: {len(context.encode())}B ahead of the skill text", file=sys.stderr)

        async def measure(text: str, n: int) -> dict[str, dict[str, tuple[Optional[float], int]]]:
            """{consumer: {case: (support, completed runs)}} for one candidate text. The
            completed count only matters to the verdict, which weights by it; every
            keep/accept decision reads `supports` below and never sees it."""
            out: dict[str, dict[str, tuple[Optional[float], int]]] = {name: {} for name in consumers}
            # Barrier before the grid: every batch below shares this one system prompt,
            # and they would otherwise all miss it at once. Only consumers with cold
            # work are warmed, so a resumed run pays nothing here.
            cold = [
                name
                for name in consumers
                if any(not consumer_plans_cached(name, text, case.prompt, n, instructions, context) for case in cases)
            ]
            await warm_consumers(cold, consumer_system(text, instructions, context), openrouter_api_key)

            async def one(name: str, case: EvalCase) -> None:
                out[name][case.name] = await graded_support(
                    name, text, case.prompt, case.grader, n, openrouter_api_key, instructions, context
                )

            # Every cell started at once, with no width to pick: openrouter_slot is what
            # decides how many are actually open, so a task waiting on it costs a
            # coroutine rather than a thread. Writes land in distinct dict slots, so
            # completion order does not matter.
            async with anyio.create_task_group() as group:
                for name in consumers:
                    for case in cases:
                        group.start_soon(one, name, case)
            # Every later stage compares against these numbers, so continuing past a
            # dead key does not degrade the result, it invents one: unmeasurable
            # candidates read as regressions, so stage 1 keeps every directive and
            # stage 2 accepts no rewrite. Stop while the cache still holds real work.
            if reason := budget_lost():
                print(
                    f"\n{program_name()}: OpenRouter is refusing requests — {reason}\n"
                    f"  Usually a spend cap rather than a broken key: raise the key's limit or\n"
                    f"  top up credit, then run the identical command again. Every measurement\n"
                    f"  taken before this point is cached and will not be paid for twice.",
                    file=sys.stderr,
                )
                raise typer.Exit(2)
            return out

        def support_only(
            measured: dict[str, dict[str, tuple[Optional[float], int]]],
        ) -> dict[str, dict[str, Optional[float]]]:
            return {name: {case: value for case, (value, _) in row.items()} for name, row in measured.items()}

        async def supports(text: str, n: int) -> dict[str, dict[str, Optional[float]]]:
            """{consumer: {case: support}} for one candidate text."""
            return support_only(await measure(text, n))

        baseline_n = baseline_runs or 3 * runs
        margin = 1.0 / runs
        all_ids = set(parsed.atoms)
        full_text = parsed.render(all_ids)

        print(
            f"{len(parsed.atoms)} atoms x {len(cases)} cases x {len(consumers)} consumers "
            f"(n={runs}, baseline n={baseline_n})",
            file=sys.stderr,
        )
        baseline = support_only(await measure(full_text, baseline_n))
        # The without-guidance arm, folded in from the former `eval` subcommand. It is
        # what separates "this directive is doing work" from "the consumer already knew
        # this", and it is the only arm that can tell a case measuring the file apart
        # from one measuring the model's priors. Passing "" rather than the empty shell
        # keeps eval's exact semantics: bare headings still hint at the subject.
        without_measured = await measure("", baseline_n)

        # A case whose baseline cannot clear the floor measures nothing: the full text
        # already fails it, so EVERY candidate "holds" it and it votes yes on any
        # mutilation. Certifying on relative movement alone let a 1-run smoke drop four
        # atoms, watch three cases sit at 0%, and still print "certified".
        live = {case.name for case in cases if any((baseline[name][case.name] or 0.0) >= floor for name in consumers)}
        for case in cases:
            if case.name not in live:
                print(f"  !! {case.name}: baseline below {floor:.0%} on every consumer — excluded", file=sys.stderr)
        if not live:
            print(f"{program_name()}: no case clears the floor at baseline; nothing to certify", file=sys.stderr)
            return 2

        def holds_everywhere(candidate: dict[str, dict[str, Optional[float]]]) -> bool:
            """Relative (no worse than baseline) AND absolute (still clears the floor
            on the consumer that cleared it before). Either alone is gameable."""
            for name in consumers:
                if not holds_baseline(
                    {case: value for case, value in candidate[name].items() if case in live},
                    baseline[name],
                    margin,
                ):
                    return False
                for case_name in live:
                    if (baseline[name][case_name] or 0.0) >= floor and (candidate[name][case_name] or 0.0) < floor:
                        return False
            return True

        # --- Stage 1: drop what no consumer misses -------------------------------
        # Only directives are on trial. Ablation values an atom by the behaviour change
        # its absence causes, so anything that does not claim to change behaviour —
        # the philosophy paragraph above all — measures inert by construction and would
        # be deleted for failing a test it was never taking. That paragraph is also
        # required by guide-to-guiding and by .mdschema-skill.yml, and dropping the last
        # atom in a section takes the heading with it, so the "measurement" would have
        # produced a file the repo's own schema rejects.
        keep, dropped, deferred = set(all_ids), [], []
        candidates = {aid: atom for aid, atom in parsed.atoms.items() if DIRECTIVE_START.match(atom.text.lstrip())}
        skipped = len(parsed.atoms) - len(candidates)
        if skipped:
            print(f"  {skipped} non-directive atom(s) held: not behavioural claims, so not ablatable", flush=True)
        for atom_id, atom in candidates.items():
            without = await supports(parsed.render(all_ids - {atom_id}), runs)
            needed_by = [name for name in consumers if not holds_baseline(without[name], baseline[name], margin)]
            if needed_by:
                print(
                    f"  keep  {atom_id:>5}  needed by {len(needed_by)}/{len(consumers)}  | {atom.summary}", flush=True
                )
            elif DELEGATES.search(atom.text):
                deferred.append(atom_id)
                print(f"  DEFER {atom_id:>5}  inert, but routes to another file  | {atom.summary}", flush=True)
            else:
                keep.discard(atom_id)
                dropped.append(atom_id)
                print(f"  drop  {atom_id:>5}  no consumer misses it  | {atom.summary}", flush=True)

        # --- Stage 1b: subset search over the survivors (opt-in, see _subset_search) ---
        if subset_search:
            print(f"\nsubset search over {len(keep)} survivors, {consumers[0]} only:")
            chosen = await _subset_search(
                parsed,
                [case for case in cases if case.name in live],
                keep,
                consumers[0],
                runs,
                baseline_n,
                budget,
                reflector,
                openrouter_api_key,
                agents_mode,
                context,
            )
            if chosen is not None:
                # Non-directive atoms were never on trial in stage 1 and are not on trial
                # here. The gate would reject dropping them anyway, but a search that only
                # ever proposes legal candidates wastes none of its budget discovering that.
                keep = chosen | {atom_id for atom_id in keep if atom_id not in candidates}
                dropped = [atom_id for atom_id in candidates if atom_id not in keep]

        # --- Stage 2: compress the survivors, greedy-cumulative -------------------
        reflect = make_reflector(reflector, openrouter_api_key)
        accepted: dict[str, str] = {}
        for atom_id in [item for item in parsed.atoms if item in keep]:
            atom = parsed.atoms[atom_id]
            original = atom.text.strip()
            orig_bytes = len(original.encode())
            proposed = await reflect(REWRITE_PROMPT.format(k=proposals, block=original))
            variants = sorted(
                {
                    variant.strip()
                    for variant in re.split(r"^---$", proposed, flags=re.M)
                    if variant.strip() and len(variant.strip().encode()) < orig_bytes
                },
                key=lambda variant: len(variant.encode()),
            )
            for variant in variants:
                rendered = render_override(parsed, {**accepted, atom_id: variant}, keep)
                if gate(rendered, agents_mode) is not None:
                    continue
                if holds_everywhere(await supports(rendered, runs)):
                    accepted[atom_id] = variant + "\n"
                    saved = 1 - len(variant.encode()) / orig_bytes
                    print(f"  {atom_id:>5} {orig_bytes:>5}B -> {len(variant.encode()):>5}B (-{saved:.0%})")
                    break

        # --- Stage 3: certify the whole result once, at baseline strength --------
        final_text = render_override(parsed, accepted, keep)

        async def placement() -> Optional[tuple[str, list[Directive], list[list[float]]]]:
            """Embed the whole guidance corpus, with the candidate standing in for the
            target so placement is judged on what this run actually produced."""
            corpus = [
                (path.as_posix(), final_text if path.resolve() == target_key else read_text(path))
                for path in discover_check_inputs([Path(".")]).guidance
            ]
            display = next((name for name, _ in corpus if Path(name).resolve() == target_key), target.as_posix())
            found = [item for name, body in corpus for item in parse_directives(body, name)]
            if len(found) < 2:
                return None
            return display, found, await embed_texts([item.text for item in found], openrouter_api_key, embedding_model)

        # Compression candidates are gated one at a time, but nothing gated the result
        # of the DROP stage — and a drop can break the file's required shape without
        # touching a single byte of the atoms that remain.
        shape_failure = gate(final_text, agents_mode)
        if shape_failure is not None:
            if TOO_THIN not in shape_failure:
                print(f"{program_name()}: result fails the deterministic lanes:\n{shape_failure}", file=sys.stderr)
                return 1
            # Not a failure to report as one: every consumer got by without these
            # directives, and what remains is too thin to be its own skill. Forcing a
            # legal file would mean restoring directives measurement just called dead
            # weight, so say what the measurement actually means and name a home.
            survivors = sum(1 for atom_id in keep if DIRECTIVE_START.match(parsed.atoms[atom_id].text.lstrip()))
            print(
                f"\nMERGE SIGNAL: {len(dropped)} of {len(candidates)} directives measured inert, "
                f"leaving {survivors} — under the floor for a standalone skill."
            )
            spot = await placement()
            if spot is not None:
                nearest = _nearest_file(spot[1], spot[2], spot[0])
                if nearest is not None:
                    print(f"  closest existing home by subject matter: {nearest[0]} (cosine {nearest[1]:.2f})")
            for atom_id in keep:
                if DIRECTIVE_START.match(parsed.atoms[atom_id].text.lstrip()):
                    print(f"  survivor {atom_id}  {parsed.atoms[atom_id].summary}")
            print("  Fold the survivors into the owning skill, or give this one the directives it lacks.")
            return 1
        final_measured = await measure(final_text, baseline_n)
        final = support_only(final_measured)
        certified = holds_everywhere(final)
        full_bytes, final_bytes = len(full_text.encode()), len(final_text.encode())
        print(
            f"\n{len(dropped)} dropped, {len(deferred)} deferred, {len(accepted)}/{len(keep)} compressed: "
            f"{full_bytes}B -> {final_bytes}B (-{1 - final_bytes / full_bytes:.0%})"
        )
        for name in consumers:
            print(f"  {name}: " + " ".join(f"{case}:{_pct(value)}" for case, value in final[name].items()))

        # The verdict `eval` used to print, now reported per case against the text this
        # run actually produced. `ineffective` is the one to act on: it means neither arm
        # cleared the floor, which is almost always a grader demanding one exact phrasing
        # rather than a skill that fails to teach.
        print("\nper case, pooled across consumers:")
        for case in cases:
            without, without_n = _pooled_support(without_measured[name][case.name] for name in consumers)
            with_support, with_n = _pooled_support(final_measured[name][case.name] for name in consumers)
            verdict = "error" if not without_n or not with_n else eval_verdict(without, with_support)
            note = "" if case.name in live else "  (excluded: baseline under floor)"
            print(f"  {case.name}: without {_pct(without)} -> with {_pct(with_support)}  {verdict}{note}")
        if not certified:
            print("REGRESSED against baseline on at least one consumer — not writing", file=sys.stderr)
            return 1
        print("certified: every consumer holds its baseline")
        if deferred:
            print("\ndeferred (inert here, but they route elsewhere — decide by hand):")
            for atom_id in deferred:
                print(f"  {atom_id}  {parsed.atoms[atom_id].summary}")
        # --- Placement: advisory, and read against the CERTIFIED text ---------------
        # Ablation asks whether each directive earns its keep in this file; clustering
        # asks whether this file is the right home at all. Nothing here gates the write:
        # moving a directive is a judgement about the whole corpus, and no eval case
        # sitting beside one skill is entitled to make it.
        spot = await placement()
        if spot is not None:
            display, directives, vectors = spot
            report = _organisation(directives, vectors, display, cluster_floor, linkage.value, MISFILED_MARGIN)
            print(
                f"\nplacement across {len(directives)} directives "
                f"({linkage.value} linkage, cosine ≥ {cluster_floor:.2f}) — advisory:"
            )
            print("\n".join(report) if report else "  nothing to move")

        if dry_run:
            return 0

        target.write_text(final_text, encoding="utf-8")
        print(f"wrote {target}")

        # --- Stage 4: the producer must not hand back what the gate rejects ------
        scopes = scopes_for(target)
        lint_config = load_agent_config("lint", model)
        # One batched call, matching what `check` would ask of this file — a stage-4
        # verdict that disagreed with the gate would be worse than no verdict at all.
        gate_rules = [
            current_rule
            for current_rule in _resolve_rules(None, None)
            if current_rule.input == "file" and rule_applies(current_rule, scopes)
        ]
        findings = await vote_rules(
            lint_config, gate_rules, input_for_path(target, scopes), openrouter_api_key, DEFAULT_RUNS, 60_000
        )
        for finding in findings:
            print_finding(finding)
        return 1 if findings else 0

    _dispatch(action)


@app.command(epilog=help_notes())
def atoms(skill: SkillArg) -> None:
    """List the keepable atoms parsed from a guidance file (verify parsing before spending).

    Free and offline. An atom is the granularity every measurement works at — the
    philosophy paragraph, then one per directive — because `improve` can only keep,
    drop, or rewrite whole atoms. This also re-renders the parse and reports whether
    the round-trip is lossless; a LOSSY result means `improve` would rewrite parts of
    the file it never measured, so fix that before spending anything on it.
    """

    def action() -> int:
        parsed, _, original, _ = _load(skill)
        for heading, ids in parsed.sections:
            print(heading)
            for atom_id in ids:
                print(f"  {atom_id}  {parsed.atoms[atom_id].summary}")
        rendered = parsed.render(set(parsed.atoms))
        status = "lossless" if rendered.strip() == original.strip() else "LOSSY (render differs from original)"
        print(f"\n{len(parsed.atoms)} atoms; full render is {status}")
        return 0

    _dispatch(action)


# TODO: decide where subset search really belongs. It overlaps the drop stage rather
#       than slotting in behind it: drop removes one atom at a time and keeps whatever
#       ANY consumer misses, while this searches whole subsets against per-case floors
#       for ONE consumer. Either could own selection — drop could seed the search, or
#       the search could replace drop outright — and nothing has run long enough to
#       say which. Off by default until something does.
async def _subset_search(
    parsed: Skill,
    cases: list[EvalCase],
    keep: set[str],
    consumer: str,
    runs: int,
    baseline_n: int,
    budget: int,
    reflector: str,
    openrouter_api_key: str,
    agents_mode: bool,
    context: str = "",
) -> Optional[set[str]]:
    """GEPA subset selection: the smallest atom set still holding every per-case floor,
    searched over what the drop stage left. Verbatim port of the former `compile`
    subcommand, which never ran outside development.

    The one place this tool runs work off the event loop. `optimize_anything` is a
    synchronous driver that owns its own worker threads and calls back in, so it cannot
    be awaited; it runs in a thread and its callbacks re-enter the loop through a
    portal. Doing it the other way — letting the search open its own clients — would
    give subset search a second request stack outside the rate budget and the in-flight
    ceiling, which is the duplication consolidating these lanes removed.
    """

    import gepa.optimize_anything as oa
    from gepa.optimize_anything import EngineConfig, GEPAConfig, ReflectionConfig, optimize_anything

    all_ids = [atom_id for atom_id in parsed.atoms if atom_id in keep]
    full_text = parsed.render(set(all_ids))
    full_bytes = len(full_text.encode())
    render_cache: dict[frozenset, tuple[str, Optional[str]]] = {}

    # Noise policy: per-case floors anchored to a high-n full-text baseline. A
    # candidate below floor on ANY case scores 0 on that case, so GEPA cannot
    # trade a real per-case drop away inside an aggregate tie. `baseline_n` arrives
    # from the caller so this shares improve's anchor rather than re-deriving one.
    baseline: dict[str, Optional[float]] = {}

    async def measure_case(case: EvalCase) -> None:
        baseline[case.name] = await case_support(
            consumer, full_text, case, baseline_n, openrouter_api_key, context=context
        )

    async with anyio.create_task_group() as group:
        for case in cases:
            group.start_soon(measure_case, case)
    floor = {name: (None if value is None else value - 1.0 / runs) for name, value in baseline.items()}
    print(f"baseline (n={baseline_n}): " + " ".join(f"{name}:{_pct(value)}" for name, value in baseline.items()))

    def realize(keep_csv: str) -> tuple[Optional[set[str]], str, Optional[str]]:
        ids = {t.strip() for t in keep_csv.replace("\n", ",").split(",") if t.strip()}
        unknown = ids - set(all_ids)
        if unknown:
            return None, "", f"unknown atom ids: {', '.join(sorted(unknown))}; valid ids: {', '.join(all_ids)}"
        key = frozenset(ids)
        if key not in render_cache:
            rendered = parsed.render(ids)
            render_cache[key] = (rendered, gate(rendered, agents_mode))
        rendered, gate_failure = render_cache[key]
        return ids, rendered, gate_failure

    # Bound to the portal below before GEPA is started; every callback runs on GEPA's
    # threads and reaches the loop through it.
    portal: anyio.from_thread.BlockingPortal

    def support_via_portal(text: str, case: EvalCase, n: int) -> Optional[float]:
        return portal.call(partial(case_support, consumer, text, case, n, openrouter_api_key, context=context))

    def evaluator(candidate: str, example: EvalCase):
        ids, rendered, problem = realize(candidate)
        if ids is None or problem is not None:
            return 0.0, {"Error": problem, "scores": {"support": 0.0, "brevity": 0.0}}
        support = support_via_portal(rendered, example, runs)
        brevity = 1.0 - (len(rendered.encode()) / full_bytes)
        case_floor = floor[example.name]
        if support is None:
            # Unmeasurable under this candidate: score at the floor (neutral) so
            # flaky cases neither reward nor punish, and never decide selection.
            support = case_floor if case_floor is not None else 0.0
        elif case_floor is not None and support < case_floor - 1e-9:
            oa.log(f"keep={len(ids)}/{len(all_ids)} atoms, case={example.name}, support={support:.0%} BELOW FLOOR")
            return 0.0, {
                "Error": f"support {support:.0%} fell below the per-case floor {case_floor:.0%} for {example.name}",
                "scores": {"support": support, "brevity": round(brevity, 3)},
                "Kept atom ids": ", ".join(sorted(ids)),
            }
        oa.log(f"keep={len(ids)}/{len(all_ids)} atoms, case={example.name}, support={support:.0%}")
        # Brevity epsilon breaks score ties in favor of shorter candidates while
        # staying far below one support step (1/runs), so support always wins.
        return support + 0.01 * brevity, {
            "scores": {"support": support, "brevity": round(brevity, 3)},
            "Kept atom ids": ", ".join(sorted(ids)),
        }

    catalog = "\n".join(f"- {atom_id}: {parsed.atoms[atom_id].summary}" for atom_id in all_ids)

    def search(reflect):
        return optimize_anything(
            seed_candidate=", ".join(all_ids),
            evaluator=evaluator,
            dataset=cases,
            objective=(
                "The candidate is a comma-separated list of directive-atom IDs to KEEP in an agent skill file. "
                "Maximize eval support (primary) while keeping as few atoms as possible (secondary). "
                "Equal-support shorter subsets score strictly higher, so actively probe removals — "
                "single atoms rarely matter alone; try dropping groups of plausibly-overlapping atoms."
            ),
            background=(
                "Valid atom IDs and their first lines:\n"
                + catalog
                + "\nRules: output ONLY a comma-separated subset of these IDs. Never invent IDs. "
                "The rendered file must still pass structural lint gates (dropping `phil` or an entire "
                "required section fails the gate and scores 0)."
            ),
            config=GEPAConfig(
                engine=EngineConfig(
                    max_metric_calls=budget,
                    parallel=True,
                    max_workers=4,
                    cache_evaluation=True,
                    raise_on_exception=False,
                ),
                reflection=ReflectionConfig(reflection_lm=reflect, reflection_prompt_template=None),
            ),
        )

    # GEPA drives the whole search synchronously and fans out over its own threads, so
    # it runs off the loop while `portal` carries every request back onto it.
    async with anyio.from_thread.BlockingPortal() as open_portal:
        portal = open_portal
        result = await anyio.to_thread.run_sync(
            search, sync_reflector(make_reflector(reflector, openrouter_api_key), portal)
        )

    # Selection ignores aggregate scores: the smallest candidate that holds every
    # per-case floor wins (GEPA subsamples cases, so aggregates are not comparable
    # anyway). Certification measures at baseline_n on samples the optimizer never
    # selected on. Short-circuits on the first breached case; falls back to the seed.
    def passes_floors(csv: str) -> bool:
        ids, rendered, gate_failure = realize(csv)
        if ids is None or gate_failure is not None:
            return False
        for case in cases:
            case_floor = floor[case.name]
            if case_floor is None:
                continue
            support = support_via_portal(rendered, case, baseline_n)
            if support is None or support < case_floor - 1e-9:
                print(f"certification: {{{csv}}} fails {case.name} ({_pct(support)} < floor {case_floor:.0%})")
                return False
        return True

    ranked = sorted((_candidate_bytes(parsed, candidate), i) for i, candidate in enumerate(result.candidates))
    chosen_idx = next((i for _, i in ranked if passes_floors(_candidate_text(result.candidates[i]))), 0)
    chosen_csv = _candidate_text(result.candidates[chosen_idx])
    ids, rendered, _ = realize(chosen_csv)

    print(
        f"seed score={result.val_aggregate_scores[0]:.2f}; best score={max(result.val_aggregate_scores):.2f}; "
        f"explored {len(result.candidates)} candidates"
    )
    print(
        f"chosen: {len(ids or [])}/{len(all_ids)} atoms, "
        f"{len(rendered.encode())}/{full_bytes} bytes "
        f"({'holds every per-case floor' if chosen_idx != 0 else 'seed — no smaller candidate held the floors'})"
    )
    dropped = [a for a in all_ids if ids is not None and a not in ids]
    for atom_id in dropped:
        print(f"  would drop {atom_id}: {parsed.atoms[atom_id].summary}")
    return ids


if __name__ == "__main__":
    app(prog_name=",llint")
