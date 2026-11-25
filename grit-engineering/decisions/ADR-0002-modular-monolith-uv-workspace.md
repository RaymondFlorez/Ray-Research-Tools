# ADR-0002: Modular monolith as a uv workspace

Status: proposed · Date: 2026-11-25

## Context
Ten scientific families plus model infrastructure. They need different dependencies (`grit_core` must stay free of torch; `alphalytica` needs torch). They don't need separate deployment.

## Decision
One repository, one lockfile, a uv workspace whose members are discovered by glob (`packages/*`, `models/*`, `services/*`), so adding a package doesn't edit the root `pyproject.toml`. Each package has its own `pyproject.toml` declaring only its own dependencies. One API process, one frontend, one database. No microservices.

## Alternatives
Single distribution with subpackages: simpler, but torch would leak into every install and dependency boundaries couldn't be declared. Separate repositories: release overhead with no benefit at this size.

## Consequences
`uv sync --all-packages` installs everything for development; deployment images install only what they need (`uv sync --package grit-api`).
