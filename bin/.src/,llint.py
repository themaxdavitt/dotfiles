#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.14"
# dependencies = [
#   "pydantic",
#   "pydantic-ai-slim[openrouter,retries,spec]",
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
import json
import os
import re
import subprocess
import sys
import textwrap
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import Enum
from pathlib import Path
from statistics import mode as stat_mode
from typing import Annotated, Literal, Optional, TypeVar, cast

import frontmatter
import httpx
import typer
import yaml
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
)
from pydantic_ai import Agent
from pydantic_ai.models.openrouter import OpenRouterModel, OpenRouterModelSettings
from pydantic_ai.output import OutputSpec
from pydantic_ai.profiles import InlineDefsJsonSchemaTransformer, ModelProfile, merge_profile
from pydantic_ai.providers.openrouter import OpenRouterProvider
from pydantic_ai.retries import AsyncTenacityTransport, RetryConfig, wait_retry_after
from tenacity import retry_if_exception, stop_after_attempt, wait_exponential


DEFAULT_MODEL = "z-ai/glm-5.2"
DEFAULT_RUNS = 3
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
        ### Configuration

        - Rules: `.{name}/rules`, `~/.config/dotfiles/{name}/rules`

        - Agent specs: `.{name}/agents`, `~/.config/dotfiles/{name}/agents`

        - Passing `--rules-dir` or `--agent-spec-dir` replaces that default search path.

        ### Rule Files

        - Rules are Markdown `.md` files with YAML frontmatter.

        - Required frontmatter: `id`, `title`, `severity`, `scope`, `why`, `tests`.

        - The Markdown body is the check description.

        - Optional frontmatter: `llm.reasoning_effort`.

        ### Agent Spec Files

        - YAML files with `models` (list) or `model` (string), optional
          `instructions` and `retries`.

        - The `lint` agent is used for text-judgment linting (multi-model voting).

        - The `consumer` agent is used for behavioral eval ablation runs.

        ### Suppressions

        - Whole file: `<!-- {name}-disable-file all -->`

        - Rule id anywhere in file: `<!-- {name}-disable-file rule/id another/rule -->`

        ### Skill Evals (Behavioral Ablation)

        - Run: `{name} eval <skill-dir>` where `<skill-dir>` contains `SKILL.md` and `evals/`,
          or `{name} eval <guidance.md>` with cases in `.evals/<name lowercased>/` beside it
          (override with `--evals-dir`).

        - Each eval case: `evals/<case>/prompt.md` + `evals/<case>/grade.sh`.

        - `grade.sh` reads the consumer's plan on stdin; exit 0 = insight present.

        - Verdicts: `redundant` (model already has insight), `effective` (skill adds it),
          `ineffective` (guidance not landing in either condition).
        """
    ).strip()


# --- Prompts -------------------------------------------------------------------

SYSTEM_PROMPT = (
    "You are a precise agent-guidance lint rule evaluator. Return findings that match "
    "the structured output schema. Only report violations you are confident about; "
    "prefer false negatives over speculative or noisy findings."
)
TASK_PROMPT = """
Evaluate one Markdown file against one lint rule.

