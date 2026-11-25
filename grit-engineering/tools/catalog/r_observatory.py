"""Groups T, R, S: API, Research Studio frontend, visualization (Phase 8)."""

from .model import prompt

API = "services/api/src/grit_api"
APT = "services/api/tests"
OBS = "apps/observatory"
OSRC = "apps/observatory/src"
OSPEC = "grit-engineering/specifications/observatory.md"

prompt(
    82, "API service skeleton", "T", 8,
    objective="Create `services/api` (package `grit_api`): FastAPI app factory, settings from environment, versioned `/api/v1`, health and readiness, problem+json errors, request IDs, structured JSON logging, and an OpenAPI snapshot test.",
    context="One API process (ADR-0002). The frontend reaches Python only through it.",
    deps=[53, 58],
    inspect=[OSPEC + " (interface contracts)", "grit-engineering/specifications/deployment.md (environment variables)"],
    scope=["`app.py` factory; `settings.py` (pydantic-settings, GRIT_* variables); `errors.py` (RFC 9457); `logging.py`; `routes/health.py`.", "Local dev identity: `GRIT_ACTOR` header-free mode only when `GRIT_ENV=dev` (refused otherwise).", "`openapi.json` snapshot committed; contract test fails on unreviewed changes; `make openapi` regenerates."],
    out=["Compute endpoints (P083).", "OIDC (P095)."],
    constraints=["Add fastapi, uvicorn, pydantic-settings only."],
    create={"services/api/pyproject.toml": "package metadata", f"{API}/__init__.py": "package root", f"{API}/app.py": "app factory", f"{API}/settings.py": "settings", f"{API}/errors.py": "problem+json errors", f"{API}/logging.py": "structured logging", f"{API}/routes/__init__.py": "routes", f"{API}/routes/health.py": "health and readiness", "services/api/openapi.json": "committed OpenAPI snapshot", f"{APT}/test_health.py": "tests", f"{APT}/test_openapi_contract.py": "OpenAPI snapshot test"},
    modify={"Makefile": "dev-api and openapi targets"},
    tests=["Health returns 200 with version and commit.", "Unhandled error → problem+json 500 without stack trace in body.", "Dev identity refused when GRIT_ENV=prod."],
    verify=["uv sync --all-packages", "uv run pytest services/api -q", "make check"],
    acceptance=["OpenAPI snapshot test in CI.", "Logs are JSON with request id."],
    complexity="M",
    review=["security"],
)

prompt(
    83, "Instrument registry and compute endpoints", "T", 8,
    objective="Add the instrument registry (manifests binding pydantic input schemas to pure L2 functions) and `/api/v1/instruments`, `/schema`, `/compute/{id}` and `/jobs/{id}` with CPU time limits, size limits, input-hash caching and provenance on every result.",
    context="Server computes, client renders (ADR-0014). Every result carries units, assumptions, provenance and the synthetic flag.",
    deps=[82, 28, 35, 39, 42, 45, 22],
    inspect=[OSPEC + " (instrument contract, catalog)"],
    scope=["`instruments/registry.py`: `InstrumentManifest`, `register`, lookup.", "`instruments/catalog/*.py`: manifests for all 50 instruments (compute functions wrap existing package functions; no new science here).", "Compute execution in a worker process pool with per-call timeout by cost class; `batch` class submits a job via grit_lab executor.", "LRU + on-disk cache keyed by (instrument id, input hash, code version)."],
    out=["Frontend rendering."],
    create={f"{API}/instruments/__init__.py": "instrument package", f"{API}/instruments/registry.py": "registry and manifest type", f"{API}/instruments/catalog/__init__.py": "imports all manifests", f"{API}/instruments/catalog/mathematics.py": "MA1 to MA5", f"{API}/instruments/catalog/physics.py": "PH1 to PH5", f"{API}/instruments/catalog/biochemistry.py": "BC1 to BC5", f"{API}/instruments/catalog/evolution.py": "EV1 to EV5", f"{API}/instruments/catalog/neuroscience.py": "NE1 to NE5", f"{API}/instruments/catalog/cognition.py": "CO1 to CO5", f"{API}/instruments/catalog/dynamics.py": "DY1 to DY5", f"{API}/instruments/catalog/metascience.py": "MS1 to MS5", f"{API}/instruments/catalog/verification.py": "VE1 to VE5", f"{API}/instruments/catalog/education.py": "ED1 to ED5", f"{API}/routes/instruments.py": "instrument and compute routes", f"{APT}/test_instruments_compute.py": "every instrument computes with defaults"},
    modify={f"{API}/app.py": "mount routes", "services/api/openapi.json": "regenerated"},
    tests=["Every one of 50 instruments returns a valid result with default parameters within its cost-class budget.", "Oversized inputs rejected with 422 and field names.", "Timeout returns 504 problem+json.", "Cache hit returns identical provenance."],
    verify=["uv run pytest services/api -q", "make check"],
    acceptance=["50 manifests registered, each with concept ids, units, assumptions and synthetic flag.", "Symbolic inputs go through grit_algebra's safe parser only."],
    complexity="L",
    review=["security"],
)

