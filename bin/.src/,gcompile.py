#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.14"
# dependencies = [
#   "gepa",
#   "httpx",
#   "pyyaml",
#   "typer",
# ]
# [tool.uv]
# exclude-newer = "2026-06-28T00:00:00Z"
# ///

# Guidance-as-compilation-artifact experiment: measure which directives still
# buy behavior on deployed consumer models (`ablate`), and search for the
# minimal directive subset per model with GEPA (`compile`).
# Human-triggered only — run on demand or after a model/tooling change.

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Annotated, Optional

import httpx
import typer
import yaml

DEFAULT_RUNS = 3
# High enough that reasoning consumers (kimi burned 1600 tokens of thinking
# before writing a word) finish their answers; a `length` finish is treated as
# an incomplete run, so this cap must stay above honest answer sizes.
MAX_OUTPUT_TOKENS = 8000
CACHE_DIR = Path.home() / ".cache" / "gcompile"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
# One id per invocation: OpenRouter uses it as the sticky-routing key (same
# provider within a session helps cache hits) and it filters the activity
# dashboard when debugging.
SESSION_ID = f"gcompile-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}-{os.getpid()}"

# Mirrors ,llint's consumer default so support numbers stay comparable.
BASE_CONSUMER_INSTRUCTIONS = (
    "You are a capable AI assistant. Answer the given task directly and concisely. "
    "When asked to write a plan, outline the steps you would take."
)


def program_name() -> str:
    name = Path(sys.argv[0] or __file__).name
    return name.removeprefix("executable_")


# --- Skill parsing: split SKILL.md into keepable atoms --------------------------


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


# --- Eval cases (same layout ,llint eval uses) -----------------------------------


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


def grade(grader: Path, plan: str) -> bool:
    try:
        proc = subprocess.run([str(grader)], input=plan, text=True, capture_output=True, timeout=30)
        return proc.returncode == 0
    except (subprocess.TimeoutExpired, OSError):
        return False


# --- OpenRouter consumer calls, cached by content hash ---------------------------

# One shared gate on in-flight OpenRouter requests: consumer_plans fans out its n
# runs and every caller fans out across (candidate, case) pairs, so without this
# the worst case is jobs x runs concurrent calls. Retry sleeps release the slot.
_REQUEST_SLOTS = threading.Semaphore(12)


def _cache_path(key_parts: dict) -> Path:
    digest = hashlib.sha256(json.dumps(key_parts, sort_keys=True).encode()).hexdigest()
    return CACHE_DIR / f"{digest}.json"


def consumer_plans(model: str, skill_text: str, prompt: str, runs: int, api_key: str) -> list[tuple[str, bool]]:
    """Return `runs` (output, completed) pairs for prompt under skill_text; disk-cached."""
    # No sampling params in the key (or the request): models run at provider
    # defaults, same as real consumer harnesses. Key change invalidates the
    # pre-2026-07-06 cache, which measured at temperature 0.6.
    # max_tokens is part of the key: truncation changes what the grader sees, so
    # measurements taken under different caps must never mix.
    path = _cache_path(
        {"model": model, "skill": skill_text, "prompt": prompt, "runs": runs, "max_tokens": MAX_OUTPUT_TOKENS}
    )
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if "runs" in data:
                return [(r["plan"], r["complete"]) for r in data["runs"]]
            # Pre-noise-policy cache: empty outputs were filtered/failed runs.
            return [(p, bool(p.strip())) for p in data["plans"]]
        except (json.JSONDecodeError, OSError, KeyError):
            pass

    system = (
        (skill_text.strip() + "\n\n" + BASE_CONSUMER_INSTRUCTIONS) if skill_text.strip() else BASE_CONSUMER_INSTRUCTIONS
    )
    # The n runs are independent samples; serially they dominated wall time (a
    # reasoning consumer takes 1-2 min per call). Burst capped at 6: larger
    # bursts of IDENTICAL prompts provoke empty 200s from Moonshot (12+/15
    # empties during 2026-07-08 certification sweeps; varied-prompt bursts and
    # n=5 bursts were clean). _REQUEST_SLOTS still bounds global concurrency.
    with httpx.Client(timeout=120) as client, ThreadPoolExecutor(max_workers=min(runs, 6)) as pool:
        futures = [pool.submit(_one_completion, client, model, system, prompt, api_key) for _ in range(runs)]
        results = [future.result() for future in futures]

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"runs": [{"plan": p, "complete": c} for p, c in results]}), encoding="utf-8")
    return results


