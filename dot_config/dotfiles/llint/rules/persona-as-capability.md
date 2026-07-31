---
id: persona-as-capability
title: Do not use persona framing as a capability claim
severity: suggestion
scope:
  - agent-guidance
# Evidence: Persona framing ("you are an expert X") reliably affects tone and register
# but does NOT reliably improve factual accuracy or reasoning. Treating persona as a
# correctness lever is unsupported by benchmarks and misleads the guidance reader.
# See: Zheng et al. 2024, "When 'A Helpful Assistant' Is Not Really Helpful" (162
# personas, 4 model families: no consistent gain, best-persona selection ≈ random);
# Meincke, Mollick et al. 2025, "Expert Personas Don't Improve Factual Accuracy".
# Synthesis: personal research notes, out of tree (sub-question 2).
why: >-
  Persona instructions shift tone, not capability. Claiming that a persona makes the
  model's output "flawless" or "expert-level" accurate misleads both the guidance
  author and the model about what persona framing actually does.
tests:
  - bad: "You are a Nobel-laureate engineer, so your code is correct and complete."
    good: "Write in a terse senior-reviewer voice; prefer brevity over elaboration."
  - bad: "As a world-class security researcher, your vulnerability analysis is exhaustive."
    good: "Apply a security-reviewer lens: flag injection risks, auth issues, and data exposure before flagging style."
  # Exemption: persona for tone/register is fine; only flag when it claims correctness.
  - bad: "You are a meticulous editor whose output is always grammatically perfect."
    good: "Adopt a copy-editor register: fix grammar and clarity, but always show the user the change rather than applying it silently."
---

Flag persona framing that makes capability or correctness claims ("your output is flawless", "you are exhaustive"). Short, operational persona instructions that set voice or register are fine and should NOT be flagged.