prompt(
    84, "Experiment, run, evaluation, registry and model endpoints", "T", 8,
    objective="Add read endpoints for experiments, runs, metrics, signed evaluations, the concept registry and models, and authorized, audited write endpoints for experiment transitions and reviews.",
    context="The API is a thin authorized shell over grit_lab and grit_verify; decisions stay in their pure functions.",
    deps=[83, 71],
    inspect=[OSPEC + " (interface contracts)", "grit-engineering/specifications/security.md (roles)"],
    scope=["Routes: experiments (list, get, history, transition, review), runs (get, metrics as Arrow IPC or JSON), evaluations (signature verified server-side), registry concepts, models (verified only unless model:experimental), `/models/{id}/generate` with limits.", "Authorization dependency calling `grit_lab.authorization.authorize` per endpoint."],
    out=["Authentication provider (P095)."],
    create={f"{API}/routes/experiments.py": "experiment routes", f"{API}/routes/runs.py": "run routes", f"{API}/routes/evaluations.py": "evaluation routes", f"{API}/routes/registry.py": "registry routes", f"{API}/routes/models.py": "model routes", f"{API}/auth.py": "authorization dependency", f"{APT}/test_experiment_endpoints.py": "tests", f"{APT}/test_authz_endpoints.py": "authorization matrix over endpoints", f"{APT}/test_generate_endpoint.py": "tests"},
    modify={f"{API}/app.py": "mount routes", "services/api/openapi.json": "regenerated"},
    tests=["Every write endpoint denies without role (matrix).", "Transition via API writes audit event.", "Unverified model invisible without permission.", "Generated text returned as plain string field (no HTML)."],
    verify=["uv run pytest services/api -q", "make check"],
    acceptance=["Endpoint authorization matrix test covers 100% of write routes."],
    complexity="L",
    review=["security"],
)

