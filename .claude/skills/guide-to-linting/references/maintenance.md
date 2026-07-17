# Maintaining guidance over time

The durable assets are the directives (each carrying external information: conventions, preferences, incident scar tissue) and the eval cases. Skill *text* is closer to a compilation artifact: on-demand re-verification decides what stays. The loop below is human-triggered — run it after a model or tooling change, never on a schedule.

## Recompile ritual

1. Re-run behavioral ablation per skill: `,llint eval <skill-dir>` (whole-skill), then `,gcompile ablate <skill-dir>` for per-directive deltas. Per-model verdicts matter; keep the consumer list (`~/.config/dotfiles/llint/agents/consumer.yaml`) matching the models actually deployed.
2. `redundant` for every deployed consumer → delete or trim that guidance; it pays token rent without buying behavior. For a searched minimal subset per model, `,gcompile compile <skill-dir> --consumer <model>` (GEPA; lint lanes gate the output).
3. `ineffective` → rewrite the directive (more concrete trigger, verifiable success condition) rather than adding words.
4. Re-run the deterministic lanes (`mise run check`) and the judge lane (`mise run check-llm`) on anything edited.
5. Session mining: when a real transcript shows a violation the guidance should have prevented, capture it as `evals/<case>/` (`prompt.md` + `grade.sh`, grep-first) *before* fixing the guidance — evals accumulate; text stays disposable.
