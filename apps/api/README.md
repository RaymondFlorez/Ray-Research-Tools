# @geoglobe/api (placeholder)

Backend API gateway + data service + LLM agent orchestration.

Planned stack (see `../../docs/ARCHITECTURE.md §4`): **FastAPI (Python)** fronting
PostGIS / pgvector / Redis, with the agent tool loop in `agent/`.

This is a placeholder. The real service is built in `docs/BUILD_PROMPTS.md` Step 5
onward. It is intentionally **not** part of the pnpm workspace (different language
toolchain); CI builds the JS/TS workspace, and Python checks are added in Step 5.