prompt(
    85, "Observatory frontend scaffold, design tokens and shell", "R", 8,
    objective="Create `apps/observatory`: Vite + React + TypeScript strict, ESLint (with a rule banning `dangerouslySetInnerHTML`), Vitest, Playwright with axe, design tokens for dark and light themes, self-hosted IBM Plex fonts, generated API types, and the application shell.",
    context="Restrained scientific terminal (observatory.md visual system).",
    deps=[82],
    inspect=[OSPEC + " (principles, stack, visual system, component tree)"],
    scope=["Project scaffold, `npm` scripts: dev, build, test, e2e, typecheck, lint.", "`src/theme/tokens.css` (both themes), validated palette (contrast test in Vitest computing WCAG ratios).", "`src/api/` generated with openapi-typescript from `services/api/openapi.json`; TanStack Query client.", "Shell: TopBar, SideNav, Main, theme toggle, Toasts; strict CSP meta for production build.", "CI job for the app."],
    out=["Board navigation and palette (P086).", "Instruments (P087 onward)."],
    create={f"{OBS}/package.json": "app manifest", f"{OBS}/package-lock.json": "lockfile", f"{OBS}/tsconfig.json": "TypeScript config", f"{OBS}/vite.config.ts": "Vite config", f"{OBS}/eslint.config.js": "lint config", f"{OBS}/playwright.config.ts": "e2e config", f"{OBS}/index.html": "entry", f"{OSRC}/main.tsx": "bootstrap", f"{OSRC}/App.tsx": "providers and router", f"{OSRC}/theme/tokens.css": "design tokens", f"{OSRC}/theme/palette.test.ts": "contrast tests", f"{OSRC}/api/schema.ts": "generated API types", f"{OSRC}/api/client.ts": "API client", f"{OSRC}/shell/Shell.tsx": "app shell", f"{OBS}/public/fonts/README.md": "font licenses (OFL)", f"{OBS}/e2e/shell.spec.ts": "shell e2e with axe", ".github/workflows/observatory.yml": "frontend CI"},
    modify={"Makefile": "dev-web target; `make dev` runs API and web"},
    tests=["All token pairs meet WCAG AA in both themes.", "axe: no serious or critical violations on the shell.", "Lint fails on dangerouslySetInnerHTML (fixture)."],
    verify=["cd apps/observatory && npm ci && npm run typecheck && npm run lint && npm test && npx playwright test", "make check"],
    acceptance=["Shell JS < 200 KB gzipped.", "Both themes pass contrast tests."],
    complexity="M",
)

prompt(
    86, "Board navigation, command palette, keyboard model and workspace routing", "R", 8,
    objective="Add the 10 × 5 board home screen, ⌘K command palette, `g`-prefixed workspace shortcuts, full keyboard navigation and routes for all 12 workspaces.",
    context="Chessboard-inspired navigation without gimmicks: square cells, coordinates on edges, arrow keys move.",
    deps=[85],
    inspect=[OSPEC + " (navigation, workspaces)"],
    scope=["`src/board/Board.tsx` driven by `/api/v1/instruments`.", "`src/palette/CommandPalette.tsx` searching instruments, experiments, runs, concepts.", "`src/keyboard/` shortcut registry with a help overlay (`?`).", "Routes for 12 workspaces with placeholder-free empty states (each shows what data it will show and how to create it)."],
    out=["Workspace contents (P092, P093)."],
    create={f"{OSRC}/board/Board.tsx": "board", f"{OSRC}/board/Board.test.tsx": "tests", f"{OSRC}/palette/CommandPalette.tsx": "command palette", f"{OSRC}/keyboard/shortcuts.ts": "shortcut registry", f"{OSRC}/routes.tsx": "route table", f"{OBS}/e2e/keyboard.spec.ts": "keyboard-only e2e"},
    modify={f"{OSRC}/App.tsx": "routes"},
    tests=["Keyboard-only e2e: reach any instrument and any workspace without the mouse.", "Focus visible on every interactive element (axe + screenshot)."],
    verify=["cd apps/observatory && npm test && npx playwright test e2e/keyboard.spec.ts"],
    acceptance=["Every action reachable without a mouse."],
    complexity="M",
)

