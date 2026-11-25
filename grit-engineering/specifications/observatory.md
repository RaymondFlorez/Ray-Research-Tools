# GRIT Intelligence Observatory: UI and Instrument Architecture

A restrained scientific research terminal. Dark first, compact, typographic, keyboard driven. Charts are instruments, not decoration. Prompts P082 to P095.

## Principles

1. **Server computes, client renders.** All numerical results come from the Python API, so there's one implementation of every equation. The client may interpolate or re-bin for display, never recompute science.
2. **Every number has a unit, an assumption list and provenance.** The chart components won't render an axis without a unit (enforced by TypeScript types). Every result panel has a provenance drawer: code version, input hash, concept IDs, synthetic or empirical, data source.
3. **Synthetic vs empirical is visible.** A synthetic result carries a `SYNTHETIC` badge in the panel header. Empirical results show their dataset id and citation.
4. **Each instrument stands alone.** An instrument is mountable at its own URL (`/lab/dynamics/phase-portrait`), embeddable in a workspace, and exportable as a figure bundle.
5. **Progressive disclosure.** Defaults produce a meaningful result with no configuration. Advanced parameters sit behind a disclosure, and the full request JSON is one keypress away.

## Stack

| Concern | Choice | Reason |
|---|---|---|
| Build | Vite + React 18/19 + TypeScript strict | Standard, fast |
| Routing | React Router (data routers) | URL is the state for instruments and parameters |
| Server state | TanStack Query | Caching keyed by input hash; dedup; cancellation |
| UI state | Zustand (one small store: theme, palette open, layout) | Avoid Redux ceremony |
| Charts | D3 (scales, shapes, axes) rendered to SVG; Canvas for > 5,000 marks | Exact control of scales and units |
| Graphs | d3-force for ≤ 2,000 nodes; WebGL only if profiling demands | |
| API types | `openapi-typescript` generated from FastAPI's OpenAPI | Contract shared, not duplicated |
| Tests | Vitest + Testing Library; Playwright e2e with axe-core | |
| Fonts | Self-hosted: IBM Plex Sans + IBM Plex Mono (OFL) | Legible numerics, tabular figures |

No custom framework, no CSS-in-JS runtime. CSS modules plus design tokens as CSS variables.

## Visual system

- Tokens: `--bg`, `--surface`, `--surface-2`, `--border`, `--text`, `--text-muted`, `--accent`, `--positive`, `--negative`, `--warn`, plus an 8-color categorical palette and sequential/diverging ramps validated for color-vision deficiency (deuteranopia, protanopia, tritanopia) and WCAG AA contrast on both themes.
- Type scale: 12 / 13 / 14 / 16 / 20 / 24 px; tabular numerals everywhere numbers align; monospace for values, hashes and code.
- Density: 4 px grid; panels with 1 px borders, no shadows, no gradients.
- Motion: none except data transitions under 150 ms; respects `prefers-reduced-motion`.

## Navigation: the board

The home screen is a 10 × 5 grid: ten labs as columns (files), five instruments each as rows (ranks). Each cell is a square with the instrument's short code (e.g. `DY3`). Arrow keys move, Enter opens, `?` shows the cell's description. It reads as a chessboard without pretending to be one: square cells, alternating subtle tones, coordinates on the edges.

- `⌘K` / `Ctrl+K`: command palette (instruments, experiments, runs, concepts, docs).
- `g` then a letter: go to workspace (`g m` Mathematics Workbench, `g e` Experiment Registry, …).
- `[` / `]`: previous / next instrument in the lab.
- Every interactive element reachable by Tab, with visible focus rings.

## Workspaces (12)

| Workspace | Route | Contents | Prompt |
|---|---|---|---|
| Scientific Library | `/library` | Registry concepts, definitions, claims, citations | P093 |
| Mathematics Workbench | `/lab/mathematics` | Math lab instruments + symbolic scratchpad | P089 |
| Biological Simulation Laboratory | `/lab/biochemistry`, `/lab/evolution` | Bio instruments | P090 |
| Neuroscience Laboratory | `/lab/neuroscience` | Neuro instruments | P090 |
| Intelligence Observatory | `/lab/cognition` | Capability profiles, generalization, calibration | P091 |
| Model Laboratory | `/models` | Model registry, configs, param counts, cards | P092 |
| Training Dashboard | `/training` | Live and historical runs, loss curves, budgets | P092 |
| Inference Benchmarking | `/inference` | Benchmark tables, latency/throughput charts | P092 |
| Experiment Registry | `/experiments` | State machine view, reviews, reports | P092 |
| Research Knowledge Graph | `/graph` | Concept/claim/evidence graph | P093 |
| Scientific Publication Studio | `/publish` | Assemble report: text, figures, citations, export | P093 |
| Learning and Mastery | `/learn` | Curricula: ordered instruments with exercises | P093 |

