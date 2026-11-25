# GRIT-P016: Information theory

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| C. Information theory and statistics | 1 | 7 | M | CPU, laptop | scientific |

## Prompt identifier

`GRIT-P016`

## Objective

Create `grit_core.information`: entropy, cross-entropy, KL and JS divergence, mutual information, conditional entropy, bias-corrected estimators, perplexity and bits per byte.

## Scientific context

Information measures are central to GRIT (entropy analysis instruments, bits-per-byte as the primary language modeling metric). Bits per byte is tokenizer-independent: `bpb = total_nll_nats / (n_bytes · ln 2)` (ADR-0013).

## Prerequisites

- `GRIT-P007` Core types, error hierarchy and canonical hashing (must be `done`)
- `GRIT-P015` Probability distributions and seeding (must be `done`)

Files from prerequisites that must exist:

- `docs/registry/concepts/grit_core.toml`

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/scientific-modules.md section 1 (grit_core)
- Cover & Thomas (2006) ch. 2
- Miller (1955) bias correction

## Scope

- `entropy(p, base)`, `cross_entropy(p, q, base)`, `kl(p, q, base)`, `js(p, q, base)` (bounded by log 2), `mutual_information(joint, base)`, `conditional_entropy(joint, base)`.
- `entropy_plugin(counts)`, `entropy_miller_madow(counts)`, `entropy_ci(counts, rng, level)` (bootstrap).
- `differential_entropy_gaussian(cov)`, `kl_gaussian(mu0, cov0, mu1, cov1)` closed forms for tests and instruments.
- `perplexity(mean_nll_nats)`, `bits_per_byte(total_nll_nats, n_bytes)`, `nats_to_bits`.
- Conventions: `0 log 0 = 0`; KL with `q_i = 0 < p_i` returns `inf`.

## Out of scope

- Continuous estimators beyond Gaussian closed forms (kNN estimators): add later only if an instrument needs them.

## Architecture constraints

- Functional core (ADR-0003): pure functions, no I/O, no logging, no global state, no clocks.
- Stochastic functions take `rng: numpy.random.Generator`; never call global seeding functions.
- SI units internally; pint only at boundaries (ADR-0010). Document units in every docstring.
- float64 unless documented otherwise. Raise `GritError` subclasses; never return a silent NaN.
- Results are frozen dataclasses with read-only arrays and a `to_dict()` method.
- Each public function: NumPy-style docstring with formula, units, `Concept: GRIT-C-####`, citation, doctest; registry entry in the package's block; a test marked `@pytest.mark.traces`.
- Respect `architecture/layers.toml`; `make layers` must pass.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `packages/grit_core/src/grit_core/information.py` | information-theoretic measures |
| `packages/grit_core/tests/test_information.py` | unit, property and reference tests |

## Files to modify

| Path | Change |
|---|---|
| `docs/registry/concepts/grit_core.toml` | entries for every measure (definitions with LaTeX) |

## Public interfaces

```python
def entropy(p: ProbVector, *, base: float = math.e) -> float: ...
def kl(p: ProbVector, q: ProbVector, *, base: float = math.e) -> float: ...
def mutual_information(joint: FloatArray, *, base: float = math.e) -> float: ...
def entropy_miller_madow(counts: IntArray, *, base: float = math.e) -> float: ...
def bits_per_byte(total_nll_nats: float, n_bytes: int) -> float: ...
```

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Properties: H ≥ 0; H ≤ log n; KL ≥ 0; KL(p,p)=0; JS symmetric and ≤ log 2; I(X;Y)=I(Y;X) ≥ 0; chain rule H(X,Y)=H(X)+H(Y|X).
- Closed forms: Gaussian differential entropy; KL between Gaussians vs Monte Carlo (1e6 samples, z-test).
- Miller-Madow reduces bias vs plug-in on 1,000 seeded small-sample trials (mean error closer to truth).
- `bits_per_byte` on a uniform byte model equals 8.0 exactly.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv run pytest packages/grit_core/tests/test_information.py -q
make check
```

## Acceptance criteria

- [ ] All properties pass under `thorough` profile.
- [ ] No NaN for any valid ProbVector input including zeros.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P016.md` and paste in your final message:

```
Prompt: GRIT-P016  Title: Information theory
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P016 done` (or `partial` / `blocked`).

## Operating protocol

1. Read `AGENTS.md`, this prompt, and every file under Existing repository context.
2. Confirm prerequisites are `done` with `uv run python scripts/prompt_status.py check` (from P006 onward) and set this prompt `in_progress`.
3. Inspect existing code and tests in the area you'll touch.
4. Identify the smallest correct implementation that meets the acceptance criteria.
5. State a concise plan (files, interfaces, tests) before editing.
6. Make targeted changes only to the files listed (plus their tests and docs).
7. Don't refactor unrelated code.
8. Add or update tests with the code.
9. Run every verification command and read the output.
10. Fix failures within scope; record anything out of scope as a blocker.
11. Update the documentation and registry entries named in this prompt.
12. Stop when every acceptance criterion is met. Write the completion report and set the status.
