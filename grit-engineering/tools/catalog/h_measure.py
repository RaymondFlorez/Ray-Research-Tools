"""Groups H, I, J: grit_cognition, grit_physics, grit_discovery (Phase 4)."""

from .model import prompt

C = "packages/grit_cognition/src/grit_cognition"
CT = "packages/grit_cognition/tests"
CREG = "docs/registry/concepts/grit_cognition.toml"
P = "packages/grit_physics/src/grit_physics"
PT = "packages/grit_physics/tests"
PREG = "docs/registry/concepts/grit_physics.toml"
D = "packages/grit_discovery/src/grit_discovery"
DT = "packages/grit_discovery/tests"
DREG = "docs/registry/concepts/grit_discovery.toml"
MS = "grit-engineering/specifications/scientific-modules.md"

prompt(
    36, "Capability profiles and comparative assessment", "H", 4,
    objective="Create the `grit_cognition` package with a capability taxonomy, multi-dimensional capability profiles with per-dimension confidence intervals, profile comparison without forced aggregation, and basic IRT fitting.",
    context="GRIT measures capability along many dimensions. A single aggregate score hides tradeoffs; this module makes aggregation an explicit, weighted, documented choice. The initial taxonomy is provisional until the owner confirms it against the treatise.",
    deps=[18, 24],
    inspect=[f"{MS} section 5", "grit-engineering/specifications/evaluation.md (capability taxonomy)", "Embretson & Reise (2000) Item Response Theory"],
    scope=[
        "Package skeleton (deps: grit-core, grit-dynamics).",
        "`capability_profiles.py`: `Dimension`, `CapabilityTaxonomy.from_toml`, `CapabilityScore`, `CapabilityProfile`, `profile_from_item_results(results, taxonomy, rng)` (bootstrap CIs per dimension), `aggregate(profile, weights)` requiring explicit weights.",
        "`comparative_assessment.py`: `dominance`, `pareto_front(profiles)`, `irt_fit(responses, model='1pl'|'2pl')` (marginal maximum likelihood via scipy.optimize, or joint MLE with documented bias), item difficulty and discrimination.",
        "`docs/registry/capability-taxonomy.toml` initial provisional taxonomy (dimensions from evaluation.md).",
    ],
    out=["Running any model (cognition consumes results; it doesn't produce them)."],
    create={
        "packages/grit_cognition/pyproject.toml": "package metadata",
        f"{C}/__init__.py": "public API", f"{C}/py.typed": "marker",
        f"{C}/capability_profiles.py": "taxonomy and profiles", f"{C}/comparative_assessment.py": "comparison and IRT",
        f"{CT}/test_profiles.py": "tests", f"{CT}/test_irt.py": "tests",
        "docs/registry/capability-taxonomy.toml": "initial capability taxonomy (provisional)", CREG: "grit_cognition registry",
    },
    tests=["IRT 2PL recovers synthetic item parameters (correlation > 0.95, n=2,000 respondents).", "Profiles never aggregate without weights (API test).", "Pareto front excludes dominated profiles (property)."],
    verify=["uv sync --all-packages", "uv run pytest packages/grit_cognition -q", "make check"],
    acceptance=["Taxonomy file validated and marked provisional.", "Every score has a CI."],
    complexity="M",
    review=["scientific"],
)

prompt(
    37, "Learning curves, retention, generalization and transfer", "H", 4,
    objective="Add learning curve fitting with model comparison, forgetting curves and spacing schedules, generalization matrices with CIs, and transfer metrics.",
    context="How fast, how durably and how broadly a learner improves are core GRIT measurements, applicable to humans, animals and models.",
    deps=[36, 13],
    inspect=[f"{MS} section 5", "Heathcote et al. (2000); Wixted & Ebbesen (1991); Taylor & Stone (2009)"],
    scope=["`learning_curves.py`: power, exponential, logistic fits; AIC/BIC comparison; extrapolation guard.", "`retention.py`: exponential and power forgetting fits, `spacing_schedule`.", "`generalization.py`: `generalization_matrix(results)` with bootstrap CIs, `ood_gap`.", "`transfer.py`: jumpstart, asymptotic gain, area ratio, time to threshold."],
    out=["Experiment execution."],
    create={f"{C}/learning_curves.py": "learning curves", f"{C}/retention.py": "retention", f"{C}/generalization.py": "generalization matrices", f"{C}/transfer.py": "transfer metrics", f"{CT}/test_learning.py": "tests", f"{CT}/test_transfer.py": "tests"},
    modify={f"{C}/__init__.py": "export", CREG: "entries"},
    tests=["AIC selects the generating model in ≥ 90% of 500 seeded synthetic trials.", "Transfer metrics are zero for identical curves.", "Generalization matrix diagonal equals in-distribution scores."],
    verify=["uv run pytest packages/grit_cognition -q", "make check"],
    acceptance=["Extrapolation beyond 2x observed range requires an explicit flag."],
    complexity="M",
    review=["scientific"],
)