## Component tree

```
<App>
  <ThemeProvider>                      tokens, light/dark, reduced motion
  <QueryClientProvider>
  <RouterProvider>
    <Shell>
      <TopBar>  workspace switcher · command palette trigger · user · theme
      <SideNav> labs and workspaces (collapsible)
      <Main>
        <Board/>                                  home grid
        <InstrumentPage instrumentId>             one instrument, full screen
          <InstrumentHeader title badges(SYNTHETIC|EMPIRICAL) conceptIds/>
          <ParameterPanel schema=inputs>          generated from JSON Schema, units shown
          <ResultView>                            instrument-specific, composed from viz
            <Figure> <Axis unit/> <LinePlot|Heatmap|PhasePortrait|…/> </Figure>
            <ResultTable/>
          <AssumptionsList/>
          <ProvenanceDrawer provenance/>
          <ExportMenu/>                           SVG, PNG, CSV, JSON, figure bundle
        <WorkspacePage workspaceId> (layouts of panels and tables per workspace)
      <CommandPalette/>
      <Toasts/>
```

## Instrument contract

Defined once on the server (Python) and exported through OpenAPI:

```python
@dataclass(frozen=True)
class InstrumentManifest:
    id: str                        # "dynamics.phase_portrait"
    lab: LabId                     # one of 10
    code: str                      # "DY3"
    title: str
    summary: str
    concept_ids: tuple[str, ...]
    input_schema: type[BaseModel]  # pydantic model; units in field metadata
    output_kind: OutputKind        # "timeseries" | "field2d" | "matrix" | "graph" | "table" | "distribution" | "scatter"
    compute: Callable[[BaseModel], InstrumentResult]   # pure function from an L2 package
    cost_class: Literal["instant", "interactive", "batch"]   # <50 ms, <500 ms, job
    synthetic: bool
    assumptions: tuple[str, ...]
```

`InstrumentResult` carries `data` (typed per `output_kind`), `units` (per field), `provenance`, `diagnostics` (converged, warnings). The client renders by `output_kind` with instrument-specific overrides where needed. `batch` instruments submit a background job and poll.

## Instrument catalog (50)

Status: **S** synthetic examples only, **E** can show empirical data from registered sources, **S/E** both.

