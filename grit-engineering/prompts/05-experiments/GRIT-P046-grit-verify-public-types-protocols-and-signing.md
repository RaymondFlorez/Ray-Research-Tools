# GRIT-P046: grit_verify public types, protocols and signing

| Group | Phase | Wave | Complexity | Resources | Review |
|---|---|---|---|---|---|
| L. Independent verification | 5 | 9 | M | CPU, laptop | security |

## Prompt identifier

`GRIT-P046`

## Objective

Create the `grit_verify` package's public surface first: evaluation protocol, request and result types, the `TextModel` protocol models must satisfy, and Ed25519 signing and verification of results.

## Scientific context

ADR-0008: the evaluator owns the contract. `grit_lab` and `alphalytica` may import only `grit_verify.protocols`, `grit_verify.types` and `grit_verify.signing` (layers.toml). Defining these before the lab lets the lab freeze protocol hashes at authorization and verify signatures without importing evaluation logic.

## Prerequisites

- `GRIT-P018` Numerical reference suite and micro-benchmarks (milestone M1) (must be `done`)

## Existing repository context

Read before changing anything:

- `AGENTS.md`
- `prompts/status.json` (once GRIT-P006 is done)
- grit-engineering/specifications/scientific-modules.md section 8
- `grit-engineering/specifications/evaluation.md`
- `grit-engineering/decisions/ADR-0008-evaluator-independence.md`
- `architecture/layers.toml`

## Scope

- Package skeleton (deps: grit-core, cryptography).
- `types.py`: `EvaluationProtocol` (id, version, suites, metrics, acceptance criteria, statistical plan; `content_hash`), `AcceptanceCriterion`, `StatisticalPlan`, `EvaluationRequest`, `EvaluationResult`, `BenchmarkCommitment`, `ModelMetadata`.
- `protocols.py`: `TextModel` protocol (`metadata()`, `score(token_sequences) -> logprobs`, `generate(prompt, config) -> text`), `TokenizerLike` protocol (`encode`, `decode`, `id`, `hash`).
- `signing.py`: `generate_keypair()`, `sign_result(result, private_key) -> SignedResult`, `verify_signed(signed, public_keys) -> bool`; keys loaded from paths given by the caller (never from env inside the library).
- `docs/security/evaluator-keys.md`: key generation, storage, rotation.

## Out of scope

- Evaluation logic and suites (P054 to P058, P077 to P080).

## Architecture constraints

- `grit_verify` imports only `grit_core`, the standard library, numpy, scipy and `cryptography` (ADR-0008).
- Never import or call code from `grit_lab`, `alphalytica`, `grit_data` or any L2 package.
- Evaluation logic must not be configurable by the evaluated model or its training process.
- Add `cryptography` only.
- Protocol hash covers every field that affects scoring.
- Follow AGENTS.md. Add no dependency the prompt doesn't name.
- No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.

## Files to create

| Path | Purpose |
|---|---|
| `packages/grit_verify/pyproject.toml` | package metadata |
| `packages/grit_verify/src/grit_verify/__init__.py` | package root (exports only public types) |
| `packages/grit_verify/src/grit_verify/py.typed` | marker |
| `packages/grit_verify/src/grit_verify/types.py` | protocol, request, result and commitment types |
| `packages/grit_verify/src/grit_verify/protocols.py` | TextModel and TokenizerLike protocols |
| `packages/grit_verify/src/grit_verify/signing.py` | Ed25519 signing and verification |
| `packages/grit_verify/tests/test_types.py` | tests |
| `packages/grit_verify/tests/test_signing.py` | tests |
| `docs/security/evaluator-keys.md` | key management procedure |
| `docs/registry/concepts/grit_verify.toml` | grit_verify registry |

## Files to modify

None.

## Public interfaces

```python
@dataclass(frozen=True, slots=True)
class EvaluationProtocol:
    id: str; version: int; suites: tuple[str, ...]; metrics: tuple[str, ...]
    acceptance: tuple[AcceptanceCriterion, ...]; plan: StatisticalPlan
    @property
    def content_hash(self) -> ContentHash: ...

class TextModel(Protocol):
    def metadata(self) -> ModelMetadata: ...
    def score(self, sequences: Sequence[Sequence[int]]) -> Sequence[FloatArray]: ...
    def generate(self, prompt: str, *, max_new_tokens: int, temperature: float, seed: int | None) -> str: ...

def sign_result(result: EvaluationResult, private_key: Ed25519PrivateKey) -> SignedResult: ...
def verify_signed(signed: SignedResult, public_keys: Mapping[str, Ed25519PublicKey]) -> bool: ...
```

## Implementation requirements

- Implement exactly the scope above, nothing more.

## Testing requirements

- Any change to any protocol field changes its hash.
- Tampering with one byte of a signed result fails verification.
- Unknown key id fails verification.
- Layer check: grit_verify imports only grit_core.

## Verification commands

Run from the repository root and paste the summary lines into the completion report.

```bash
uv sync --all-packages
uv run pytest packages/grit_verify -q
make check
```

## Acceptance criteria

- [ ] Signing round trip works; tamper detection test passes.
- [ ] No torch, no grit_lab imports.

## Failure handling

- A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.
- A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.
- A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.
- A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.
- The work needs a dependency, file or permission not listed here: stop and ask, with the reason.
- Verification commands can't run in your environment: say so explicitly; never report them as passed.

## Completion report

Save to `prompts/reports/GRIT-P046.md` and paste in your final message:

```
Prompt: GRIT-P046  Title: grit_verify public types, protocols and signing
Status: done | partial | blocked
Files created:
Files modified:
Commands run and results:
Acceptance criteria (each: met / not met, with evidence):
Scientific assumptions introduced or changed:
Limitations:
Unresolved issues / blockers:
```

Then: `uv run python scripts/prompt_status.py set GRIT-P046 done` (or `partial` / `blocked`).

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