prompt(
    87, "Instrument framework: parameter panels, result views and provenance", "R", 8,
    objective="Add the instrument host: JSON-Schema-driven parameter panels showing units, debounced compute calls, result views by output kind, the assumptions list, the provenance drawer, SYNTHETIC/EMPIRICAL badges and export (SVG, PNG, CSV, JSON, figure bundle).",
    context="Each instrument is independently mountable at its own URL; parameters live in the URL.",
    deps=[86, 83],
    inspect=[OSPEC + " (instrument contract)"],
    scope=["`src/instruments/InstrumentPage.tsx`, `ParameterPanel.tsx`, `ResultView.tsx` (dispatch by output_kind), `ProvenanceDrawer.tsx`, `ExportMenu.tsx`.", "URL state sync for parameters; batch instruments poll jobs."],
    out=["Chart primitives (P088)."],
    create={f"{OSRC}/instruments/InstrumentPage.tsx": "instrument page", f"{OSRC}/instruments/ParameterPanel.tsx": "parameter panel", f"{OSRC}/instruments/ResultView.tsx": "result dispatch", f"{OSRC}/instruments/ProvenanceDrawer.tsx": "provenance drawer", f"{OSRC}/instruments/ExportMenu.tsx": "export", f"{OSRC}/instruments/instruments.test.tsx": "tests", f"{OBS}/e2e/instruments.spec.ts": "e2e"},
    tests=["Changing a parameter updates URL and result.", "Provenance drawer shows code version, input hash, concept ids.", "SYNTHETIC badge present for synthetic results.", "Export bundle includes provenance JSON."],
    verify=["cd apps/observatory && npm test && npx playwright test e2e/instruments.spec.ts"],
    acceptance=["No result renders without provenance (type-level and test)."],
    complexity="M",
)

prompt(
    88, "Scientific visualization primitives", "S", 8,
    objective="Add `src/viz`: D3-based Figure, Axis (unit required by type), LinePlot with CI bands, Scatter, Heatmap with color scale legend, Histogram, PhasePortrait (vector field, nullclines, trajectories), BifurcationPlot (Canvas), Raster (Canvas), NetworkGraph (d3-force), ReliabilityDiagram; LTTB downsampling.",
    context="Scientific charts, not decoration. Units, assumptions and provenance are props, not afterthoughts.",
    deps=[87],
    inspect=[OSPEC + " (visual system, performance budgets)"],
    scope=["Components with typed props; `unit: string` required on every axis; colorblind-safe palettes; Canvas for > 5,000 marks.", "Storybook is out; a `/dev/viz` route renders each primitive with fixtures for visual regression screenshots."],
    out=["Instrument-specific compositions (P089 to P091)."],
    create={f"{OSRC}/viz/Figure.tsx": "figure container", f"{OSRC}/viz/Axis.tsx": "axis with required unit", f"{OSRC}/viz/LinePlot.tsx": "lines with CI bands", f"{OSRC}/viz/Scatter.tsx": "scatter", f"{OSRC}/viz/Heatmap.tsx": "heatmap", f"{OSRC}/viz/Histogram.tsx": "histogram", f"{OSRC}/viz/PhasePortrait.tsx": "phase portrait", f"{OSRC}/viz/BifurcationPlot.tsx": "bifurcation plot (canvas)", f"{OSRC}/viz/Raster.tsx": "spike raster (canvas)", f"{OSRC}/viz/NetworkGraph.tsx": "network graph", f"{OSRC}/viz/ReliabilityDiagram.tsx": "reliability diagram", f"{OSRC}/viz/lttb.ts": "downsampling", f"{OSRC}/viz/viz.test.tsx": "tests", f"{OSRC}/dev/VizGallery.tsx": "fixture gallery for screenshots", f"{OBS}/e2e/viz.spec.ts": "visual regression and performance"},
    tests=["Axis without unit is a type error (tsd-style compile test).", "LTTB preserves extremes.", "100k-point line renders and pans at ≥ 55 fps in Playwright trace.", "Visual regression screenshots for each primitive in both themes."],
    verify=["cd apps/observatory && npm run typecheck && npm test && npx playwright test e2e/viz.spec.ts"],
    acceptance=["Performance budgets met (observatory.md).", "Screenshots committed as baselines."],
    complexity="L",
)