def _one_completion(client: httpx.Client, model: str, system: str, prompt: str, api_key: str) -> tuple[str, bool]:
    payload = {
        "model": model,
        "max_tokens": MAX_OUTPUT_TOKENS,
        # No cache_control: matching is block-granular and nothing we send has a
        # reusable prefix over the model minimums (consumer system ~900 tokens,
        # reflector preamble ~142), so the flag only bought 1.25x write
        # surcharges — and parallel runs race the cache anyway (entries appear
        # only after the first response begins).
        "session_id": SESSION_ID,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
    }
    last_error: Exception | None = None
    for attempt in range(4):
        try:
            with _REQUEST_SLOTS:
                resp = client.post(OPENROUTER_URL, json=payload, headers={"Authorization": f"Bearer {api_key}"})
            if resp.status_code in (408, 429, 500, 502, 503, 504):
                retry_after = float(resp.headers.get("retry-after", 2 * (attempt + 1)))
                time.sleep(min(retry_after, 30))
                last_error = RuntimeError(f"{resp.status_code}: {resp.text[:200]}")
                continue
            resp.raise_for_status()
            data = resp.json()
            choice = data["choices"][0]
            content = choice["message"]["content"] or ""
            finish = choice.get("finish_reason")
            if finish in ("content_filter", "length"):
                return content, False  # deterministic for this (model, prompt); retrying won't change it
            if finish != "error" and content.strip():
                return content, True
            # Transient provider artifacts, retried like transport errors:
            # empty 200s (documented "cold start / scaling up" behavior; they
            # clustered under concurrent identical prompts) and finish_reason
            # "error" (provider died mid-generation — the 200 body carries
            # PARTIAL content that must not reach a grader).
            last_error = RuntimeError(f"unusable response (finish_reason={finish})")
            time.sleep(2 * (attempt + 1))
        # Truncated/malformed 200 bodies happen (JSONDecodeError mid-stream,
        # `{"error": ...}` payloads) — retry them like transport errors.
        except (httpx.TransportError, json.JSONDecodeError, KeyError, IndexError, TypeError) as e:
            last_error = e
            time.sleep(2 * (attempt + 1))
    print(f"warning: {model} call failed after retries ({last_error}); run counted incomplete", file=sys.stderr)
    return "", False


def case_support(model: str, skill_text: str, case: EvalCase, runs: int, api_key: str) -> float | None:
    """Fraction of completed runs the grader passes. Incomplete runs (content_filter,
    empty output, exhausted retries) leave the denominator; under half completed
    means the case is unmeasurable for this text -> None, and comparisons skip it."""
    results = consumer_plans(model, skill_text, case.prompt, runs, api_key)
    completed = [plan for plan, ok in results if ok]
    if len(completed) < (runs + 1) // 2:
        print(f"warning: {model} / {case.name}: {len(completed)}/{runs} runs completed — unmeasurable", file=sys.stderr)
        return None
    hits = sum(1 for p in completed if grade(case.grader, p))
    return hits / len(completed)


def _pct(value: float | None) -> str:
    return "n/a" if value is None else f"{value:.0%}"


def holds_baseline(candidate: dict[str, float | None], baseline: dict[str, float | None], margin: float) -> bool:
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


def make_reflector(model: str, api_key: str):
    """LanguageModel callable for GEPA reflection (avoids gepa's litellm extra)."""

    def lm(prompt) -> str:
        if isinstance(prompt, str):
            messages = [{"role": "user", "content": prompt}]
        else:
            messages = prompt
        payload = {
            "model": model,
            "max_tokens": 4000,
            "session_id": SESSION_ID,
            "messages": messages,
        }
        with httpx.Client(timeout=300) as client:
            resp = client.post(OPENROUTER_URL, json=payload, headers={"Authorization": f"Bearer {api_key}"})
            resp.raise_for_status()
            return resp.json()["choices"][0]["message"]["content"] or ""

    return lm


