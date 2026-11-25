# AGENTS.md: Coding-Agent Operating Protocol for GRIT

This file is copied into the GRIT repository root by GRIT-P001. Every implementation prompt tells the agent to read it first. It's short on purpose.

## Before you change anything

1. Read this file, the prompt you were given, and the files listed under its "Existing repository context".
2. Read `prompts/status.json` and confirm every prerequisite prompt is `done`. If one isn't, stop and report the blocker.
3. Inspect existing code and tests in the area you'll touch.
4. Find the smallest correct implementation that satisfies the acceptance criteria.
5. Write a short plan (5 to 10 lines) in your first message: files, interfaces, tests.

## While you work

6. Make targeted changes. Only files listed under "Files to create" and "Files to modify", plus tests and docs for them. If you need another file, say why in the completion report.
7. Don't refactor unrelated code.
8. Add or update tests alongside the code.
9. Run the prompt's verification commands. Fix failures that are in scope.
10. Record blockers you can't resolve in scope.
11. Update the docs the prompt names (module docstrings, registry entries, README sections).
12. Stop when the acceptance criteria are met. Don't add features the prompt didn't ask for.

## Never

- Rewrite a working subsystem without a stated, prompt-sanctioned reason.
- Add a dependency not named in the prompt. If one seems necessary, stop and ask.
- Generate speculative features, placeholder modules, empty directories or TODO-only files.
- Change a scientific assumption, constant, tolerance or reference value silently. Changes go in the completion report with the reason.
- Delete, skip, weaken or `xfail` a failing test to get green.
- Claim a command passed without running it and showing the output.
- Modify `grit_verify`, `grit_lab.authorization`, `grit_lab.audit`, budget code, `architecture/layers.toml`, holdout data or evaluator keys unless the prompt explicitly owns that file.
- Expand any resource budget, or start GPU or paid-API work, without written human approval in the prompt or the conversation.
- Deploy anything, or promote an experimental model, automatically.
- Put secrets in code, configs, tests, logs, notebooks or commits.
- Use `eval`, `exec`, `pickle.load`, `torch.load` without `weights_only=True`, `yaml.load` without `SafeLoader`, `subprocess(..., shell=True)`, or user input in file paths without normalizing against an allowed root.

## Code rules (summary)

- Python 3.12, `from __future__ import annotations`, mypy strict, Ruff.
- Scientific functions are pure: no I/O, logging, globals or hidden RNG. Stochastic functions take `rng: numpy.random.Generator`.
- SI units internally; pint only at boundaries.
- Errors are `grit_core.errors.GritError` subclasses. No silent `NaN`.
- Results are frozen dataclasses with read-only arrays.
- Public scientific functions: NumPy-style docstring with formula, units, `Concept: GRIT-C-####`, reference, doctest example; at least one test with `@pytest.mark.traces("GRIT-C-####")`.
- Respect `architecture/layers.toml`. `make layers` must pass.

## Completion report (paste at the end, and save to `prompts/reports/GRIT-PNNN.md`)

```
Prompt: GRIT-PNNN  Title: …
Status: done | partial | blocked
Files created: …
Files modified: …
Commands run and results: (paste the actual summary lines)
Acceptance criteria: (each one: met / not met, with evidence)
Scientific assumptions introduced or changed: …
Limitations: …
Unresolved issues / blockers: …
```

Then set the prompt's status in `prompts/status.json` with `uv run python scripts/prompt_status.py set GRIT-PNNN done` (or `partial` / `blocked`).