prompt(
    89, "Instruments: Mathematics, Physics and Dynamical Systems labs", "S", 8,
    objective="Compose the 15 instruments of the Mathematics (MA1 to MA5), Physics (PH1 to PH5) and Dynamical Systems (DY1 to DY5) labs from viz primitives, with instrument-specific result views where the generic view isn't enough.",
    context="Each instrument is independently usable and shows units, assumptions and provenance.",
    deps=[88],
    inspect=[OSPEC + " (instrument catalog)"],
    scope=["Instrument views under `src/labs/{mathematics,physics,dynamics}/`.", "MA4 symbolic scratchpad shows parser errors inline; DY3 phase portrait supports clicking to launch a trajectory; DY4 bifurcation plot uses Canvas."],
    out=["Other labs."],
    create={f"{OSRC}/labs/mathematics/index.tsx": "MA1 to MA5 views", f"{OSRC}/labs/physics/index.tsx": "PH1 to PH5 views", f"{OSRC}/labs/dynamics/index.tsx": "DY1 to DY5 views", f"{OBS}/e2e/labs-math-physics-dynamics.spec.ts": "e2e for 15 instruments"},
    tests=["Each instrument loads with defaults, renders, and passes axe.", "Interactive instruments meet p95 < 500 ms locally."],
    verify=["cd apps/observatory && npx playwright test e2e/labs-math-physics-dynamics.spec.ts"],
    acceptance=["15 instruments usable standalone at their URLs."],
    complexity="L",
)

prompt(
    90, "Instruments: Biochemistry, Evolution and Neuroscience labs", "S", 8,
    objective="Compose the 15 instruments of the Biochemistry (BC1 to BC5), Evolution (EV1 to EV5) and Neuroscience (NE1 to NE5) labs, forming the Biological Simulation and Neuroscience Laboratory workspaces.",
    context="Educational simulations of documented models; the parameter source citation appears in the assumptions list.",
    deps=[88],
    inspect=[OSPEC + " (instrument catalog)"],
    scope=["Views under `src/labs/{biochemistry,evolution,neuroscience}/`; EV5 shows dataset citation; NE5 raster with Canvas."],
    out=["Other labs."],
    create={f"{OSRC}/labs/biochemistry/index.tsx": "BC views", f"{OSRC}/labs/evolution/index.tsx": "EV views", f"{OSRC}/labs/neuroscience/index.tsx": "NE views", f"{OBS}/e2e/labs-bio-neuro.spec.ts": "e2e for 15 instruments"},
    tests=["Each instrument loads with defaults, renders, and passes axe.", "Citations visible for literature parameter sets."],
    verify=["cd apps/observatory && npx playwright test e2e/labs-bio-neuro.spec.ts"],
    acceptance=["15 instruments usable standalone."],
    complexity="L",
)

prompt(
    91, "Instruments: Cognition, Metascience, Verification and Education labs", "S", 8,
    objective="Compose the 20 instruments of the Cognition (CO1 to CO5), Metascience (MS1 to MS5), Verification (VE1 to VE5) and Education (ED1 to ED5) labs, forming the Intelligence Observatory workspace.",
    context="Empirical instruments show dataset or run provenance; ED3 uses public dev splits only.",
    deps=[88, 84],
    inspect=[OSPEC + " (instrument catalog)"],
    scope=["Views under `src/labs/{cognition,metascience,verification,education}/`; VE5 runs audit verification through the API and shows the first bad event if any."],
    out=["Workspace pages (P092, P093)."],
    create={f"{OSRC}/labs/cognition/index.tsx": "CO views", f"{OSRC}/labs/metascience/index.tsx": "MS views", f"{OSRC}/labs/verification/index.tsx": "VE views", f"{OSRC}/labs/education/index.tsx": "ED views", f"{OBS}/e2e/labs-cog-meta-verify-edu.spec.ts": "e2e for 20 instruments"},
    tests=["Each instrument loads, renders, passes axe.", "ED3 never requests protected splits (API test asserts benchmark split = dev)."],
    verify=["cd apps/observatory && npx playwright test e2e/labs-cog-meta-verify-edu.spec.ts"],
    acceptance=["All 50 instruments now usable."],
    complexity="L",
    review=["security"],
)