| Lab | Code | Instrument | Backing module | Data |
|---|---|---|---|---|
| Mathematics | MA1 | Probability Distribution Explorer | core.probability | S |
| | MA2 | Entropy and Divergence Analyzer | core.information | S/E |
| | MA3 | Operator Composition Workbench | algebra.composition | S |
| | MA4 | Symbolic Algebra Scratchpad | algebra.symbolic_math | S |
| | MA5 | Fixed Point and Relation Explorer | algebra.fixed_points, relations | S |
| Physics | PH1 | Compute Accounting Calculator | physics.compute_accounting | S |
| | PH2 | Scaling Law Fitter | physics.scaling_laws | S/E |
| | PH3 | Hardware and Throughput Profiles | physics.hardware_profiles, throughput | E |
| | PH4 | Energy and Landauer Comparator | physics.thermodynamic_models | S |
| | PH5 | Pareto Frontier Analyzer | physics.pareto_analysis | S/E |
| Biochemistry | BC1 | Reaction Network Simulator | bio.reaction_kinetics | S |
| | BC2 | Enzyme Kinetics Fitter | bio.catalysis | S/E |
| | BC3 | Gene Regulatory Motif Lab | bio.regulatory_networks | S |
| | BC4 | Homeostasis and Adaptation | bio.homeostasis | S |
| | BC5 | Stochastic vs Deterministic Kinetics | bio.reaction_kinetics | S |
| Evolution | EV1 | Fitness Landscape Explorer (NK) | bio.evolutionary_landscapes | S |
| | EV2 | Population Genetics Drift and Selection | bio.genetics | S |
| | EV3 | Population Dynamics (LV, SIR) | bio.population_dynamics | S |
| | EV4 | Replicator Dynamics on the Simplex | bio.evolutionary_landscapes | S |
| | EV5 | Allometric Scaling Comparator | bio.comparative_biology | E |
| Neuroscience | NE1 | Neuron Model Explorer | bio.neuron_models | S |
| | NE2 | f-I Curve Analyzer | bio.neuron_models | S |
| | NE3 | Synaptic Dynamics (STP) | bio.synaptic_dynamics | S |
| | NE4 | Plasticity Rule Lab (STDP, BCM, Oja) | bio.plasticity | S |
| | NE5 | E/I Circuit Simulator and Raster | bio.computational_neuroscience | S |
| Cognition | CO1 | Capability Profile Viewer | cognition.capability_profiles | E |
| | CO2 | Learning Curve Fitter | cognition.learning_curves | S/E |
| | CO3 | Generalization Matrix | cognition.generalization | E |
| | CO4 | Calibration and Reliability Diagram | cognition.metacognitive_calibration | S/E |
| | CO5 | Transfer and Retention Analyzer | cognition.transfer, retention | S/E |
| Dynamical systems | DY1 | Map Iterator and Cobweb | dynamics.discrete_systems | S |
| | DY2 | ODE Solver and Trajectories | dynamics.continuous_systems | S |
| | DY3 | Phase Portrait and Nullclines | dynamics.stability | S |
| | DY4 | Bifurcation Diagram | dynamics.bifurcations | S |
| | DY5 | Stability and Lyapunov Analyzer | dynamics.stability, attractors | S |
| Metascience | MS1 | Research Knowledge Graph | discovery.concept_graphs | E |
| | MS2 | Claim and Evidence Tracker | discovery.scientific_claims | E |
| | MS3 | Intellectual Lineage Explorer | discovery.intellectual_lineage | E |
| | MS4 | Meta-analysis Workbench | discovery.methodology_comparison | S/E |
| | MS5 | Research Productivity Indicators (with caveats) | discovery.productivity_measurement | E |
| Verification | VE1 | Model Benchmark Comparator | verify.model_eval | E |
| | VE2 | Experiment Comparison and Statistical Plan | verify.statistical_validation | E |
| | VE3 | Independent Replication Checker | verify.replication | E |
| | VE4 | Contamination and Benchmark Integrity | verify.independent_benchmarks | E |
| | VE5 | Audit Chain Verifier | verify.audit | E |
| Education | ED1 | Guided Tour: Entropy to Learning | curriculum | S |
| | ED2 | Guided Tour: Dynamics to Neurons | curriculum | S |
| | ED3 | Exercise Sets with Checked Answers | curriculum + cognition.reasoning (public dev split only) | S |
| | ED4 | Concept Map of GRIT | registry | E |
| | ED5 | Notebook Gallery | notebooks | S/E |

ED3 uses only public dev-split generators. Protected benchmark items never reach the UI.

## Interface contracts with the API

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/v1/instruments` | GET | List manifests (without `compute`) |
| `/api/v1/instruments/{id}/schema` | GET | JSON Schema for parameters |
| `/api/v1/compute/{id}` | POST | Run instrument; returns `InstrumentResult` or `202` + job id for `batch` |
| `/api/v1/jobs/{id}` | GET | Job status/result |
| `/api/v1/experiments`, `/{id}`, `/{id}/transitions` | GET/POST | Registry; POST transition requires role |
| `/api/v1/runs/{id}`, `/{id}/metrics` | GET | Run record; metrics as Arrow IPC or JSON |
| `/api/v1/evaluations/{id}` | GET | Signed result (signature verified server-side, flag returned) |
| `/api/v1/registry/concepts` | GET | Traceability registry |
| `/api/v1/models`, `/{id}/generate` | GET/POST | Verified models only unless `model:experimental` |

Errors: RFC 9457 problem+json (`type`, `title`, `status`, `detail`, `instance`, `errors[]` for validation).

## Performance budgets

| Interaction | Budget |
|---|---|
| Initial load (cold, broadband) | < 200 KB JS gzipped for the shell; instruments code-split |
| Instrument parameter change → chart | p95 < 500 ms for `interactive` instruments, including network |
| Loss curve render | 100k points via Canvas with LTTB downsampling to screen width; 60 fps pan/zoom |
| Knowledge graph | 2,000 nodes interactive; beyond that, cluster |
