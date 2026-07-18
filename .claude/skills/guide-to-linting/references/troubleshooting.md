# Troubleshooting lint runs

## One red run, many failures: the hk abort cascade

When any step fails, hk kills every in-flight concurrent step. Killed steps
report as `✗ <step> – ERROR` or `aborted`, so a single real failure usually
drags several phantom ones with it (observed repeatedly: a Vale failure
"failing" `sh-bash-shebang`, an oxfmt failure "failing" half the batch).
Triage:

1. Find the step whose output contains substantive failure detail; treat the rest as casualties until proven otherwise.
2. The terminal often truncates or omits the real failure's output — `~/.local/state/hk/output.log` holds full command output for some steps; when it's empty, re-run the suspect step's command manually with representative file arguments.

Related step-level quirks are documented as comments in `hk.pkl` next to their
workarounds: hk's modified-files list comes from the HEAD→index diff (a staged
deletion whose file still exists on disk gets linted — why gitignored scratch
is excluded globally), and a batch step whose files are all excluded by the
tool's *own* ignore rules can hard-error on an empty target list (the oxfmt
markdown note).

## `,llint` judge and eval anomalies

- **fable `content_filter` refusals are reproducible, not noise**: benign
  supply-chain-flavored eval prompts trip "cyber content" false positives
  (4/5 runs of `focus-comma-scripts/python-utility-pinning`, in two
  independent batches). Affected case verdicts rest on the few completed
  fable runs — discount accordingly, and consider prompt rewording if it
  spreads.
- **Reasoning consumers finishing with `length`**: a model can burn the whole
  output cap on thinking, leaving truncated or empty artifacts. Such runs
  count as incomplete (excluded from `case_support` denominators); a case
  that is mostly incomplete reads as *unmeasurable*, not as failing.
- **Degenerate judge findings**: a judge can stuff its no-findings statement
  into a finding object — e.g. a fired verdict whose message is literally
  "No violations found." (seen 2026-07-18 from the glm-5.2 judge, alongside
  `Exceeded maximum output retries` warnings on the same model). Treat such
  findings as malformed judge output, not lint signal; a `,llint`-side
  filter for them is pending.