prompt(
    92, "Model Laboratory, Training Dashboard, Inference Benchmarking and Experiment Registry workspaces", "R", 8,
    objective="Build the four model-facing workspaces: model registry with configs, parameter counts and cards; live and historical training runs with loss curves and budget burn; inference benchmark tables and charts; and the experiment registry with state machine view, reviews and reports.",
    context="Training dashboards read metrics; they never control training. State transitions go through authorized API calls with confirmation dialogs.",
    deps=[88, 84, 74],
    inspect=[OSPEC + " (workspaces)"],
    scope=["Pages under `src/workspaces/{models,training,inference,experiments}/`.", "Experiment transition buttons only shown for permitted actions (from API), with confirm dialogs showing spec hash and budget."],
    out=["Starting training from the UI (runs start via authorized executor only)."],
    create={f"{OSRC}/workspaces/models/ModelLab.tsx": "model laboratory", f"{OSRC}/workspaces/training/TrainingDashboard.tsx": "training dashboard", f"{OSRC}/workspaces/inference/InferenceBench.tsx": "inference benchmarking", f"{OSRC}/workspaces/experiments/ExperimentRegistry.tsx": "experiment registry", f"{OBS}/e2e/workspaces-model.spec.ts": "e2e"},
    tests=["Loss curve with 100k points interactive.", "Transition denied server-side is shown as error, not hidden.", "axe clean."],
    verify=["cd apps/observatory && npx playwright test e2e/workspaces-model.spec.ts"],
    acceptance=["G0 run from P081 fully browsable."],
    complexity="L",
)

prompt(
    93, "Library, Knowledge Graph, Publication Studio and Learning workspaces", "R", 8,
    objective="Build the Scientific Library (registry concepts, claims, citations), Research Knowledge Graph, Publication Studio (assemble text, figures and citations into an exportable bundle) and Learning and Mastery (curricula of instruments with exercises, per-user progress).",
    context="Publication exports are reproducible: same inputs, same bytes.",
    deps=[88, 84],
    inspect=[OSPEC + " (workspaces)", "grit-engineering/specifications/documentation-standards.md"],
    scope=["Pages under `src/workspaces/{library,graph,publish,learn}/`.", "API additions: `/api/v1/publications` (bundle export) and `/api/v1/progress` (per-user curriculum progress, SQLite table via grit_lab store migration 0003)."],
    out=["PDF generation (optional via pandoc in P112)."],
    create={f"{OSRC}/workspaces/library/Library.tsx": "library", f"{OSRC}/workspaces/graph/KnowledgeGraph.tsx": "knowledge graph", f"{OSRC}/workspaces/publish/PublicationStudio.tsx": "publication studio", f"{OSRC}/workspaces/learn/Learning.tsx": "learning and mastery", f"{API}/routes/publications.py": "publication export", f"{API}/routes/progress.py": "curriculum progress", "packages/grit_lab/src/grit_lab/store/migrations/0003_progress.sql": "progress table", "packages/grit_lab/src/grit_lab/store/migrations/0003_progress.down.sql": "rollback", "curricula/entropy-to-learning.toml": "ED1 curriculum", "curricula/dynamics-to-neurons.toml": "ED2 curriculum", f"{OBS}/e2e/workspaces-knowledge.spec.ts": "e2e"},
    modify={"services/api/openapi.json": "regenerated", f"{API}/app.py": "mount routes"},
    tests=["Export bundle byte-identical across two exports.", "Knowledge graph with 2,000 nodes interactive.", "Progress isolated per user."],
    verify=["uv run pytest services/api -q", "cd apps/observatory && npx playwright test e2e/workspaces-knowledge.spec.ts", "make check"],
    acceptance=["All 12 workspaces functional (milestone M7 with P094)."],
    complexity="L",
)