# --- Deterministic lint gates (compile mode) --------------------------------------


def gate(rendered: str, agents_mode: bool = False) -> str | None:
    """Run the repo's deterministic lanes on a candidate. None = pass, str = failure output."""
    cwd = Path.cwd()
    schema = ".mdschema-agents.yml" if agents_mode else ".mdschema-skill.yml"
    if not (cwd / schema).exists() or not (cwd / ".vale.ini").exists():
        return None  # not in the dotfiles repo; gates unavailable
    tmp_dir = cwd / ".gcompile-tmp"
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


# --- Consumer defaults from ,llint's agent spec -----------------------------------


def default_consumers() -> list[str]:
    for base in (
        Path.cwd() / ".llint" / "agents",
        Path.home() / ".config" / "dotfiles" / "llint" / "agents",
        Path.cwd() / "dot_config" / "dotfiles" / "llint" / "agents",
    ):
        for suffix in (".yaml", ".yml"):
            spec = base / f"consumer{suffix}"
            if spec.is_file():
                raw = yaml.safe_load(spec.read_text(encoding="utf-8")) or {}
                models = raw.get("models") or ([raw["model"]] if raw.get("model") else [])
                if models:
                    return [str(m) for m in models]
    return ["anthropic/claude-haiku-4.5"]


# --- CLI ---------------------------------------------------------------------------

app = typer.Typer(
    add_completion=False,
    no_args_is_help=True,
    pretty_exceptions_enable=False,
    help="Per-directive ablation and GEPA subset compilation for SKILL.md files.",
)

SkillArg = Annotated[
    Path,
    typer.Argument(
        metavar="TARGET",
        help="Skill directory (SKILL.md + evals/) or a guidance .md file with cases in "
        ".evals/<name lowercased>/ beside it (AGENTS.md -> .evals/agents/).",
    ),
]
ApiKeyOpt = Annotated[str, typer.Option("--openrouter-api-key", envvar="OPENROUTER_API_KEY")]
RunsOpt = Annotated[int, typer.Option("--runs", help="Consumer runs per (candidate, case).")]
ConsumerOpt = Annotated[Optional[list[str]], typer.Option("--consumer", help="Consumer model id (repeatable).")]


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


@app.command()
def atoms(skill: SkillArg) -> None:
    """List the keepable atoms parsed from SKILL.md (verify parsing before spending)."""
    parsed, _, original, _ = _load(skill)
    for heading, ids in parsed.sections:
        print(heading)
        for atom_id in ids:
            print(f"  {atom_id}  {parsed.atoms[atom_id].summary}")
    rendered = parsed.render(set(parsed.atoms))
    status = "lossless" if rendered.strip() == original.strip() else "LOSSY (render differs from original)"
    print(f"\n{len(parsed.atoms)} atoms; full render is {status}")


