# Maintaining guidance over time

The durable assets are the directives (each carrying external information: conventions, preferences, incident scar tissue) and the eval cases. Skill *text* is closer to a compilation artifact: on-demand re-verification decides what stays. The loop below is human-triggered — run it after a model or tooling change, never on a schedule.

## Recompile ritual

1. Re-run behavioral ablation per skill: `,llint improve --dry-run <skill-dir>`. One pass reports both the per-directive keep/drop deltas and the per-case `redundant`/`effective`/`ineffective` verdict, measured on every deployed consumer. Keep the consumer list (`~/.config/dotfiles/llint/agents/consumer.yaml`) matching the models actually deployed.
2. `redundant` for every deployed consumer → that guidance pays token rent without buying behavior. Re-run without `--dry-run` and `improve` deletes it, compresses the survivors, and re-certifies in one pass. `--subset-search` searches whole subsets rather than one directive at a time (experimental, first consumer only).
3. `ineffective` → neither arm cleared the floor, so suspect the case before the skill: a grader demanding one exact phrasing fails runs that understood the directive perfectly well, which is what retired `report-every-failure`. Only once the grader accepts any shape carrying the insight is it worth rewriting the directive — more concrete trigger, verifiable success condition, not more words.
4. Re-run the deterministic lanes (`mise run check`) and the judge lane (`mise run check-llm`) on anything edited.
5. Session mining: when a real transcript shows a violation the guidance should have prevented, capture it as `evals/<case>/` (`prompt.md` + `grade.sh`, grep-first) *before* fixing the guidance — evals accumulate; text stays disposable.