Return an empty findings array when there are no clear violations. Report at
most 10 findings. Prefer false negatives over noisy or speculative findings.
""".strip()


# --- Rule schema ---------------------------------------------------------------

NonEmptyStr = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
Severity = Literal["suggestion", "warning", "error"]
Scope = Literal["agent-guidance", "skill-definition", "multi-agent", "all"]
ReasoningEffort = Literal["none", "minimal", "low", "medium", "high", "xhigh"]


class RuleTest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    bad: str
    good: str


class LlmConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reasoning_effort: Optional[ReasoningEffort] = None


class Rule(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: NonEmptyStr
    title: NonEmptyStr
    severity: Severity
    scope: list[Scope]
    why: NonEmptyStr
    check: NonEmptyStr
    llm: LlmConfig = Field(default_factory=LlmConfig)
    tests: Annotated[list[RuleTest], Field(min_length=1)]
    source: str

    @property
    def reasoning_effort(self) -> Optional[ReasoningEffort]:
        return self.llm.reasoning_effort

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


# --- Agent config loading ------------------------------------------------------
# Extends the bare YAML agent spec with multi-model support.
# Supports both new format (models: [...]) and old format (model: ...).


@dataclass
class LlintAgentConfig:
    models: list[str]
    instructions: Optional[str] = None
    retries: int = 2


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
    """Load raw agent YAML without pydantic-ai's schema restrictions."""
    for directory in AGENT_SPEC_DIRS:
        for suffix in (".yaml", ".yml", ".json"):
            path = directory / f"{name}{suffix}"
            if path.is_file():
                return yaml.safe_load(path.read_text(encoding="utf-8"))
    return None


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
    )


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


def truncated_source(text: str, max_chars: int, rule: Optional[Rule] = None) -> tuple[str, bool]:
    """Return (text, was_truncated). Warn if a position-sensitive rule is affected."""
    if len(text) <= max_chars:
        return text, False
    truncated = text[:max_chars] + "\n[file truncated for review]"
    if rule and rule.id in {"guidance/front-load-critical"}:
        print(
            f"{program_name()}: warning: file truncated at {max_chars} chars; "
            f"position-sensitive rule {rule.id!r} may miss buried directives",
            file=sys.stderr,
        )
    return truncated, True


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


def source_prompt(input_file: dict, max_chars: int, rule: Optional[Rule] = None) -> str:
    text, _ = truncated_source(input_file["text"], max_chars, rule)
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


def lint_prompt(rule: Rule, input_file: dict, max_chars: int, exclude_test_index: Optional[int] = None) -> str:
    return "\n\n".join([TASK_PROMPT, rule_prompt(rule, exclude_test_index), source_prompt(input_file, max_chars, rule)])


# --- HTTP and model building ---------------------------------------------------

OPENROUTER_RETRY_STATUS_CODES = {408, 429, 502, 503, 504}
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
            wait=wait_retry_after(
                fallback_strategy=wait_exponential(multiplier=2, max=30),
                max_wait=float("inf"),
            ),
            stop=stop_after_attempt(OPENROUTER_SIMPLE_RETRY_ATTEMPTS),
            reraise=True,
        ),
        validate_response=raise_retryable_status,
    )
    return httpx.AsyncClient(transport=transport)


def build_model(model_id: str, api_key: str) -> OpenRouterModel:
    provider = OpenRouterProvider(api_key=api_key, http_client=retrying_http_client())
    # Inline nested $ref/$defs so every OpenRouter provider gets a self-contained schema.
    profile_override: ModelProfile = {"json_schema_transformer": InlineDefsJsonSchemaTransformer}
    profile = merge_profile(provider.model_profile(model_id), profile_override)
    return OpenRouterModel(model_id, provider=provider, profile=profile)


# One id per invocation: OpenRouter uses it as the sticky-routing key (same
# provider within a session helps cache hits) and it filters the activity
# dashboard when debugging.
SESSION_ID = f"llint-{datetime.now(UTC):%Y%m%dT%H%M%SZ}-{os.getpid()}"


def model_settings(reasoning_effort: Optional[ReasoningEffort]) -> OpenRouterModelSettings:
    # No sampling params: closed-weight frontier models increasingly reject
    # them outright, real harnesses mostly run defaults, and run-to-run
    # diversity for voting/ablation comes from provider defaults just fine.
    settings: OpenRouterModelSettings = {
        "openrouter_provider": {"require_parameters": True},
        # OpenRouter's automatic prompt caching (Anthropic needs an explicit
        # opt-in; other providers cache automatically and ignore this). Only
        # prefixes over the model's minimum (4096 tokens on Opus/Haiku 4.5)
        # actually cache, so small prompts are unaffected either way.
        "extra_body": {"cache_control": {"type": "ephemeral"}, "session_id": SESSION_ID},
    }
    if reasoning_effort is not None:
        settings["openrouter_reasoning"] = {"effort": reasoning_effort}
    return settings