prompt(
    38, "Metacognitive calibration, memory and attention models", "H", 4,
    objective="Add confidence-accuracy calibration reports (using core calibration math), ACT-R style memory activation, forgetting-based memory models, and normative attention models.",
    context="Knowing what you know (calibration) and allocating limited resources (attention, memory) are capability dimensions distinct from raw accuracy.",
    deps=[36, 17],
    inspect=[f"{MS} section 5", "Lichtenstein et al. (1982); Anderson & Schooler (1991); Bundesen (1990)"],
    scope=["`metacognitive_calibration.py`: `calibration_report`, overconfidence, resolution, reliability diagram data.", "`memory.py`: `act_r_base_level`, retrieval probability, exponential/power forgetting.", "`attention.py`: softmax attention with temperature, capacity-limited selection.", "`knowledge_representation.py`: `ConceptGraph` with typed edges, `is_a_closure`, consistency check (uses core.graphs)."],
    out=["Full cognitive architectures."],
    create={f"{C}/metacognitive_calibration.py": "calibration reports", f"{C}/memory.py": "memory models", f"{C}/attention.py": "attention models", f"{C}/knowledge_representation.py": "concept graphs", f"{CT}/test_calibration_memory.py": "tests"},
    modify={f"{C}/__init__.py": "export", CREG: "entries"},
    tests=["Calibrated synthetic data: ECE ≈ 0.", "ACT-R activation decreases with time since use; increases with practice count.", "`is_a` cycle reported."],
    verify=["uv run pytest packages/grit_cognition -q", "make check"],
    acceptance=["Calibration uses grit_core.statistics.calibration (no duplicate implementation)."],
    complexity="S",
)

prompt(
    39, "Reasoning task generators with independent answer checkers", "H", 4,
    objective="Add procedural task generators (copy, reverse, sort, modular arithmetic, multi-digit addition, bracket matching, associative recall, multi-hop lookup, syllogisms) with difficulty controls and independent answer checkers.",
    context="These generators produce the capability benchmarks used by the independent evaluator. They live in grit_cognition, which training code can't import (layers.toml), and protected splits are generated once, committed by hash and handed to grit_verify (P056).",
    deps=[36, 15],
    inspect=[f"{MS} section 5", "grit-engineering/specifications/evaluation.md (benchmarks and holdouts)"],
    scope=[
        "`reasoning/` subpackage: one module per task family; `generate(n, difficulty, rng) -> list[TaskInstance]`; difficulty parameters (length, digits, hops); `check(instance, answer) -> bool` implemented independently of the generator.",
        "`TaskInstance` canonical JSON form (for hashing).",
        "`reasoning/export.py`: `export_split(task, n, difficulty, seed, path)` writing JSONL plus a sha256 manifest.",
    ],
    out=["Committing protected benchmarks (P056 does that through the evaluator).", "Natural language benchmarks requiring licensed data."],
    create={f"{C}/reasoning/__init__.py": "task generator registry", f"{C}/reasoning/tasks.py": "task families", f"{C}/reasoning/checkers.py": "independent answer checkers", f"{C}/reasoning/export.py": "split export", f"{CT}/test_reasoning.py": "tests"},
    modify={f"{C}/__init__.py": "export", CREG: "entries"},
    tests=["Every generated instance passes its checker; a perturbed answer fails.", "Same seed → byte-identical JSONL.", "Difficulty monotone (e.g. digits) verified on instance metadata.", "Layer test: `alphalytica` and `grit_data` are not allowed to import `grit_cognition` (assert against layers.toml)."],
    verify=["uv run pytest packages/grit_cognition/tests/test_reasoning.py -q", "make check"],
    acceptance=["≥ 9 task families with checkers.", "Exported manifests verify."],
    complexity="M",
    review=["scientific", "security"],
)

