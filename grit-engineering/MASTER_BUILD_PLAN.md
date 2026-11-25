# GRIT Master Build Plan

Eleven phases, 117 prompts, each phase independently valuable. Phases describe deliverables; the prompt DAG ([manifests/dependencies.json](manifests/dependencies.json)) is what actually governs order, so phases overlap where dependencies allow. Wave-by-wave parallelism, file coordination, human gates and the critical path are generated in [manifests/EXECUTION_PLAN.md](manifests/EXECUTION_PLAN.md).

## How to execute

1. Seed the GRIT repository (ADR-0001) and run GRIT-P001.
2. From P006 onward, `uv run python scripts/prompt_status.py next` lists runnable prompts.
3. Give one prompt file to one coding agent. Prompts in the same wave can run in parallel except where the coordination table lists a shared file.
4. Each agent ends with a completion report in `prompts/reports/` and a status update.
5. Prompts with `review` other than `none` wait for the named reviewer before their status becomes `done`. Checklists: [checklists/](checklists/).
6. Conditional prompts are marked `skipped` with evidence when their condition is false.
7. After an interruption, `prompt_status.py check` shows where things stand; `in_progress` prompts are resumed from their partial report.

Regenerate the catalog outputs after editing `tools/catalog/`:

```bash
python3 tools/build.py
```

```bash
python3 tools/build.py --check
```

## Phases

### Phase 0: Architecture and contracts (P001 to P006)

| Deliverables | Repository, toolchain, CI, docs and ADRs in repo, layer checker, traceability registry, test infrastructure, prompt tracking |
|---|---|
| Depends on | nothing |
| Milestone | **M0**: `make check` green on a fresh clone in < 10 min on Linux and macOS; layer checker and registry validator each reject a planted violation |
| Stop if | uv or CI can't run on the target platforms; resolve before writing any science |

### Phase 1: GRIT Core (P007 to P018)

| Deliverables | `grit_core`: types, errors, hashing, units, validation, numerics, linear algebra, geometry, graphs, optimization, configs, provenance, probability, information theory, statistics, calibration math, reference suite, benchmarks |
|---|---|
| Depends on | Phase 0 |
| Milestone | **M1**: ≥ 30 cited reference cases pass; CI coverage simulation passes; benchmark baselines recorded |
| Stop if | a reference value can't be matched within its cited tolerance (investigate before building on it) |

### Phase 2: Mathematical laboratory (P019 to P028)

| Deliverables | `grit_algebra` (spaces, operators, composition, relations, invariants, fixed points, provisional capability metrics, safe symbolic parser, optional formal adapters); `grit_dynamics` (maps, ODEs, stochastic processes, stability, attractors, bifurcations, control, scenarios) |
|---|---|
| Depends on | M1 |
| Milestone | **M2**: ≥ 10 dynamical reference results within tolerance (Feigenbaum ratio, Lorenz Lyapunov exponent, etc.); symbolic parser passes fuzzing and security review |
| Stop if | the owner rejects the provisional capability metric definitions; pause P021 follow-ons until the treatise definition is supplied |

### Phase 3: Biological laboratory (P029 to P035)

| Deliverables | `grit_bio`: reaction networks and kinetics, enzyme kinetics, regulatory motifs, homeostasis, population genetics, population dynamics, fitness landscapes, comparative scaling, neuron models, synapses, plasticity, circuits |
|---|---|
| Depends on | M2 |
| Milestone | **M3**: every model reproduces its cited qualitative behavior; 1,000-neuron benchmark < 10 s on the laptop |
| Stop if | none expected; models are textbook |

### Phase 4: Intelligence Observatory sciences (P036 to P045)

| Deliverables | `grit_cognition` (profiles, IRT, learning curves, retention, generalization, transfer, calibration, memory, attention, knowledge graphs, task generators); `grit_physics` (accounting, scaling laws, measurement, efficiency, Pareto, cost estimator); `grit_discovery` (literature, claims, provenance, hypotheses, concept graphs, analogy, lineage, meta-analysis) |
|---|---|
| Depends on | M1, parts of M2 |
| Milestone | **M4**: scaling-law fit recovers synthetic parameters; IRT recovers item parameters; meta-analysis matches a published reference |
| Stop if | the owner wants a different capability taxonomy; update the TOML before P078 |

### Phase 5: Experiment infrastructure and independent verification (P046 to P058)

| Deliverables | `grit_verify` public types and signing; `grit_lab` specs, state machine, SQLite store, artifacts, audit log, authorization, review, budgets, isolated execution, CLI, reporting; `grit_verify` contracts, statistics, benchmarks, holdouts, contamination, causal inference, audit verification, evaluator process |
|---|---|
| Depends on | M1 (and P039 for the first benchmark) |
| Milestone | **M5**: example experiment runs DRAFT → ARCHIVED with a real signed evaluation; tested bypass attempts all fail |
| Stop if | separation of duties can't be satisfied on the owner's setup (e.g. no second identity); decide procedure before proceeding |

