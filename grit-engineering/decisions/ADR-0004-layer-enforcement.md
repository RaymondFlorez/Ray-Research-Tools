# ADR-0004: Enforce layer rules with a small AST checker

Status: proposed · Date: 2026-11-25

## Context
The dependency rules (for example, `grit_verify` imports only `grit_core`) are the backbone of evaluator independence. They must be checked in CI from day one, including for packages that don't exist yet.

## Decision
`architecture/layers.toml` declares every planned package and its allowed imports. `scripts/check_layers.py` (about 100 lines, stdlib `ast` only) walks every `.py` file, resolves top-level imports to packages, and fails on any edge not allowed. Packages not yet created are ignored.

## Alternatives
import-linter is the established tool and would be the default choice. It's rejected for now because its contracts are written against importable modules, which makes rules for not-yet-created packages awkward, and because our rule set is a flat allowlist that a short script handles exactly. Migration path: if rules grow beyond an allowlist (e.g. independence contracts between subpackages), switch to import-linter.

## Consequences
One small script to maintain, with its own tests (a planted forbidden import must fail).