prompt(
    40, "Compute accounting and scaling laws", "I", 4,
    objective="Create the `grit_physics` package with exact Transformer parameter counting, FLOP estimates for training and inference, memory estimates, and Chinchilla-style scaling-law fitting with CIs.",
    context="Resource accounting makes architecture comparisons honest (parameter-matched, compute-matched) and turns budgets into numbers. Formulas in specifications/compute-cost.md.",
    deps=[18],
    inspect=[f"{MS} section 6", "grit-engineering/specifications/compute-cost.md", "Kaplan et al. (2020); Hoffmann et al. (2022); Besiroglu et al. (2024)"],
    scope=[
        "Package skeleton (deps: grit-core, psutil).",
        "`compute_accounting.py`: `TransformerShape` (framework-free dataclass mirroring ModelConfig fields), `transformer_params`, `flops_per_token(train|infer)`, `training_flops`, `kv_cache_bytes`, `training_memory_estimate`.",
        "`scaling_laws.py`: `fit_power_law`, `fit_chinchilla(N, D, L)` (Huber on log-loss, multiple inits, bootstrap CIs), `compute_optimal(C, fit)`, extrapolation guard.",
    ],
    out=["Measurement (P041)."],
    constraints=["grit_physics never imports torch (layers.toml)."],
    create={"packages/grit_physics/pyproject.toml": "package metadata", f"{P}/__init__.py": "public API", f"{P}/py.typed": "marker", f"{P}/compute_accounting.py": "params, FLOPs, memory", f"{P}/scaling_laws.py": "scaling law fitting", f"{PT}/test_accounting.py": "tests", f"{PT}/test_scaling.py": "tests", PREG: "grit_physics registry"},
    interfaces="""
@dataclass(frozen=True, slots=True)
class TransformerShape:
    n_layer: int; d_model: int; n_head: int; n_kv_head: int; d_ff: int; vocab: int; ctx: int
    ffn: Literal["gelu_mlp", "swiglu"]; norm: Literal["layernorm", "rmsnorm"]; bias: bool
    tied_embeddings: bool; learned_positions: bool
def transformer_params(s: TransformerShape) -> int: ...
def training_flops(n_params: int, n_tokens: int, *, shape: TransformerShape | None = None) -> float: ...
def fit_chinchilla(N: ArrayLike, D: ArrayLike, L: ArrayLike, *, rng: np.random.Generator) -> ScalingFit: ...
""",
    tests=["G0, G1, G2, G3 reference shapes give the documented parameter counts (exact integers committed).", "Chinchilla fit recovers synthetic (E, A, B, α, β) within CI.", "Extrapolation > 10x beyond data raises unless flagged."],
    verify=["uv sync --all-packages", "uv run pytest packages/grit_physics -q", "make check"],
    acceptance=["Exact parameter counts committed for the four reference configs.", "Formulas documented with derivations in docstrings."],
    complexity="M",
    review=["scientific"],
)

