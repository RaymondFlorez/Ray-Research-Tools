# Ray-Research-Tools

## GeoGlobe — 3‑D Earth globe with data layers + LLM querying

A planned project: an interactive 3‑D globe that renders arbitrary geospatial **data
layers** and lets you **ask questions in natural language**. An LLM agent (RAG,
action, and MCP tools) reads and mutates the rendered scene, treating the globe as a
**queryable visual database**.

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — full architectural layout: system
  diagram, frontend (deck.gl globe), backend, Scene State contract, LLM agent +
  tooling, data stores, and phasing.
- **[docs/BUILD_PROMPTS.md](docs/BUILD_PROMPTS.md)** — a sequence of 12 self-contained
  prompts to generate the project step by step.

Status: design / planning.
