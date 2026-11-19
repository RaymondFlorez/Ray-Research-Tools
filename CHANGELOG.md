# Changelog

## v0.1.0 — first release

The full 12-step build from `docs/BUILD_PROMPTS.md`.

- **Foundation:** pnpm monorepo, strict TypeScript, ESLint/Prettier, CI.
- **Scene State:** Zod schema, derived types, validated JSON Patch engine.
- **Globe:** deck.gl `GlobeView` renderer behind a swappable interface; scene-driven
  camera, layers, time and selection.
- **Layers:** adapters for GeoJSON, scatterplot, column, heatmap, arc and vector/raster
  tiles; color scales; attribute and time filters.
- **Data Service:** catalog, geo query, guarded read-only SQL, MVT tiles; PostGIS and
  in-memory repositories.
- **Interactivity:** picking, inspector, timeline scrubber.
- **Agent:** Anthropic tool loop with model routing, prompt caching and streaming over
  WebSocket; golden-trace tests.
- **RAG:** geo-tagged retrieval with hashing embeddings; in-memory and pgvector stores.
- **Tools:** MCP client with namespaced tools; action tools (web fetch, geocode);
  scoped, rate-limited gateway.
- **Hardening:** JWT auth with scopes, patch guard, output truncation, traces with
  token and cost accounting.
- **Performance and polish:** server query cache (Redis or in-memory), viewport culling,
  zoom-based decimation, status badges, legends, light and dark themes, command palette,
  mobile layout, code splitting with a CI bundle budget.
- **Packaging:** web, api and db images; production Compose; Kubernetes base; typed and
  validated production config; forward-only migration runner; token issuing; a smoke
  test that runs one NL query end to end; deployment docs and migration runbook.