@app.command()
def ablate(
    skill: SkillArg,
    consumer: ConsumerOpt = None,
    runs: RunsOpt = DEFAULT_RUNS,
    openrouter_api_key: ApiKeyOpt = "",
    jobs: Annotated[int, typer.Option(help="Parallel consumer requests.")] = 4,
) -> None:
    """Measure each atom's contribution: support(full) - support(full minus atom), per consumer."""
    if not openrouter_api_key:
        raise typer.Exit(code=2)
    parsed, cases, _, _ = _load(skill)
    consumers = consumer or default_consumers()
    all_ids = set(parsed.atoms)

    candidates: dict[str, str] = {"full": parsed.render(all_ids), "shell": parsed.render(set())}
    for atom_id in parsed.atoms:
        candidates[f"minus-{atom_id}"] = parsed.render(all_ids - {atom_id})

    total_calls = len(candidates) * len(cases) * len(consumers) * runs
    print(
        f"{len(parsed.atoms)} atoms, {len(cases)} cases, {len(consumers)} consumers "
        f"-> up to {total_calls} consumer calls (cache-deduplicated)",
        file=sys.stderr,
    )

    jobs_list = [(model, name, case) for model in consumers for name, text in candidates.items() for case in cases]
    results: dict[tuple[str, str, str], float | None] = {}
    with ThreadPoolExecutor(max_workers=jobs) as pool:
        futures = {
            pool.submit(case_support, model, candidates[name], case, runs, openrouter_api_key): (model, name, case.name)
            for model, name, case in jobs_list
        }
        for future, key in futures.items():
            results[key] = future.result()

    report = {"skill": str(skill), "runs": runs, "consumers": {}}
    for model in consumers:
        print(f"\n== {model}")
        model_report: dict = {"cases": {}, "atoms": {}}
        for case in cases:
            full = results[(model, "full", case.name)]
            bare = results[(model, "shell", case.name)]
            model_report["cases"][case.name] = {"full": full, "shell": bare}
            print(f"  {case.name}: full={_pct(full)} shell={_pct(bare)}")
        for atom_id, atom in parsed.atoms.items():
            deltas: dict[str, float | None] = {}
            for case in cases:
                full = results[(model, "full", case.name)]
                minus = results[(model, f"minus-{atom_id}", case.name)]
                deltas[case.name] = None if full is None or minus is None else full - minus
            measured = [d for d in deltas.values() if d is not None]
            if not measured:
                verdict = "unmeasurable"
            else:
                verdict = "needed" if max(measured) > 0 else ("harmful" if min(measured) < 0 else "inert")
            model_report["atoms"][atom_id] = {"deltas": deltas, "verdict": verdict}
            delta_str = " ".join(
                f"{name}:{'n/a' if delta is None else f'{delta:+.0%}'}" for name, delta in deltas.items()
            )
            print(f"  {atom_id:>5} {verdict:>7}  {delta_str}  | {atom.summary}")
        report["consumers"][model] = model_report

    # `.local.` keeps reports out of git per this repo's gitignore convention.
    out = Path(f".gcompile-ablate-{Path(str(skill)).name}.local.json")
    out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"\nreport: {out}", file=sys.stderr)


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


def render_override(parsed: Skill, overrides: dict[str, str]) -> str:
    atoms = {aid: (replace(a, text=overrides[aid]) if aid in overrides else a) for aid, a in parsed.atoms.items()}
    return Skill(parsed.frontmatter, parsed.sections, atoms, parsed.refs).render(set(atoms))


