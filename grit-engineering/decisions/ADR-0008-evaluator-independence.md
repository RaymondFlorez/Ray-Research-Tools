# ADR-0008: Independent evaluator: code, process, data and keys

Status: proposed · Date: 2026-11-25

## Decision
- Code: `grit_verify` imports only `grit_core` (+ `cryptography`). It defines `grit_verify.protocols.TextModel`; model packages implement it (dependency inversion).
- Process: evaluation runs only via the `grit-eval` entrypoint, never inside a training process.
- Data: holdouts live in `GRIT_EVAL_DIR` (0700) or an evaluator-only bucket; never mounted in Z5 workers.
- Keys: results are signed with an Ed25519 key that only the evaluator host holds; public keys are committed.
- Protocols: frozen and hashed at authorization; the evaluator refuses mismatched requests.

## Consequences
Evaluating requires a deliberate, authorized request. On a single laptop the separation is procedural plus file permissions, and the docs say so.
