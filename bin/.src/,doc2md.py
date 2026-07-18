#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10,<3.14"  # magika -> onnxruntime 1.20.1 ships no cp314 wheels
# dependencies = [
#     "typer>=0.15",
#     "magika>=0.6",
#     "markitdown[all]>=0.1",
#     "datalab-python-sdk",
# ]
# [tool.uv]
# exclude-newer = "2026-07-18T08:08:08Z"
# ///
"""doc2md — detect file types with Magika, convert to Markdown concurrently.

Routing (by Magika's detected content type — its `output.label`, not the
filename extension): OCR-heavy formats (PDFs, raster images) go straight to
Datalab (requires DATALAB_API_KEY) with chart understanding. Everything else
converts locally with MarkItDown first, for free; if that markdown references
images (`![`) the file is promoted and reconverted through Datalab's plain
tier, which returns the images properly linked where MarkItDown kept only
text.

Output layout: Datalab conversions land in a per-document folder with their
markdown, so image links resolve and names can't collide across documents;
text-only output is a single flat .md file.

Existing outputs are overwritten.

    ,doc2md ./scans ./report.pdf -o out
    ,doc2md ./mixed --recursive
"""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path

import typer

app = typer.Typer(add_completion=False)

# --- OCR-tier types ----------------------------------------------------------
# Keyed on Magika content-type labels (`output.label`): Magika's docs recommend
# routing on labels and explicitly discourage MIME types for automated
# workflows (inconsistent mappings, registrations that drift over time).
# Deliberately a subset of what Datalab supports
# (https://documentation.datalab.to/docs/common/supportedfiletypes.md):
# these are the formats where layout/OCR is the hard part and the full
# chart-understanding treatment is worth its cost. Structured formats carry
# their text natively — they only visit Datalab (plain, cheap tier) when the
# free MarkItDown pass shows their markdown references images; see
# convert_all().
OCR_LABELS = frozenset(
    {
        "pdf",
        # images
        "png",
        "jpeg",
        "webp",
        "gif",
        "tiff",
    }
)


class Backend(str, Enum):
    datalab = "datalab"
    markitdown = "markitdown"


@dataclass
class Job:
    src: Path
    dst: Path
    backend: Backend
    label: str = "unknown"  # Magika label, for reporting
    images: int = 0  # extracted image count, for reporting
    error: Exception | None = field(default=None)


# --- detection / routing -----------------------------------------------------


def gather_files(paths: list[Path], recursive: bool) -> list[Path]:
    found: list[Path] = []
    for p in paths:
        if p.is_dir():
            found.extend(f for f in (p.rglob("*") if recursive else p.glob("*")) if f.is_file())
        elif p.is_file():
            found.append(p)
        else:
            typer.echo(f"! not found, skipping: {p}", err=True)
    seen: set[Path] = set()
    unique: list[Path] = []
    for f in found:
        r = f.resolve()
        if r not in seen:
            seen.add(r)
            unique.append(f)
    return unique


def route(files: list[Path], out_dir: Path) -> list[Job]:
    # One Magika instance; identify_paths preserves input order and seeks
    # rather than loading whole files into memory. The default HIGH_CONFIDENCE
    # prediction mode is the right fit for routing: low-confidence detections
    # come back as generic labels (txt/unknown) and fall through to MarkItDown
    # instead of being sent to Datalab on a guess.
    from magika import Magika

    results = Magika().identify_paths(files)

    used: set[str] = set()

    def stem_for(src: Path) -> str:
        # One flat namespace of stems keyed under out_dir (files and folders
        # alike); disambiguate cross-directory collisions.
        stem = src.stem
        if stem in used:
            stem = f"{src.parent.name}_{src.stem}"
        i = 1
        while stem in used:
            stem = f"{src.stem}_{i}"
            i += 1
        used.add(stem)
        return stem

    jobs: list[Job] = []
    for src, res in zip(files, results):
        label = str(res.output.label) if res.ok else "unknown"
        stem = stem_for(src)
        if res.ok and str(res.output.group) == "archive":
            # MarkItDown would happily flatten an archive, but its ZipConverter
            # picks converters by member extension — an OCR-heavy member
            # (scanned PDF, image) silently bypasses Datalab routing and comes
            # back near-empty. Fail loudly instead of converting badly.
            job = Job(src=src, dst=out_dir / f"{stem}.md", backend=Backend.markitdown, label=label)
            job.error = RuntimeError(f"archives are not supported ({label}) — unpack it and convert the members")
            jobs.append(job)
            continue
        # Non-OCR formats start on MarkItDown and may be promoted to Datalab
        # mid-conversion if their markdown references images; see convert_all.
        # OCR-tier output always carries images, so it gets its per-document
        # folder up front; everything else starts flat and promotion re-points
        # it into a folder mid-flight.
        backend = Backend.datalab if label in OCR_LABELS else Backend.markitdown
        dst = out_dir / stem / f"{stem}.md" if backend is Backend.datalab else out_dir / f"{stem}.md"
        jobs.append(Job(src=src, dst=dst, backend=backend, label=label))
    return jobs


# --- backends ----------------------------------------------------------------


