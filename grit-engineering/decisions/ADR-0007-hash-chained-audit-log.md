# ADR-0007: Hash-chained append-only audit log

Status: proposed · Date: 2026-11-25

## Decision
Audit events are canonical-JSON lines in monthly files. Each event includes `prev_hash` and its own `hash = sha256(canonical_json(event without hash))`. A SQLite index points at file offsets. `grit-verify audit verify` (in `grit_verify`, reading the documented format, not `grit_lab` code) checks the whole chain. Profile 2+ replicates the files offsite daily.

## Why
Tamper evidence without a blockchain or external service. Verification is independent of the writer.

## Consequences
Rewriting history requires rewriting every subsequent hash and the offsite replica. It's tamper-evident, not tamper-proof; the offsite replica is what makes silent rewriting hard.
