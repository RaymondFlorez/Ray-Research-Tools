# ADR-0015: TOML for configs, specs and the registry

Status: proposed · Date: 2026-11-25

## Decision
Experiment specs, model/training/eval configs, dataset manifests, the concept registry, the layer rules and price tables are TOML, read with stdlib `tomllib` and validated into frozen dataclasses. Writing TOML (rare, mostly generated reports) uses `tomli-w`.

## Why
Human-editable, comments allowed, no code execution on load (unlike YAML's unsafe loaders), stdlib reader.