def make_lint_agent(
    llm: OpenRouterModel, config: LlintAgentConfig, output_type: OutputSpec[OutputT]
) -> Agent[object, OutputT]:
    instructions = config.instructions or SYSTEM_PROMPT
    return cast(
        Agent[object, OutputT],
        Agent(llm, output_type=output_type, instructions=instructions, retries=config.retries),
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


# --- Cache ---------------------------------------------------------------------


CACHE_DIR = Path.home() / ".cache" / "llint"

_CACHE_MISS = object()


def _cache_key(rule: Rule, file_display: str, model_list: list[str], runs: int, content: str) -> str:
    # The rule's full definition (check text, tests, reasoning effort) shapes the
    # prompt, so editing a rule must invalidate its cached votes.
    data = json.dumps(
        {
            "rule": rule.model_dump_json(),
            "file": file_display,
            "models": sorted(model_list),
            "runs": runs,
            "content": content,
        },
        sort_keys=True,
    )
    return hashlib.sha256(data.encode()).hexdigest()


def cache_get(key: str) -> object:
    path = CACHE_DIR / f"{key}.json"
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return _CACHE_MISS


def cache_set(key: str, value: Optional[dict]) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = CACHE_DIR / f"{key}.json"
    try:
        path.write_text(json.dumps({"result": value}), encoding="utf-8")
    except OSError:
        pass  # cache write failure is non-fatal


# --- Voting engine ------------------------------------------------------------
# For each (rule, file): run N times per model; keep if ≥ 50% of total runs
# return at least one finding. Confidence = recurrence fraction.
# Findings are per (rule, file) — no quote, no line number.


def _run_single(
    llm: OpenRouterModel,
    agent: Agent[object, LintResult],
    rule: Rule,
    input_file: dict,
    max_chars: int,
) -> LintResult:
    prompt = lint_prompt(rule, input_file, max_chars)
    result = agent.run_sync(prompt, model_settings=model_settings(rule.reasoning_effort))
    return result.output  # type: ignore[return-value]


def vote_rule(
    config: LlintAgentConfig,
    rule: Rule,
    input_file: dict,
    api_key: str,
    runs: int,
    max_chars: int,
    use_cache: bool = True,
) -> Optional[dict]:
    """Run N×models, vote on whether rule fires. Returns finding dict or None."""
    if suppressed_by_file(input_file["text"], rule.id):
        return None

    if use_cache:
        key = _cache_key(rule, input_file["display"], config.models, runs, input_file["text"])
        cached = cache_get(key)
        if cached is not _CACHE_MISS:
            return cast(dict, cast(dict, cached).get("result"))  # type: ignore[return-value]

    total = len(config.models) * runs
    finding_runs = 0
    completed_runs = 0
    all_messages: list[str] = []
    all_suggestions: list[str] = []

    print(f"  {rule.id}  {input_file['display']}", file=sys.stderr, flush=True)
    for model_id in config.models:
        llm = build_model(model_id, api_key)
        agent = make_lint_agent(llm, config, LintResult)
        for i_run in range(runs):
            print(f"    {model_id}  [{i_run + 1}/{runs}]", file=sys.stderr, flush=True)
            try:
                result = _run_single(llm, agent, rule, input_file, max_chars)
                completed_runs += 1
                if result.findings:
                    finding_runs += 1
                    for f in result.findings:
                        if f.message.strip():
                            all_messages.append(f.message.strip())
                        if f.suggestion.strip():
                            all_suggestions.append(f.suggestion.strip())
            except Exception as e:
                print(f"    warning: {e}", file=sys.stderr, flush=True)

    if total == 0:
        return None
    if completed_runs == 0:
        # Transient provider failure — report, and skip the cache so the next
        # run retries instead of trusting a vote that never happened.
        print(f"    → no completed runs (0/{total}); skipping cache", file=sys.stderr, flush=True)
        return None

    support = finding_runs / completed_runs
    if support < 0.5:
        result_dict = None
        print(f"    → clear ({finding_runs}/{completed_runs})", file=sys.stderr, flush=True)
    else:
        # Most common message and suggestion across firing runs
        best_msg = stat_mode(all_messages) if all_messages else rule.title
        best_sug = stat_mode(all_suggestions) if all_suggestions else ""
        result_dict = {
            "path": input_file["display"],
            "severity": rule.severity,
            "rule_id": rule.id,
            "title": rule.title,
            "message": best_msg,
            "suggestion": best_sug,
            "support": support,
            "runs_fired": finding_runs,
            "completed_runs": completed_runs,
            "total_runs": total,
            "why": rule.why,
        }
        print(f"    → fired ({finding_runs}/{completed_runs}): {best_msg}", file=sys.stderr, flush=True)

    if use_cache:
        cache_set(key, result_dict)  # type: ignore[possibly-undefined]

    return result_dict


# --- Self-check ---------------------------------------------------------------
# De-circularized: the case under test is held out from the examples in the prompt.


def test_input(rule: Rule, index: int, kind: str, text: str) -> dict:
    display = f"{rule.id} test {index} {kind}"
    scopes = [scope for scope in rule.scope if scope != "all"] or ["agent-guidance"]
    return {"display": display, "scopes": scopes, "text": text}


def run_self_check(
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

                # Build a prompt that holds out the case under test
                prompt = lint_prompt(rule, input_file, max_chars, exclude_test_index=index)

                all_fired: list[bool] = []
                errored = 0
                for model_id in config.models:
                    llm = build_model(model_id, api_key)
                    agent = make_lint_agent(llm, config, LintResult)
                    try:
                        result = agent.run_sync(prompt, model_settings=model_settings(rule.reasoning_effort))
                        all_fired.append(bool(result.output.findings))
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


# --- Eval (behavioral ablation) -----------------------------------------------


def eval_verdict(without_support: float, with_support: float) -> str:
    """Ablation verdict: the consumer already had the insight (redundant), gained it from the skill (effective), or lacked it either way (ineffective)."""
    if without_support >= 0.5:
        return "redundant"
    if with_support >= 0.5:
        return "effective"
    return "ineffective"


def run_consumer_plan(
    llm: OpenRouterModel,
    config: LlintAgentConfig,
    task_prompt: str,
    skill_content: Optional[str] = None,
) -> str:
    """Run the consumer model with (or without) the skill. Returns the plan text."""
    base_instructions = (
        config.instructions
        or "You are a capable AI assistant. Answer the task directly and concisely. When asked to write a plan, outline the steps you would take."
    )
    if skill_content:
        instructions = f"{skill_content.strip()}\n\n{base_instructions}"
    else:
        instructions = base_instructions
    agent: Agent[object, str] = Agent(llm, output_type=str, instructions=instructions, retries=config.retries)
    result = agent.run_sync(task_prompt.strip(), model_settings=model_settings(None))
    return result.output


def grade_plan(grade_script: Path, plan: str) -> bool:
    """Run grader script with plan on stdin. Returns True if insight is present (exit 0)."""
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


def _eval_one_run(
    model_id: str,
    config: LlintAgentConfig,
    task_prompt: str,
    skill_content: str,
    grade_script: Path,
    api_key: str,
) -> tuple[bool, bool]:
    """One (model, run) unit: without-skill and with-skill plans, both graded.

    Builds a fresh model per call: `run_sync` spins its own event loop, and an
    `httpx.AsyncClient` must not be shared across loops (i.e. across threads).
    """
    llm = build_model(model_id, api_key)
    plan_without = run_consumer_plan(llm, config, task_prompt)
    plan_with = run_consumer_plan(llm, config, task_prompt, skill_content)
    return grade_plan(grade_script, plan_without), grade_plan(grade_script, plan_with)


def run_eval(
    guidance_path: Path,
    evals_dir: Path,
    consumer_config: LlintAgentConfig,
    api_key: str,
    runs: int,
    jobs: int = 4,
) -> list[dict]:
    """Run all eval cases for a guidance file. Returns list of case results."""
    if not guidance_path.exists():
        raise FileNotFoundError(f"guidance file not found: {guidance_path}")
    if not evals_dir.exists():
        raise FileNotFoundError(f"evals directory not found: {evals_dir}")

    skill_content = read_text(guidance_path)
    cases = sorted(p for p in evals_dir.iterdir() if p.is_dir())
    if not cases:
        raise ValueError(f"no eval cases found in {evals_dir}")

    results = []
    for case_dir in cases:
        prompt_path = case_dir / "prompt.md"
        grade_script = case_dir / "grade.sh"
        if not prompt_path.exists() or not grade_script.exists():
            print(f"{program_name()}: skipping {case_dir.name}: missing prompt.md or grade.sh", file=sys.stderr)
            continue

        task_prompt = read_text(prompt_path)
        total = len(consumer_config.models) * runs

        print(f"  eval {case_dir.name}", file=sys.stderr, flush=True)
        tallies = {m: {"without": 0, "with": 0, "completed": 0} for m in consumer_config.models}
        pairs = [model_id for model_id in consumer_config.models for _ in range(runs)]
        done = 0
        with ThreadPoolExecutor(max_workers=jobs) as pool:
            futures = {
                pool.submit(
                    _eval_one_run, model_id, consumer_config, task_prompt, skill_content, grade_script, api_key
                ): model_id
                for model_id in pairs
            }
            for future in as_completed(futures):
                model_id = futures[future]
                done += 1
                try:
                    hit_without, hit_with = future.result()
                except Exception as e:
                    print(f"    warning: {model_id}: {e}", file=sys.stderr, flush=True)
                    continue
                tally = tallies[model_id]
                tally["completed"] += 1
                tally["without"] += hit_without
                tally["with"] += hit_with
                print(f"    {model_id}  [{done}/{total}]", file=sys.stderr, flush=True)

        per_model: list[dict] = []
        for model_id in consumer_config.models:
            tally = tallies[model_id]
            model_completed = tally["completed"]
            model_without_support = tally["without"] / model_completed if model_completed > 0 else 0.0
            model_with_support = tally["with"] / model_completed if model_completed > 0 else 0.0
            per_model.append(
                {
                    "model": model_id,
                    "verdict": "error"
                    if model_completed == 0
                    else eval_verdict(model_without_support, model_with_support),
                    "without_support": model_without_support,
                    "with_support": model_with_support,
                    "completed_runs": model_completed,
                    "total_runs": runs,
                }
            )

        completed = sum(t["completed"] for t in tallies.values())
        without_support = sum(t["without"] for t in tallies.values()) / completed if completed > 0 else 0.0
        with_support = sum(t["with"] for t in tallies.values()) / completed if completed > 0 else 0.0

        results.append(
            {
                "case": case_dir.name,
                "verdict": "error" if completed == 0 else eval_verdict(without_support, with_support),
                "without_support": without_support,
                "with_support": with_support,
                "completed_runs": completed,
                "total_runs": total,
                "models": per_model,
            }
        )

    return results


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


def print_eval_result(label: str, result: dict) -> None:
    print(
        f"{label}/{result['case']}: {result['verdict']} "
        f"(without={result['without_support']:.0%}, with={result['with_support']:.0%}, "
        f"n={result.get('completed_runs', result['total_runs'])}/{result['total_runs']})"
    )
    # Per-model rows drive the maintenance ritual: delete guidance only when
    # every deployed consumer reports it redundant.
    for row in result.get("models", []):
        print(
            f"  {row['model']}: {row['verdict']} "
            f"(without={row['without_support']:.0%}, with={row['with_support']:.0%}, "
            f"n={row.get('completed_runs', row['total_runs'])}/{row['total_runs']})"
        )


def should_fail_on(findings: list[dict], fail_on: str) -> bool:
    threshold = SEVERITY_RANK.get(fail_on, 0)
    return any(SEVERITY_RANK.get(f.get("severity", ""), 0) >= threshold for f in findings)


# --- CLI -----------------------------------------------------------------------


class OutputFormat(str, Enum):
    text = "text"
    json = "json"


class ScopeChoice(str, Enum):
    agent_guidance = "agent-guidance"
    skill_definition = "skill-definition"
    multi_agent = "multi-agent"


class FailOnChoice(str, Enum):
    suggestion = "suggestion"
    warning = "warning"
    error = "error"


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
    try:
        code = action()
    except KeyboardInterrupt:
        print(f"{program_name()}: interrupted", file=sys.stderr)
        code = 130
    except Exception as error:
        print(f"{program_name()}: {error}", file=sys.stderr)
        code = 2
    raise typer.Exit(code)


def _resolve_rules(rules_dir: Optional[list[Path]], rule: Optional[list[str]]) -> list[Rule]:
    dirs = [path.expanduser() for path in rules_dir] if rules_dir else default_rule_dirs()
    loaded = load_rules(dirs, set(rule) if rule else None)
    if not loaded:
        raise ValueError(f"no rules found in {', '.join(path.as_posix() for path in dirs)}")
    return loaded


@app.command(epilog=help_notes())
def lint(
    paths: PathsArg = None,
    scope: ScopeOpt = None,
    rules_dir: RulesDirOpt = None,
    agent_spec_dir: AgentSpecDirOpt = None,
    rule: RuleOpt = None,
    model: ModelOpt = DEFAULT_MODEL,
    openrouter_api_key: ApiKeyOpt = "",
    max_chars: MaxCharsOpt = 24_000,
    stdin_filename: StdinNameOpt = "STDIN.md",
    output_format: FormatOpt = OutputFormat.text,
    no_fail: NoFailOpt = False,
    fail_on: FailOnOpt = FailOnChoice.suggestion,
    runs: RunsOpt = DEFAULT_RUNS,
) -> None:
    """Lint files or directories against the rules (multi-model voting)."""

    def action() -> int:
        loaded = _resolve_rules(rules_dir, rule)
        if not openrouter_api_key:
            print(f"{program_name()}: OPENROUTER_API_KEY is required for lint", file=sys.stderr)
            return 2
        configure_agent_spec_dirs(agent_spec_dir)
        config = load_agent_config("lint", model)
        scopes = [item.value for item in scope] if scope else []
        inputs = collect_inputs(paths or [], stdin_filename, scopes)
        findings: list[dict] = []
        for input_file in inputs:
            for current_rule in loaded:
                if not rule_applies(current_rule, scopes):
                    continue
                finding = vote_rule(config, current_rule, input_file, openrouter_api_key, runs, max_chars)
                if finding is not None:
                    findings.append(finding)

        if output_format is OutputFormat.json:
            print(json.dumps({"findings": findings}, indent=2))
        else:
            for f in findings:
                print_finding(f)
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
    """Show which rules would run on each input, without calling the model."""

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
    """List the loaded rules."""

    def action() -> int:
        loaded = _resolve_rules(rules_dir, rule)
        for current_rule in loaded:
            effort = current_rule.reasoning_effort or "-"
            print(
                f"{current_rule.id}\t{current_rule.severity}\t"
                f"{', '.join(current_rule.scope)}\treasoning={effort}\t{current_rule.source}"
            )
        return 0

    _dispatch(action)


@app.command(epilog=help_notes())
def self_check(
    rules_dir: RulesDirOpt = None,
    agent_spec_dir: AgentSpecDirOpt = None,
    rule: RuleOpt = None,
    model: ModelOpt = DEFAULT_MODEL,
    openrouter_api_key: ApiKeyOpt = "",
    max_chars: MaxCharsOpt = 24_000,
    output_format: FormatOpt = OutputFormat.text,
    no_fail: NoFailOpt = False,
) -> None:
    """Run rule bad/good tests as executable self-checks (held-out, de-circularized)."""

    def action() -> int:
        loaded = _resolve_rules(rules_dir, rule)
        if not openrouter_api_key:
            print(f"{program_name()}: OPENROUTER_API_KEY is required for self-check", file=sys.stderr)
            return 2
        configure_agent_spec_dirs(agent_spec_dir)
        config = load_agent_config("lint", model)
        results = run_self_check(config, loaded, openrouter_api_key, max_chars)
        if output_format is OutputFormat.json:
            print(json.dumps({"results": results}, indent=2))
        else:
            for result in results:
                print_self_check_result(result)
        failed = [r for r in results if not r["passed"]]
        return 1 if failed and not no_fail else 0

    _dispatch(action)


@app.command(name="eval", epilog=help_notes())
def eval_skill(
    skill: Annotated[
        Path,
        typer.Argument(
            metavar="TARGET",
            help="Skill directory (SKILL.md + evals/) or a guidance .md file (e.g. AGENTS.md).",
        ),
    ],
    evals_dir: Annotated[
        Path | None,
        typer.Option(
            "--evals-dir",
            help="Eval cases directory. Defaults to <dir>/evals for a skill dir, "
            "or .evals/<name lowercased> beside a guidance file (AGENTS.md -> .evals/agents/).",
        ),
    ] = None,
    agent_spec_dir: AgentSpecDirOpt = None,
    model: ModelOpt = DEFAULT_MODEL,
    openrouter_api_key: ApiKeyOpt = "",
    runs: RunsOpt = DEFAULT_RUNS,
    jobs: Annotated[int, typer.Option("--jobs", help="Parallel consumer requests.")] = 4,
    output_format: FormatOpt = OutputFormat.text,
    no_fail: NoFailOpt = False,
) -> None:
    """Run behavioral ablation evals: probe whether a skill's insight is redundant, effective, or ineffective."""

    def action() -> int:
        if not openrouter_api_key:
            print(f"{program_name()}: OPENROUTER_API_KEY is required for eval", file=sys.stderr)
            return 2
        configure_agent_spec_dirs(agent_spec_dir)
        if load_agent_raw("consumer") is None:
            # A silent fallback here has fabricated single-model verdicts twice;
            # eval results are only meaningful against the deployed consumer list.
            searched = ", ".join(str(d) for d in AGENT_SPEC_DIRS)
            print(
                f"{program_name()}: warning: no consumer agent spec found in {searched}; falling back to {model}",
                file=sys.stderr,
            )
        consumer_config = load_agent_config("consumer", model)
        target = skill.expanduser()
        if target.is_file() and target.name != "SKILL.md":
            guidance_path = target
            cases_dir = evals_dir or target.parent / ".evals" / target.stem.lower().replace("_", "-")
            label = target.name
        else:
            base_dir = target.parent if target.is_file() else target
            guidance_path = base_dir / "SKILL.md"
            cases_dir = evals_dir or base_dir / "evals"
            label = base_dir.name
        results = run_eval(guidance_path, cases_dir, consumer_config, openrouter_api_key, runs, jobs)
        if output_format is OutputFormat.json:
            print(json.dumps({"skill": label, "cases": results}, indent=2))
        else:
            for r in results:
                print_eval_result(label, r)
        # Fail if any case is ineffective (guidance not landing) or errored out
        failing = [r for r in results if r["verdict"] in ("ineffective", "error")]
        return 1 if failing and not no_fail else 0

    _dispatch(action)


if __name__ == "__main__":
    app(prog_name=",llint")