prompt(
    41, "Hardware profiles and measurement: latency, throughput, memory, energy", "I", 4,
    objective="Add hardware detection, a reviewed peak-FLOPs table, timing and throughput measurement with CIs, memory profiling, and energy measurement or labeled estimation.",
    context="Measured beats assumed. Every measurement is tagged `measured` or `estimated`, and unknown hardware yields `None`, never a guess.",
    deps=[40],
    inspect=[f"{MS} section 6", "grit-engineering/specifications/compute-cost.md"],
    scope=[
        "`hardware_profiles.py`: `detect_hardware()` (platform, CPU model, cores, RAM via psutil, CUDA/MPS presence detected through an injected probe callback so the package stays torch-free), `configs/hardware_peaks.toml` with cited vendor peak FLOPs per dtype.",
        "`latency.py`, `throughput.py`: `time_fn`, `throughput` with warmup, repetitions, median and bootstrap CI.",
        "`memory_profiling.py`: `rss_peak`, `tracemalloc_peak`, callback hook for framework allocators.",
        "`energy_measurement.py`: optional NVML (extra `nvidia`), `tdp_based_estimate`, `Measurement(method=...)`.",
        "`grit-bench hardware` CLI printing the profile.",
    ],
    out=["macOS powermetrics (needs sudo; documented as manual)."],
    create={f"{P}/hardware_profiles.py": "hardware detection", f"{P}/latency.py": "timing", f"{P}/throughput.py": "throughput", f"{P}/memory_profiling.py": "memory", f"{P}/energy_measurement.py": "energy", f"{P}/cli.py": "grit-bench CLI", "configs/hardware_peaks.toml": "reviewed peak FLOPs table with citations", f"{PT}/test_measurement.py": "tests"},
    modify={"packages/grit_physics/pyproject.toml": "add psutil, optional nvidia extra (pynvml), console script grit-bench", f"{P}/__init__.py": "export", PREG: "entries"},
    tests=["`time_fn(sleep 10 ms)` median within 2 ms.", "Unknown accelerator → peak None.", "Energy without NVML labeled estimated."],
    verify=["uv run pytest packages/grit_physics -q", "uv run grit-bench hardware", "make check"],
    acceptance=["Every entry in hardware_peaks.toml has a citation URL and date.", "No sudo or daemons."],
    complexity="M",
)

prompt(
    42, "Efficiency, thermodynamic limits, Pareto analysis and the cost estimator", "I", 4,
    objective="Add efficiency metrics (MFU, loss per FLOP, tokens per joule), Landauer-limit comparisons, Pareto frontier analysis and the `grit-cost` estimator with user-supplied price tables.",
    context="Resource-normalized comparison is a GRIT requirement. Costs are formulas with prices as inputs; no price is hard-coded.",
    deps=[41],
    inspect=[f"{MS} section 6", "grit-engineering/specifications/compute-cost.md", "Landauer (1961); Deb et al. (2002)"],
    scope=["`computational_efficiency.py`, `thermodynamic_models.py`, `pareto_analysis.py` (non-dominated sort, 2-D hypervolume).", "`cost.py` + `grit-cost` CLI: `params`, `estimate`, `sweep`; `configs/prices.toml` template with zeros and an `as_of` date; refuses zero prices unless `--allow-zero`; warns if prices older than 30 days; JSON output with all assumptions."] ,
    out=["Fetching live prices from providers."],
    create={f"{P}/computational_efficiency.py": "efficiency metrics", f"{P}/thermodynamic_models.py": "Landauer comparisons", f"{P}/pareto_analysis.py": "Pareto analysis", f"{P}/cost.py": "cost estimation and CLI", "configs/prices.toml": "price table template (user maintained)", f"{PT}/test_cost.py": "tests", f"{PT}/test_pareto.py": "tests"},
    modify={"packages/grit_physics/pyproject.toml": "console script grit-cost", f"{P}/__init__.py": "export", PREG: "entries"},
    tests=["kT ln 2 at 300 K = 2.87e-21 J (3 s.f.).", "Pareto front mutually non-dominated (property).", "G3 reference estimate reproduces compute-cost.md numbers given the same assumptions.", "MFU > 1 raises."],
    verify=["uv run pytest packages/grit_physics -q", "uv run grit-cost estimate --help", "make check"],
    acceptance=["Estimator output includes every assumption and `method: estimated`.", "No hard-coded prices."],
    complexity="M",
)

prompt(
    43, "Literature, scientific claims and provenance", "J", 4,
    objective="Create the `grit_discovery` package with bibliographic records, a claims-and-evidence model, and a W3C PROV-style provenance graph.",
    context="A research workbench for analyzing evidence. It records and links; it doesn't generate claims or act.",
    deps=[18],
    inspect=[f"{MS} section 7", "W3C PROV-DM (2013)"],
    scope=["Package skeleton (deps: grit-core, bibtexparser).", "`literature.py`: `Work`, `from_bibtex`, DOI normalization, dedup.", "`scientific_claims.py`: `Claim`, `EvidenceLink`, immutable `ClaimStore`, `evidence_summary` (contradicting evidence always shown).", "`provenance.py`: `ProvGraph`, `lineage`, `to_prov_json`."],
    out=["Web scraping or API harvesting of literature."],
    create={"packages/grit_discovery/pyproject.toml": "package metadata", f"{D}/__init__.py": "public API", f"{D}/py.typed": "marker", f"{D}/literature.py": "bibliography", f"{D}/scientific_claims.py": "claims and evidence", f"{D}/provenance.py": "PROV graph", f"{DT}/test_literature.py": "tests", f"{DT}/test_claims.py": "tests", DREG: "grit_discovery registry"},
    tests=["DOI normalization idempotent.", "Malformed BibTeX → ValidationError.", "Evidence summary includes contradicting links.", "Lineage is a DAG; cycles rejected."],
    verify=["uv sync --all-packages", "uv run pytest packages/grit_discovery -q", "make check"],
    acceptance=["Claim kinds match the registry's kinds."],
    complexity="S",
)