@app.command()
def compress(
    skill: SkillArg,
    consumer: Annotated[str, typer.Option("--consumer", help="Single consumer model to compress for.")],
    runs: RunsOpt = DEFAULT_RUNS,
    proposals: Annotated[int, typer.Option(help="Rewrites requested per atom.")] = 3,
    only: Annotated[
        Optional[list[str]], typer.Option("--atom", help="Atom id to compress (repeatable; default all).")
    ] = None,
    reflector: Annotated[str, typer.Option(help="OpenRouter model proposing rewrites.")] = "anthropic/claude-opus-4.8",
    write: Annotated[Optional[Path], typer.Option(help="Write the compressed file here.")] = None,
    baseline_runs: Annotated[int, typer.Option(help="Runs for the full-text baseline (0 = 3x runs).")] = 0,
    openrouter_api_key: ApiKeyOpt = "",
    jobs: Annotated[int, typer.Option(help="Parallel consumer requests.")] = 4,
) -> None:
    """Per-atom propose-verify text compression: accept the shortest reflector rewrite that
    holds per-case eval support. Greedy-cumulative — each atom is verified with all
    previously accepted rewrites in place, so the last acceptance certifies the whole file.
    Probe stage for GEPA text evolution: reports compression ratio and accept noise."""
    if not openrouter_api_key:
        raise typer.Exit(code=2)
    parsed, cases, _, agents_mode = _load(skill)

    def supports(text: str, n: int) -> dict[str, float | None]:
        with ThreadPoolExecutor(max_workers=jobs) as pool:
            futures = {
                pool.submit(case_support, consumer, text, case, n, openrouter_api_key): case.name for case in cases
            }
            return {name: future.result() for future, name in futures.items()}

    # Noise policy: the baseline is measured once at higher n so it anchors every
    # comparison; candidates hold within one candidate-measurement step (1/runs)
    # of it. Greedy-cumulative always compares against THIS baseline, so total
    # drift across the whole file stays bounded at one step.
    baseline_runs = baseline_runs or 3 * runs
    margin = 1.0 / runs
    full_text = parsed.render(set(parsed.atoms))
    baseline = supports(full_text, baseline_runs)
    print(f"baseline (n={baseline_runs}): " + " ".join(f"{name}:{_pct(value)}" for name, value in baseline.items()))

    lm = make_reflector(reflector, openrouter_api_key)
    accepted: dict[str, str] = {}
    report: dict = {
        "skill": str(skill),
        "consumer": consumer,
        "runs": runs,
        "baseline_runs": baseline_runs,
        "margin": margin,
        "baseline": baseline,
        "atoms": {},
    }
    for atom_id in only or list(parsed.atoms):
        atom = parsed.atoms[atom_id]
        original = atom.text.strip()
        orig_bytes = len(original.encode())
        raw = lm(REWRITE_PROMPT.format(k=proposals, block=original))
        variants = sorted(
            {
                v.strip()
                for v in re.split(r"^---$", raw, flags=re.M)
                if v.strip() and len(v.strip().encode()) < orig_bytes
            },
            key=lambda v: len(v.encode()),
        )
        choice = None
        gate_failed = regressed = 0
        for variant in variants:
            rendered = render_override(parsed, {**accepted, atom_id: variant})
            if gate(rendered, agents_mode) is not None:
                gate_failed += 1
                continue
            support = supports(rendered, runs)
            if holds_baseline(support, baseline, margin):
                choice = variant
                break
            regressed += 1
        stats = {
            "orig_bytes": orig_bytes,
            "proposed": len(variants),
            "gate_failed": gate_failed,
            "regressed": regressed,
        }
        if choice is not None:
            accepted[atom_id] = choice + "\n"
            stats["new_bytes"] = len(choice.encode())
            saved = 1 - len(choice.encode()) / orig_bytes
            print(f"  {atom_id:>5} {orig_bytes:>5}B -> {len(choice.encode()):>5}B (-{saved:.0%})  {atom.summary}")
        else:
            print(f"  {atom_id:>5} {orig_bytes:>5}B -> no accepted rewrite ({len(variants)} tried)  {atom.summary}")
        report["atoms"][atom_id] = stats

    final_text = render_override(parsed, accepted)
    full_bytes, final_bytes = len(full_text.encode()), len(final_text.encode())
    print(
        f"compressed {len(accepted)}/{len(parsed.atoms)} atoms: "
        f"{full_bytes}B -> {final_bytes}B (-{1 - final_bytes / full_bytes:.0%})"
    )
    report["total"] = {"full_bytes": full_bytes, "final_bytes": final_bytes}
    if accepted:
        # Acceptances were selected on n=runs samples; certify the whole file on
        # independent baseline-grade measurements (report-only — reverting is the
        # maintainer's call).
        final_support = supports(final_text, baseline_runs)
        held = holds_baseline(final_support, baseline, margin)
        print(
            f"final verification (n={baseline_runs}): "
            + " ".join(f"{name}:{_pct(value)}" for name, value in final_support.items())
            + ("  — holds baseline" if held else "  — REGRESSED vs baseline")
        )
        report["final_verification"] = {"support": final_support, "holds": held}
    out = Path(f".gcompile-compress-{Path(str(skill)).name}.local.json")
    out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"report: {out}", file=sys.stderr)
    if write:
        write.write_text(final_text, encoding="utf-8")
        print(f"wrote {write}")