### Phase 6: Alphalytica baseline model (P059 to P081)

| Deliverables | Model config and G0 Transformer, G1 component variants, `grit_data` pipeline (license gate, dedup, leakage-safe splits, tokenizers, shards), training loop, checkpoint and resume, governed training entrypoint, inference stack and benchmarks, quantization and HF export, external API provider, evaluation suites, the real G0 run |
|---|---|
| Depends on | M4 (physics), M5 |
| Milestone | **M6**: G0 exit gate in [model-research-plan.md](specifications/model-research-plan.md): bit-identical resume, beats n-gram baselines on bpb, signed evaluation, reviewed model card; MPS throughput measured |
| Stop if | no corpus passes the license gate; choose another before training |

### Phase 7: Controlled model research (P098 to P104, P117)

| Deliverables | GPU worker image, signed bundles, object storage, GPU lifecycle with guaranteed shutdown (pulled forward from deployment because G1/G2 need it); G1 studies; G2 baselines; optional alternative architectures; G3 specification; G3 training if approved; optional MLX backend |
|---|---|
| Depends on | M6, P097 |
| Milestone | **M9**: G1 studies VERIFIED with a synthesis; G2 decision; G3 go/no-go recorded |
| Stop if | G2 shows scale isn't needed for the open questions (no-go is a valid result); budget exhausted; evaluation contamination found |

### Phase 8: Research Studio (P082 to P094)

| Deliverables | API service, 50 instrument endpoints, lab/verify/model endpoints, frontend scaffold and tokens, board navigation, instrument framework, visualization primitives, 50 instruments, 12 workspaces, notebooks and tutorials |
|---|---|
| Depends on | M5 (API over lab and verify), M2 to M4 for instruments, M6 for model workspaces |
| Milestone | **M7**: 50 instruments and 12 workspaces usable; axe clean; performance budgets met; 5 tutorials execute in CI |
| Stop if | interactive instruments miss p95 < 500 ms; profile the compute functions before adding infrastructure |

### Phase 9: Deployment (P095 to P097, P105 to P107)

| Deliverables | Grand Chessboard integration, local profile, container images and single server, production hardening, multi-user production (conditional), scaling plan (conditional) |
|---|---|
| Depends on | M7 |
| Milestone | **M8**: Profiles 1 and 2 live; backup restored; GPU dry run (P099) self-terminated |
| Stop if | ADR-0011 triggers haven't fired; Profiles 4 and 5 stay documented, not built |

### Phase 10: Integration and scientific validation (P108 to P116)

| Deliverables | Threat model and security suite, supply chain integrity, reliability drills, docs site, cards and traceability, e2e scientific and model paths, governance bypass tests, independent replication of G0 |
|---|---|
| Depends on | M7, M8 |
| Milestone | **M10**: all e2e suites green; all bypass attempts denied; G0 independently replicated within tolerance; acceptance matrix complete |
| Stop if | replication fails; diagnose and fix before claiming any result as reproducible |

## Tasks requiring human review

From the catalog (full list with reasons in [manifests/EXECUTION_PLAN.md](manifests/EXECUTION_PLAN.md#human-review-required)). The ones that block on an owner decision, not just a review:

| Prompt | Decision |
|---|---|
| P056 | Commit the first protected benchmark |
| P062 | Maintain the SPDX allowlist |
| P076 | Allow an external API in an evaluation protocol |
| P081 | Choose and license-verify the G0 corpus; review and authorize G0 |
| P099 | Approve ≤ 1 GPU-hour dry run; confirm termination |
| P100, P101 | Approve each study's budget; accept or reject results |
| P102 | Approve alternative-architecture proposals |
| P103, P104 | Go/no-go on Generation 3; budget |
| P105, P106 | Production secrets choice; production deploys |
| P115, P116 | Accept governance and replication results |

## What can run in parallel (summary)

After P018, three tracks open at once and stay mostly independent until Phase 6:

- **Mathematics and biology:** P019 to P035.
- **Measurement sciences:** P036 to P045.
- **Governance:** P046 to P058.

Within each, the wave table shows finer parallelism. Shared-file conflicts are almost entirely `Makefile`, `pyproject.toml` and per-package `__init__.py`/registry files; the coordination table lists each one.

## Sequential by nature

- Anything on the critical path (see EXECUTION_PLAN).
- Real training and evaluation runs on the same hardware (P081, P100, P101, P104): one at a time.
- Store migrations (P048 0001, P050 0002, P093 0003, P095 0004, P106 0005): numbered in that order.

## Integration test matrix and acceptance

See [specifications/testing.md](specifications/testing.md) (integration matrix and milestones) and [manifests/acceptance.json](manifests/acceptance.json) (per prompt).
