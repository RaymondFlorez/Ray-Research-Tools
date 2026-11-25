# ADR-0006: Content-addressed artifact store

Status: proposed · Date: 2026-11-25

## Decision
Every artifact (checkpoint file, shard, report, figure) is stored by the sha256 of its bytes under `artifacts/sha256/<2>/<2>/<hash>`. Writes go to a temp file then `os.replace`. Directory-shaped artifacts (checkpoints) are a manifest file listing member hashes; the manifest's hash is the artifact id. The same key scheme maps onto S3-compatible object storage.

## Why
Integrity checking is free, deduplication is free, references can't dangle silently, and path traversal is impossible because callers never supply paths.

## Consequences
Human-friendly names live in metadata (`runs`, `artifacts` tables), not in the filesystem.