@app.command()
def compile(
    skill: SkillArg,
    consumer: Annotated[str, typer.Option("--consumer", help="Single consumer model to compile for.")],
    runs: RunsOpt = DEFAULT_RUNS,
    budget: Annotated[int, typer.Option(help="GEPA max metric calls (candidate x case evaluations).")] = 60,
    reflector: Annotated[str, typer.Option(help="OpenRouter model for GEPA reflection.")] = "anthropic/claude-opus-4.8",
    write: Annotated[Optional[Path], typer.Option(help="Write the compiled SKILL.md here.")] = None,
    baseline_runs: Annotated[int, typer.Option(help="Runs for the full-text baseline (0 = 3x runs).")] = 0,
    openrouter_api_key: ApiKeyOpt = "",
) -> None:
    """GEPA subset selection: find the smallest atom set that keeps eval support, per consumer model."""
    if not openrouter_api_key:
        raise typer.Exit(code=2)
    import gepa.optimize_anything as oa
    from gepa.optimize_anything import EngineConfig, GEPAConfig, ReflectionConfig, optimize_anything

    parsed, cases, _, agents_mode = _load(skill)
    all_ids = list(parsed.atoms)
    full_text = parsed.render(set(all_ids))
    full_bytes = len(full_text.encode())
    render_cache: dict[frozenset, tuple[str, str | None]] = {}

    # Noise policy: per-case floors anchored to a high-n full-text baseline. A
    # candidate below floor on ANY case scores 0 on that case, so GEPA cannot
    # trade a real per-case drop away inside an aggregate tie.
    baseline_runs = baseline_runs or 3 * runs
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {
            pool.submit(case_support, consumer, full_text, case, baseline_runs, openrouter_api_key): case.name
            for case in cases
        }
        baseline = {name: future.result() for future, name in futures.items()}
    floor = {name: (None if value is None else value - 1.0 / runs) for name, value in baseline.items()}
    print(f"baseline (n={baseline_runs}): " + " ".join(f"{name}:{_pct(value)}" for name, value in baseline.items()))

    def realize(keep_csv: str) -> tuple[set[str] | None, str, str | None]:
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

    def evaluator(candidate: str, example: EvalCase):
        ids, rendered, problem = realize(candidate)
        if ids is None or problem is not None:
            return 0.0, {"Error": problem, "scores": {"support": 0.0, "brevity": 0.0}}
        support = case_support(consumer, rendered, example, runs, openrouter_api_key)
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
    result = optimize_anything(
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
                max_metric_calls=budget, parallel=True, max_workers=4, cache_evaluation=True, raise_on_exception=False
            ),
            reflection=ReflectionConfig(
                reflection_lm=make_reflector(reflector, openrouter_api_key), reflection_prompt_template=None
            ),
        ),
    )

    # Selection ignores aggregate scores: the smallest candidate that holds every
    # per-case floor wins (GEPA subsamples cases, so aggregates are not comparable
    # anyway). Certification measures at baseline_runs on samples the optimizer
    # never selected on — GEPA gets many shots at an n=runs lucky draw, so the
    # winner is exactly the candidate most likely to have one. Short-circuits on
    # the first breached case; falls back to the seed (full text).
    def passes_floors(csv: str) -> bool:
        ids, rendered, gate_failure = realize(csv)
        if ids is None or gate_failure is not None:
            return False
        for case in cases:
            case_floor = floor[case.name]
            if case_floor is None:
                continue
            support = case_support(consumer, rendered, case, baseline_runs, openrouter_api_key)
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
        print(f"  dropped {atom_id}: {parsed.atoms[atom_id].summary}")
    if write:
        write.write_text(rendered, encoding="utf-8")
        print(f"wrote {write}")


def _candidate_text(candidate: dict[str, str]) -> str:
    return next(iter(candidate.values())) if isinstance(candidate, dict) else str(candidate)


def _candidate_bytes(parsed: Skill, candidate: dict[str, str]) -> int:
    ids = {t.strip() for t in _candidate_text(candidate).replace("\n", ",").split(",") if t.strip()}
    ids &= set(parsed.atoms)
    return len(parsed.render(ids).encode())


if __name__ == "__main__":
    app()