prompt(
    94, "Reproducible notebooks and tutorials (milestone M7)", "R", 8,
    objective="Set the notebook standard (provenance header, seeds, no hidden state, stripped outputs), write five tutorials, execute them in CI, publish them in the ED5 gallery, and close Phase 8.",
    context="Notebooks are research instruments too; they must reproduce.",
    deps=[93, 91, 89, 90, 92],
    inspect=["grit-engineering/specifications/documentation-standards.md (notebooks)"],
    scope=["`notebooks/README.md` standard; `nbstripout` pre-commit config; CI job executing `notebooks/tutorials/*.ipynb` with nbclient (< 5 min total).", "Tutorials: entropy and divergence; phase portraits and bifurcations; a neuron to a circuit; fitting a learning curve; reading a G0 evaluation report.", "`docs/milestones/M7.md`."],
    out=["JupyterHub deployment."],
    constraints=["Add jupyter, nbclient, nbstripout to a `notebooks` dependency group only."],
    create={"notebooks/README.md": "notebook standard", "notebooks/tutorials/01-entropy.ipynb": "tutorial", "notebooks/tutorials/02-dynamics.ipynb": "tutorial", "notebooks/tutorials/03-neurons.ipynb": "tutorial", "notebooks/tutorials/04-learning-curves.ipynb": "tutorial", "notebooks/tutorials/05-reading-an-evaluation.ipynb": "tutorial", "scripts/run_notebooks.py": "notebook executor", ".pre-commit-config.yaml": "pre-commit hooks (nbstripout, gitleaks)", "docs/milestones/M7.md": "Phase 8 milestone report"},
    modify={"pyproject.toml": "notebooks dependency group", ".github/workflows/ci.yml": "notebook job (nightly)"},
    tests=["All tutorials execute top to bottom on a clean kernel.", "First cell prints provenance."],
    verify=["uv run --group notebooks python scripts/run_notebooks.py", "make check"],
    acceptance=["M7: 50 instruments, 12 workspaces, a11y clean, budgets met, 5 tutorials executing."],
    complexity="M",
)

prompt(
    95, "Grand Chessboard integration: OIDC, module manifest and shared tokens", "T", 9,
    objective="Integrate with The Grand Chessboard: OIDC login (GRIT as its own client), identity-to-role mapping owned by GRIT, `module-manifest.json`, a route-level bundle the Chessboard shell can mount, shared design tokens, and graceful degradation.",
    context="Independent deployability first; integration second. Tokens are never forwarded between apps.",
    deps=[94, 84],
    inspect=["grit-engineering/specifications/deployment.md (Grand Chessboard integration)"],
    scope=["`grit_api/oidc.py` (Authlib): authorization code + PKCE, session cookies (secure, httpOnly, SameSite=strict), JWKS caching, audience check.", "Users table and role mapping (migration 0004).", "`apps/observatory/public/module-manifest.json` generated at build.", "Health-based degradation banner when the API is unavailable.", "Integration guide for the Chessboard team."],
    out=["Changes to the Chessboard codebase."],
    constraints=["Add `authlib` to grit_api only."],
    create={f"{API}/oidc.py": "OIDC login", "packages/grit_lab/src/grit_lab/store/migrations/0004_users.sql": "users and role mapping", "packages/grit_lab/src/grit_lab/store/migrations/0004_users.down.sql": "rollback", f"{OBS}/scripts/module-manifest.mjs": "manifest generator", "docs/guides/grand-chessboard-integration.md": "integration guide", f"{APT}/test_oidc.py": "tests with a mock issuer"},
    modify={f"{API}/auth.py": "OIDC principals", "services/api/pyproject.toml": "authlib", f"{OBS}/package.json": "manifest generation in build"},
    tests=["Token with wrong audience rejected.", "Expired token rejected.", "Chessboard role claims grant nothing by themselves.", "Mock issuer login flow e2e."],
    verify=["uv run pytest services/api -q", "make check"],
    acceptance=["GRIT works standalone with OIDC and embedded via manifest.", "Security review recorded."],
    complexity="L",
    review=["security"],
)
