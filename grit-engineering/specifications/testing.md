# Testing Strategy and Acceptance Matrix

Tests verify behavior that matters. There's no coverage percentage target; there's a rule that every public function's contract (from [scientific-modules.md](scientific-modules.md)) has a test, and every registry concept marked `implemented` has a test that traces to it.

## Test kinds

| Kind | Marker | Runs in | Typical size | Example |
|---|---|---|---|---|
| Unit | (default) | every CI run | ms | `entropy([0.5, 0.5], base=2) == 1.0` |
| Property | `property` | every CI run (`ci` Hypothesis profile: 100 examples) | < 1 s each | `KL(p, q) ≥ 0` for all valid p, q |
| Numerical reference | `numerical` | every CI run | ms | Lorenz Lyapunov exponent 0.906 ± 0.02 |
| Mathematical invariant | `property` or `numerical` | every CI run | | Conserved moieties constant |
| Integration | `integration` | every CI run | seconds | Lab: spec → authorize → run → artifacts |
| API contract | `contract` | every CI run | seconds | OpenAPI schema matches committed snapshot |
| Model shape | (default) | every CI run | ms | `(B, T) → (B, T, V)` |
| Gradient | (default) | every CI run | ms | `torch.autograd.gradcheck` on attention in float64 |
| Dataset integrity | `integration` | every CI run (tiny fixture) | seconds | No cross-split duplicates |
| Checkpoint restoration | `integration` | every CI run (tiny model) | seconds | Bit-identical resume on CPU |
| Inference consistency | `integration` | every CI run | seconds | KV cache equals full recompute |
| Statistical validation | `numerical`, `slow` | nightly | minutes | 95% CI coverage simulation |
| Security | `security` | every CI run | seconds | Authz matrix; parser fuzz; path traversal |
| Performance benchmark | `bench` | on demand, weekly | minutes | `logsumexp` 1e7 |
| End-to-end | `e2e` | nightly, pre-release | minutes | Z prompts |
| GPU | `gpu` | manually, on Profile 3 | hours | G1/G2 runs |

Default CI command: `uv run pytest -m "not slow and not bench and not gpu and not e2e"`. Target: under 5 minutes on a GitHub-hosted runner.

## Numerical tolerance policy (P005)

- Default comparison: `assert_allclose(actual, expected, rtol=1e-10, atol=1e-12)` for closed-form float64 results.
- Iterative solvers: tolerance derived from the solver's own `rtol/atol` times a documented safety factor (default 10).
- Stochastic results: compared statistically (z-test or CI containment at a fixed seed), never with a fixed tolerance against a single sample, and with the false-failure rate stated in the test docstring (target < 1e-4 per run).
- Every tolerance in a test has a comment explaining where it came from.

## Hypothesis profiles

`ci` (100 examples, deadline 500 ms, derandomized with a fixed seed for reproducibility), `dev` (50 examples), `thorough` (2,000 examples, nightly). Selected via `HYPOTHESIS_PROFILE`.

## Fixtures

- Small and committed: `tests/fixtures/` per package, under 1 MB each. Larger fixtures generated deterministically at test time from seeds.
- Datasets: a 200-document synthetic corpus with planted exact and near duplicates, used by `grit_data` tests.
- Models: a 2-layer, d=32 Transformer (~30k params) for training, checkpoint and inference tests.

## Independently controlled evaluation suites

Scientific evaluation suites (the `grit_verify.model_eval` suites and their holdouts) are not part of ordinary CI. CI tests the suite *code* on public dev splits. Holdout evaluation runs only through `grit-eval` on an authorized request.

## Acceptance matrix (milestones)

| Milestone | Gate | Measured by | Prompts |
|---|---|---|---|
| M0 Foundations | `make check` green on a fresh clone in < 10 min; layer checker rejects a planted bad import; registry validator rejects a planted bad entry | CI | P001 to P006 |
| M1 GRIT Core | All core modules implemented with reference tests; benchmark baselines recorded | CI + bench report | P007 to P018 |
| M2 Mathematical laboratory | Algebra + dynamics modules; 10 numerical reference results (Feigenbaum, Lyapunov, …) within stated tolerance | CI | P019 to P028 |
| M3 Biological laboratory | All bio models reproduce their cited reference behavior | CI | P029 to P035 |
| M4 Measurement sciences | Cognition, physics, discovery modules; scaling-law fit recovers synthetic parameters | CI | P036 to P045 |
| M5 Experiment infrastructure | Full state machine with audit; bypass attempts fail; signed evaluation round trip | CI integration | P046 to P058 |
| M6 Baseline model | G0 trained, resumed bit-identically, independently evaluated, model card reviewed | P081 report (human) | P059 to P081 |
| M7 Observatory | 50 instruments, 12 workspaces, a11y clean, budgets met | Playwright + Lighthouse | P082 to P095 |
| M8 Deployment | Profile 1 and 2 running; GPU dry run (no training) completes and self-terminates | Runbook log | P096 to P099, P105 to P107 |
| M9 Controlled model research | G1 studies verified; G2 decision made | Reports (human) | P100 to P104 |
| M10 Integration and validation | E2E suites green; independent replication of G0 within tolerance | P113 to P116 | P108 to P116 |

Per-prompt acceptance criteria are in [../manifests/acceptance.json](../manifests/acceptance.json).

## Integration test matrix

Rows are producers, columns consumers. Each cell names the integration test (file under `tests/integration/`) that exercises the seam.

| Producer ↓ / Consumer → | grit_lab | grit_verify | alphalytica.train | alphalytica.infer | services/api | observatory |
|---|---|---|---|---|---|---|
| grit_core | (all packages: unit level) | | | | | |
| L2 domain packages | | | | | `test_instruments_compute.py` | `instruments.spec.ts` |
| grit_data | `test_dataset_refs.py` | `test_contamination_index.py` | `test_batches_to_train.py` | | | |
| grit_lab | | `test_eval_request_roundtrip.py` | `test_authorized_run_only.py` | | `test_experiment_endpoints.py` | `experiments.spec.ts` |
| grit_verify | `test_signed_result_attach.py` | | | | `test_evaluation_endpoints.py` | `verification.spec.ts` |
| alphalytica.train | `test_run_record_complete.py` | `test_checkpoint_eval.py` | | `test_train_then_generate.py` | | `training.spec.ts` |
| alphalytica.infer | | `test_textmodel_protocol.py` | | | `test_generate_endpoint.py` | `inference.spec.ts` |
| services/api | | | | | | `api-contract.spec.ts` |
