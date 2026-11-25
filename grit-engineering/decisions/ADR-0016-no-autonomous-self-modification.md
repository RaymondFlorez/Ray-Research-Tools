# ADR-0016: No autonomous self-modification

Status: proposed · Date: 2026-11-25

## Context
GRIT studies recursive improvement. The platform must study it without building an uncontrolled instance of it.

## Decision
No platform component interprets model output as an instruction, command, config, code or file path. Models have no tools, network or file access during training, evaluation or inference. No model, job or automated agent can change training permissions, evaluators, evaluation criteria, budgets, governance controls or deployment. Higher-order improvement is studied as mathematics (`grit_algebra`), bounded simulation (`grit_dynamics` scenarios with hard budgets) and controlled, human-authorized experiments.

## Consequences
Any future proposal to let a model act (tool use, agents) requires a new ADR, a security review and a separate sandboxed subsystem. This ADR can't be superseded by a coding agent.