prompt(
    44, "Hypotheses, concept graphs, analogy and intellectual lineage", "J", 4,
    objective="Add pre-registered hypotheses, concept graph analytics, size-limited structural analogy mapping, and citation lineage metrics.",
    context="Pre-registration is how GRIT keeps hypotheses honest; concept graphs and lineage map the intellectual structure of research.",
    deps=[43, 12],
    inspect=[f"{MS} section 7", "Gentner (1983); Nosek et al. (2018); Newman (2010)"],
    scope=["`hypotheses.py`: `Hypothesis` with content hash, immutability after registration.", "`concept_graphs.py`: centrality, communities (Louvain, seeded).", "`analogy_analysis.py`: `structure_map(g1, g2, max_size=50)` via VF2 subgraph isomorphism.", "`intellectual_lineage.py`: lineage depth, common ancestors, influence paths."],
    out=["Automated hypothesis generation."],
    create={f"{D}/hypotheses.py": "pre-registered hypotheses", f"{D}/concept_graphs.py": "concept graph analytics", f"{D}/analogy_analysis.py": "structure mapping", f"{D}/intellectual_lineage.py": "lineage", f"{DT}/test_graph_tools.py": "tests"},
    modify={f"{D}/__init__.py": "export", DREG: "entries"},
    tests=["Planted isomorphic substructure found.", "Size cap enforced.", "Hypothesis hash changes on any edit."],
    verify=["uv run pytest packages/grit_discovery -q", "make check"],
    acceptance=["Analogy search bounded in time and size."],
    complexity="S",
)

prompt(
    45, "Classification, complexity, productivity, meta-analysis and causal attribution (milestone M4)", "J", 4,
    objective="Add discovery classification (provisional scheme), research complexity proxies, bibliometric indicators with caveats, fixed and random effects meta-analysis, qualitative causal attribution, and close Phase 4.",
    context="Metascience measures need their limitations attached. Meta-analysis is the quantitative core of methodology comparison.",
    deps=[44, 17, 37, 38, 39, 42],
    inspect=[f"{MS} section 7", "DerSimonian & Laird (1986); Higgins et al. (2003); Hirsch (2005); Waltman (2016)"],
    scope=["`discovery_classification.py` (scheme from TOML, provisional).", "`research_complexity.py` (provisional proxies).", "`productivity_measurement.py`: h, g, field-normalized citations; each returns `IndicatorResult(value, caveats)`.", "`methodology_comparison.py`: fixed effect, DerSimonian-Laird random effects, I², Egger test.", "`causal_attribution.py`: identifiability report using core.graphs.", "`docs/milestones/M4.md` covering H, I, J."],
    out=["Ranking researchers."],
    create={f"{D}/discovery_classification.py": "classification", f"{D}/research_complexity.py": "complexity proxies", f"{D}/productivity_measurement.py": "indicators with caveats", f"{D}/methodology_comparison.py": "meta-analysis", f"{D}/causal_attribution.py": "causal attribution", f"{DT}/test_meta_analysis.py": "tests", f"{DT}/test_indicators.py": "tests", "docs/milestones/M4.md": "Phase 4 milestone report"},
    modify={f"{D}/__init__.py": "export", DREG: "entries"},
    tests=["Random-effects estimates match published reference values for a standard dataset (e.g. BCG vaccine trials) within 1e-3.", "Every indicator returns caveats.", "Non-identifiable effect reported as such."],
    verify=["uv run pytest packages/grit_discovery -q", "make check"],
    acceptance=["M4 report complete.", "Provisional schemes flagged in the registry."],
    complexity="M",
    review=["scientific"],
)