async def run_datalab(job: Job, client, options) -> None:
    result = await client.convert(str(job.src), options=options)
    if not getattr(result, "success", True):
        raise RuntimeError(getattr(result, "error", None) or "Datalab conversion failed")
    job.dst.parent.mkdir(parents=True, exist_ok=True)
    # Writes job.dst and decodes result.images beside it, keeping the
    # markdown's relative image links valid.
    result.save_output(job.dst.with_suffix(""), save_images=True)
    job.images = len(getattr(result, "images", None) or {})


def markitdown_convert(src: Path) -> str:
    from markitdown import MarkItDown

    # Instance is created per job to sidestep any shared-state/thread-safety
    # questions; hoist to a thread-local if instantiation cost matters at scale.
    result = MarkItDown(enable_plugins=False).convert_local(str(src))
    return getattr(result, "text_content", None) or getattr(result, "markdown", "") or ""


def write_markitdown(job: Job, text: str) -> None:
    job.dst.parent.mkdir(parents=True, exist_ok=True)
    job.dst.write_text(text, encoding="utf-8")


async def convert_all(jobs: list[Job], workers: int) -> list[Job]:
    """Run every job concurrently, printing each result as it completes.

    Datalab is network/poll-bound, so its own async client + gather is the
    SDK-recommended shape for batches; MarkItDown is local-CPU-bound and runs
    in threads only to stay off the event loop (the GIL caps its parallelism
    either way). One semaphore bounds both.
    """
    sem = asyncio.Semaphore(workers)

    async def process(job: Job, client, ocr_options, plain_options) -> Job:
        if job.error is not None:  # rejected at routing time (archives)
            return job
        async with sem:
            try:
                if job.backend is Backend.datalab:
                    await run_datalab(job, client, ocr_options)
                else:
                    text = await asyncio.to_thread(markitdown_convert, job.src)
                    if "![" in text:
                        # The free local pass references images it can't carry
                        # (MarkItDown keeps only text) — promote to Datalab's
                        # plain tier, which returns them properly linked. A
                        # straggler still on a flat destination (e.g. html)
                        # gets re-pointed into a folder for its images.
                        if job.dst.parent.name != job.dst.stem:
                            job.dst = job.dst.parent / job.dst.stem / job.dst.name
                        job.backend = Backend.datalab
                        await run_datalab(job, client, plain_options)
                    else:
                        await asyncio.to_thread(write_markitdown, job, text)
            except Exception as exc:  # keep the batch alive; surface per-file
                job.error = exc
        return job

    async def run_batch(client, ocr_options, plain_options) -> list[Job]:
        done: list[Job] = []
        tasks = [asyncio.ensure_future(process(j, client, ocr_options, plain_options)) for j in jobs]
        for fut in asyncio.as_completed(tasks):
            job = await fut
            if job.error is None:
                extra = f" (+{job.images} images)" if job.images else ""
                typer.echo(f"  ✓ {job.src.name}  [{job.backend.value}/{job.label}] → {job.dst.name}{extra}")
            else:
                typer.echo(f"  ✗ {job.src.name}  [{job.backend.value}]: {job.error}", err=True)
            done.append(job)
        return done

    from datalab_sdk import AsyncDatalabClient, ConvertOptions

    # OCR tier: chart_understanding forces Datalab's accurate mode
    # server-side (the API playground greys out the mode picker when it's
    # on — not in the docs as of 2026-07), so no mode knob is exposed
    # here. Plain tier (promoted image-bearing documents): default fast
    # mode — the text is already structured, Datalab is only there to
    # bring the images through with working links.
    ocr_options = ConvertOptions(output_format="markdown", extras="chart_understanding")
    plain_options = ConvertOptions(output_format="markdown")
    async with AsyncDatalabClient() as client:  # reads DATALAB_API_KEY
        return await run_batch(client, ocr_options, plain_options)


# --- CLI ---------------------------------------------------------------------


@app.command(help=__doc__)
def main(
    paths: list[Path] = typer.Argument(..., help="Files and/or directories to convert."),
    output_dir: Path = typer.Option(Path("markdown_out"), "--output-dir", "-o", help="Where output is written."),
    recursive: bool = typer.Option(False, "--recursive", "-r", help="Recurse into directories."),
) -> None:
    files = gather_files(paths, recursive)
    if not files:
        typer.echo("No input files.", err=True)
        raise typer.Exit(1)

    output_dir.mkdir(parents=True, exist_ok=True)
    jobs = route(files, output_dir)

    workers = os.cpu_count() or 4
    n_dl = sum(1 for j in jobs if j.backend is Backend.datalab)
    typer.echo(
        f"Converting {len(jobs)} file(s): {n_dl} → Datalab, {len(jobs) - n_dl} → MarkItDown  ({workers} workers)"
    )

    done = asyncio.run(convert_all(jobs, workers))
    ok = [j for j in done if j.error is None]
    failed = [j for j in done if j.error is not None]

    typer.echo(f"\nDone: {len(ok)} ok, {len(failed)} failed → {output_dir}/")
    if failed:
        raise typer.Exit(1)


if __name__ == "__main__":
    app(prog_name=",doc2md")
