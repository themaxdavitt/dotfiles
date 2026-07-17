---
id: guidance/hierarchy-placement
title: Place authoritative constraints in the highest-trust tier
severity: warning
scope:
  - multi-agent
# Evidence: The instruction hierarchy (system > developer > user > tool) is enforced by
# default in most model deployments. Instructions placed in lower-trust tiers can be
# overridden by the model treating them as advisory rather than authoritative.
# See: Wallace et al. 2024, "The Instruction Hierarchy" (arXiv 2404.13208).
# Synthesis: personal research notes, out of tree (sub-question 5).
why: >-
  In multi-agent systems, the instruction tier determines authority. Safety-critical
  and policy constraints placed in user prompts or task strings are less authoritative
  than the same constraints in the system prompt — and can be overridden or ignored.
llm:
  reasoning_effort: none
tests:
  - bad: |
      Spawn a database subagent with this task: never delete production data.
    good: |
      System policy: never delete production data.
      Subagent task: inspect the database migration plan without making changes.
  - bad: |
      Tell the research subagent in its task message: never send customer PII to external tools.
    good: |
      System policy for research subagent: never send customer PII to external tools.
      Task: summarize the incident report.
  - bad: |
      Task for the payments subagent: remember that bypassing the audit log is forbidden.
    good: |
      System policy: every payment mutation goes through the audit log, no exceptions.
      Task for the payments subagent: reconcile yesterday's ledger.
---

Flag safety-critical or policy constraints that are placed in a lower-trust tier (user prompt, task string, tool output) when a higher-trust tier (system prompt, developer instructions) is available and appropriate. Operational instructions without safety implications in task strings are fine and should NOT be flagged.
