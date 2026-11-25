# ADR-0001: GRIT lives in a dedicated repository

Status: proposed · Date: 2026-11-25

## Context
Ray-Research-Tools is a TypeScript/Rust workspace for the Picasso canvas and pricing engine. GRIT is Python-first, has its own release cycle, its own governance (audit, authorization, evaluator keys) and will hold large research artifacts by reference.

## Decision
Create a new repository `grit`. This `grit-engineering/` folder is its seed: P001 copies `AGENTS.md`, `architecture/layers.toml`, `decisions/`, `specifications/` and `manifests/` into it. All prompt paths are relative to the `grit` repository root. If the owner prefers a single repository, the fallback is a top-level `grit/` directory inside Ray-Research-Tools with its own `pyproject.toml`; every prompt still works because paths are relative to the GRIT root.

## Consequences
Independent CI and permissions. Shared design tokens with the Grand Chessboard become a small published package instead of a workspace import. One more repository to maintain.
