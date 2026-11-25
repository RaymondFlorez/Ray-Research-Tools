"""Groups B and C: grit_core (Phase 1)."""

from .model import prompt

CORE = "packages/grit_core/src/grit_core"
CT = "packages/grit_core/tests"
REG = "docs/registry/concepts/grit_core.toml"
SPEC = "grit-engineering/specifications/scientific-modules.md section 1 (grit_core)"

prompt(
    7, "Core types, error hierarchy and canonical hashing", "B", 1,
    objective="Create `grit_core.types`, `grit_core.errors` and `grit_core.hashing`: the validated value types, typed errors and canonical content hashing every other module builds on.",
    context="Every result in GRIT is a frozen dataclass that can be canonically serialized and hashed, so provenance and caching work by construction. Errors are typed so the shell can map them to HTTP codes and exit statuses without string matching.",
    deps=[1, 4, 5],
    inspect=[SPEC, "docs/registry/README.md (ID block 0001 to 0499)"],
    scope=[
        "`errors.py`: `GritError` base; `ValidationError(field, message)`, `NumericalError`, `ConvergenceError(iterations, residual)`, `ResourceLimitError`, `IntegrityError`.",
        "`types.py`: `FloatArray`, `IntArray`, `BoolArray` aliases; `ProbVector` (validated, read-only, sums to 1 within 1e-12, nonnegative); `Interval(lo, hi, closed=(True, True))` with `contains`; `ConfidenceInterval(estimate, lo, hi, level, method)`; `readonly(arr)` helper.",
        "`hashing.py`: `canonical_json(obj) -> str` supporting dataclasses, mappings, sequences, numpy scalars and arrays (as `{\"__ndarray__\": dtype, shape, data_b64}`), floats via `repr`, rejecting NaN unless `allow_nan=True`; `content_hash(obj) -> ContentHash` (sha256 hex).",
        "Create `docs/registry/concepts/grit_core.toml` with entries for ProbVector and canonical hashing.",
    ],
    out=["Units (P008).", "Contracts and validation decorators (P009).", "Any numerical algorithm."],
    create={
        f"{CORE}/errors.py": "typed error hierarchy",
        f"{CORE}/types.py": "validated value types and array aliases",
        f"{CORE}/hashing.py": "canonical JSON and sha256 content hashing",
        f"{CT}/test_types.py": "value type tests",
        f"{CT}/test_hashing.py": "canonical hashing tests",
        REG: "grit_core concept registry",
    },
    modify={"packages/grit_core/pyproject.toml": "no new dependencies; confirm numpy lower bound 2.0"},
    interfaces="""
class GritError(Exception): ...
class ValidationError(GritError):
    def __init__(self, field: str, message: str) -> None: ...

@dataclass(frozen=True, slots=True)
class ProbVector:
    values: FloatArray
    @classmethod
    def of(cls, x: ArrayLike, *, atol: float = 1e-12) -> ProbVector: ...

ContentHash = NewType("ContentHash", str)
def canonical_json(obj: object, *, allow_nan: bool = False) -> str: ...
def content_hash(obj: object) -> ContentHash: ...
""",
    tests=[
        "Property: `content_hash` invariant to dict key order and to dataclass vs equivalent dict.",
        "Property: canonical JSON of float arrays round-trips exactly (bitwise).",
        "`ProbVector.of([0.5, 0.6])` raises `ValidationError` naming `values`.",
        "Arrays inside results are not writable.",
        "Golden hash test: a fixed object hashes to a committed hex string (detects accidental format changes).",
    ],
    verify=["uv run pytest packages/grit_core -q", "make check"],
    acceptance=[
        "mypy strict passes with no `type: ignore`.",
        "Golden hash committed and stable on Linux and macOS CI.",
        "Registry entries validated by `make registry`.",
    ],
    complexity="S",
)

prompt(
    8, "Units at boundaries", "B", 1,
    objective="Create `grit_core.units`: one pint registry, conversion to SI at boundaries, and dimension checks with clear errors.",
    context="ADR-0010: SI floats inside the core, units at config/API/display boundaries. Most unit bugs are boundary bugs (ms vs s, kWh vs J).",
    deps=[7],
    inspect=["grit-engineering/decisions/ADR-0010-units-at-boundaries.md", SPEC],
    scope=[
        "`units.py`: module-level `ureg = pint.UnitRegistry(cache_folder=None)` with custom definitions `FLOP = [compute]`, `token = [text]`, `parameter = [count_param]`; `Q_` alias.",
        "`to_si(q, expected_dimension) -> float`; `parse_quantity(text) -> Quantity` that accepts only `<number> <unit>` (regex-validated before pint parsing, so no expression evaluation); `require_dimension(q, dim)`; `format_quantity(value_si, unit, digits)`.",
        "Registry entries for the unit conventions.",
    ],
    out=["Unit-aware arrays inside numerical code."],
    constraints=["Add `pint` to grit_core dependencies; nothing else."],
    create={f"{CORE}/units.py": "pint registry and boundary conversions", f"{CT}/test_units.py": "conversion and dimension tests"},
    modify={"packages/grit_core/pyproject.toml": "add pint dependency", REG: "unit convention entries"},
    interfaces="""
ureg: pint.UnitRegistry
def to_si(q: pint.Quantity, expected_dimension: str) -> float: ...
def parse_quantity(text: str) -> pint.Quantity: ...
def require_dimension(q: pint.Quantity, dimension: str) -> None: ...
def format_quantity(value_si: float, unit: str, digits: int = 4) -> str: ...
""",
    tests=[
        "Table test: 250 ms → 0.25 s; 1 kWh → 3.6e6 J; 3.2 GB → 3.2e9 bytes; 1 TFLOP → 1e12 FLOP.",
        "`to_si(Q_(1, 'm'), '[time]')` raises `ValidationError` naming expected and actual dimensions.",
        "`parse_quantity` rejects `__import__('os')`, `1 m * 2`, and empty strings (fuzz with Hypothesis text).",
    ],
    verify=["uv run pytest packages/grit_core/tests/test_units.py -q", "make check"],
    acceptance=["All conversion table cases pass.", "`parse_quantity` never invokes pint's expression parser on unvalidated input (verified by test with a patched parser)."],
    complexity="S",
    review=["security"],
)

prompt(
    9, "Runtime validation contracts", "B", 1,
    objective="Create `grit_core.validation`: precondition/postcondition decorators, shape and finiteness checks, and a contract level switch controlled by the shell.",
    context="Design by contract at module boundaries catches misuse early without paying for checks in inner loops. The level (`off`, `boundary`, `full`) is set once by the shell from `GRIT_CONTRACT_LEVEL`; the core never reads environment variables itself, so the setter is explicit.",
    deps=[7],
    inspect=[SPEC],
    scope=[
        "`contract(pre=..., post=...)` decorator where predicates are callables returning bool with a description; violations raise `ValidationError` with the description.",
        "`require_finite(x, name)`, `require_shape(x, pattern, name)` (pattern with `None` wildcards), `require_in(x, interval, name)`, `require_positive`.",
        "`set_contract_level(level)` and a context manager `contract_level(level)` for tests; default `boundary`.",
    ],
    out=["Reading environment variables (that's the shell's job)."],
    create={f"{CORE}/validation.py": "contracts and checks", f"{CT}/test_validation.py": "contract tests", f"{CT}/bench_validation.py": "overhead micro-benchmark (marked bench)"},
    interfaces="""
ContractLevel = Literal["off", "boundary", "full"]
def contract(*, pre: Sequence[Predicate] = (), post: Sequence[Predicate] = (), level: ContractLevel = "boundary") -> Callable[[F], F]: ...
def require_finite(x: ArrayLike, name: str) -> None: ...
def require_shape(x: NDArray[Any], pattern: tuple[int | None, ...], name: str) -> None: ...
def set_contract_level(level: ContractLevel) -> None: ...
""",
    tests=[
        "Violation messages include function name, argument name and predicate description.",
        "At level `off`, decorated functions run predicates zero times (counted).",
        "Decorator preserves signature and type hints (mypy reveal_type test).",
    ],
    verify=["uv run pytest packages/grit_core/tests/test_validation.py -q", "uv run pytest packages/grit_core/tests/bench_validation.py -m bench -q", "make check"],
    acceptance=["Overhead at `boundary` < 5% on a 1e5-element vector function (bench output in report).", "No global state other than the contract level."],
    complexity="S",
)

prompt(
    10, "Stable numerics and solver wrappers", "B", 1,
    objective="Create `grit_core.numerics`: numerically stable primitives and typed wrappers around SciPy's ODE, root, quadrature and finite-difference routines that always report convergence.",
    context="Silent numerical failure is the most common way scientific code lies. Every wrapper returns a result object with `converged`, iteration counts and a message, and enforces step limits so API callers can't burn CPU.",
    deps=[7, 9],
    inspect=[SPEC, "Higham (2002) Accuracy and Stability of Numerical Algorithms, ch. 4 (summation)", "Mächler (2012) Accurately computing log(1 - exp(-|a|))"],
    scope=[
        "`logsumexp(x, axis)`, `softmax(x, axis, temperature)`, `log_softmax`, `log1mexp(a)`, `log1pexp`, `pairwise_sum` (exposes numpy's pairwise behavior with a documented error bound), `kahan_sum`.",
        "`finite_difference(f, x, h=None, order=1|2, scheme='central')` with step selection `h = eps**(1/3) * max(1, |x|)` for central differences.",
        "`integrate_ode(rhs, t_span, y0, *, method='DOP853'|'RK45'|'LSODA'|'Radau', rtol, atol, t_eval, max_steps) -> OdeResult`.",
        "`find_root(f, bracket, *, xtol, max_iter) -> RootResult` (brentq); `find_root_newton(f, df, x0)`; `quad(f, a, b) -> QuadResult`.",
    ],
    out=["Domain-specific systems (grit_dynamics).", "Optimization (P013)."],
    create={f"{CORE}/numerics.py": "stable primitives and solver wrappers", f"{CT}/test_numerics.py": "unit, property and reference tests"},
    modify={REG: "entries for logsumexp, softmax, ODE integration, root finding"},
    interfaces="""
@dataclass(frozen=True, slots=True)
class OdeResult:
    t: FloatArray; y: FloatArray; converged: bool; n_steps: int; n_rhs_evals: int; message: str
def integrate_ode(rhs: Callable[[float, FloatArray], FloatArray], t_span: tuple[float, float], y0: ArrayLike, *,
                  method: OdeMethod = "DOP853", rtol: float = 1e-9, atol: float = 1e-12,
                  t_eval: ArrayLike | None = None, max_steps: int = 1_000_000) -> OdeResult: ...
def logsumexp(x: ArrayLike, axis: int | None = None) -> FloatArray | float: ...
def log1mexp(a: ArrayLike) -> FloatArray: ...
""",
    tests=[
        "Property: `softmax(x + c) == softmax(x)`; `logsumexp` finite for inputs up to 1e308.",
        "`log1mexp` relative error < 1e-15 vs mpmath-derived committed reference values on 20 points spanning 1e-20 to 700.",
        "Exponential decay `y' = -y` over [0, 10]: error vs `exp(-t)` < 1e-10 (DOP853, rtol 1e-12).",
        "`max_steps` exceeded → `converged=False`, never an exception from SciPy leaking through.",
        "`find_root` on `x**3 - 2` returns 2**(1/3) within 1e-14.",
    ],
    verify=["uv run pytest packages/grit_core/tests/test_numerics.py -q", "make check"],
    acceptance=["Every wrapper returns a result object with `converged`.", "All reference tolerances commented with their source."],
    complexity="M",
    review=["scientific"],
)

prompt(
    11, "Linear algebra and geometry helpers", "B", 1,
    objective="Create `grit_core.algebra` (numerical linear algebra helpers) and `grit_core.geometry` (distances, simplex projection, PCA) used by dynamics, biology and visualization.",
    context="Small, well-tested wrappers around LAPACK via SciPy with explicit conditioning checks. `nullspace` matters for conservation laws in reaction networks; `simplex_project` for replicator dynamics and probability work.",
    deps=[7, 9],
    inspect=[SPEC, "Duchi et al. (2008) Efficient projections onto the l1-ball"],
    scope=[
        "`algebra.py`: `stable_solve(A, b, *, allow_ill_conditioned=False) -> SolveResult` (residual, condition number), `condition_number`, `nullspace(A, rtol)`, `left_nullspace`, `project(v, basis)`, `is_positive_definite`.",
        "`geometry.py`: `pairwise_distances(X, metric='euclidean'|'cosine'|'manhattan')`, `simplex_project(v)`, `pca(X, k) -> PcaResult(components, explained_variance_ratio, mean)`.",
    ],
    out=["Symbolic linear algebra (grit_algebra.symbolic_math)."],
    create={f"{CORE}/algebra.py": "linear algebra helpers", f"{CORE}/geometry.py": "distances, simplex projection, PCA", f"{CT}/test_algebra.py": "tests", f"{CT}/test_geometry.py": "tests"},
    modify={REG: "entries for nullspace, simplex projection, PCA"},
    interfaces="""
def stable_solve(A: FloatArray, b: FloatArray, *, allow_ill_conditioned: bool = False, max_condition: float = 1e12) -> SolveResult: ...
def nullspace(A: FloatArray, rtol: float = 1e-12) -> FloatArray: ...
def simplex_project(v: FloatArray) -> FloatArray: ...
def pca(X: FloatArray, k: int) -> PcaResult: ...
""",
    tests=[
        "Property: `simplex_project(v)` is on the simplex and is the closest point (check against brute force on small n).",
        "Property: columns of `nullspace(A)` satisfy `‖A N‖ < 1e-10·‖A‖` and are orthonormal.",
        "Hilbert matrix n=14 → `stable_solve` raises `NumericalError` unless allowed.",
        "PCA explained variance ratios sum to ≤ 1 and match sklearn-free reference on a fixed dataset.",
    ],
    verify=["uv run pytest packages/grit_core/tests/test_algebra.py packages/grit_core/tests/test_geometry.py -q", "make check"],
    acceptance=["Conditioning failures raise with the condition number in the message.", "Property tests pass under the `thorough` profile."],
    complexity="S",
)

prompt(
    12, "Graph primitives and causal DAG tools", "B", 1,
    objective="Create `grit_core.graphs`: typed wrappers over NetworkX for DAGs and general graphs, including d-separation and backdoor adjustment set enumeration.",
    context="Graphs appear in concept maps, provenance, citation lineage, regulatory networks and causal analysis. Putting d-separation and backdoor sets in the core lets both `grit_discovery` and `grit_verify` use them without depending on each other (Pearl 2009, ch. 3).",
    deps=[7],
    inspect=[SPEC, "Pearl (2009) Causality, §3.3 (backdoor criterion)"],
    scope=[
        "`Dag.from_edges(edges)` raising `ValidationError` on cycles (reporting one cycle); `topological_order`; `ancestors`, `descendants`.",
        "`d_separated(dag, X, Y, Z)` (via networkx `is_d_separator`), `backdoor_adjustment_sets(dag, x, y, max_size)` returning minimal sets.",
        "`Graph` wrapper with typed node/edge attributes; `to_json`/`from_json` canonical (sorted nodes and edges).",
        "`max_nodes` limits on enumeration functions.",
    ],
    out=["Graph layout for visualization (frontend)."],
    constraints=["Add `networkx` to grit_core dependencies."],
    create={f"{CORE}/graphs.py": "typed graph and DAG helpers", f"{CT}/test_graphs.py": "tests including textbook DAGs"},
    modify={"packages/grit_core/pyproject.toml": "add networkx", REG: "entries for d-separation and backdoor criterion"},
    interfaces="""
@dataclass(frozen=True)
class Dag:
    nodes: tuple[str, ...]; edges: tuple[tuple[str, str], ...]
    @classmethod
    def from_edges(cls, edges: Iterable[tuple[str, str]], nodes: Iterable[str] = ()) -> Dag: ...
def d_separated(dag: Dag, x: set[str], y: set[str], z: set[str]) -> bool: ...
def backdoor_adjustment_sets(dag: Dag, x: str, y: str, *, max_size: int = 4) -> list[frozenset[str]]: ...
""",
    tests=[
        "Five reference DAGs (confounder, mediator, collider, M-bias, front-door) with hand-derived d-separation and backdoor answers.",
        "Property: canonical JSON round trip preserves the graph.",
        "Cycle detection reports a concrete cycle.",
    ],
    verify=["uv run pytest packages/grit_core/tests/test_graphs.py -q", "make check"],
    acceptance=["All reference DAG answers match.", "M-bias case correctly excludes the collider from adjustment sets."],
    complexity="S",
    review=["scientific"],
)

prompt(
    13, "Optimization wrappers and gradient checking", "B", 1,
    objective="Create `grit_core.optimization`: typed wrappers for SciPy minimization, least squares and linear programming, a gradient checker, and a transparent gradient-descent reference for teaching.",
    context="Curve fitting (learning curves, kinetics, scaling laws) depends on reliable optimization with honest convergence reporting.",
    deps=[10],
    inspect=[SPEC],
    scope=[
        "`minimize(f, x0, *, method, jac, bounds, max_iter) -> OptResult`; `least_squares(residuals, x0, *, bounds, loss) -> FitResult` with parameter covariance estimate `(JᵀJ)⁻¹·s²` and standard errors.",
        "`linprog(c, A_ub, b_ub, A_eq, b_eq, bounds) -> LpResult`.",
        "`check_gradient(f, grad, x, *, rtol) -> GradCheck` using `numerics.finite_difference`.",
        "`gradient_descent(f, grad, x0, *, lr, steps) -> OptResult` with full trajectory (for the Mathematics Workbench).",
    ],
    out=["Stochastic optimizers for neural networks (PyTorch provides those)."],
    create={f"{CORE}/optimization.py": "optimization wrappers", f"{CT}/test_optimization.py": "tests"},
    modify={REG: "entries for least squares covariance and gradient check"},
    interfaces="""
def least_squares(residuals: Callable[[FloatArray], FloatArray], x0: ArrayLike, *, bounds: tuple[ArrayLike, ArrayLike] | None = None,
                  loss: Literal["linear", "huber", "soft_l1"] = "linear") -> FitResult: ...
def check_gradient(f: Callable[[FloatArray], float], grad: Callable[[FloatArray], FloatArray], x: ArrayLike, *, rtol: float = 1e-5) -> GradCheck: ...
""",
    tests=[
        "Rosenbrock minimum (1, 1) within 1e-6.",
        "Linear regression via `least_squares`: parameters and standard errors match the closed-form OLS solution within 1e-8.",
        "`check_gradient` detects a deliberately wrong gradient.",
    ],
    verify=["uv run pytest packages/grit_core/tests/test_optimization.py -q", "make check"],
    acceptance=["Standard errors match closed form.", "Non-converged fits return `converged=False` with SciPy's message."],
    complexity="S",
)

prompt(
    14, "Immutable configs and environment provenance capture", "B", 1,
    objective="Create `grit_core.config` (TOML to frozen dataclass loading with canonical hashing) and `grit_core.provenance` (provenance record type and environment capture) used by every run record, experiment and instrument result.",
    context="Every persisted result carries provenance: code version, config hash, input hashes, time, synthetic flag. Environment capture is the one place the core touches the outside world (git, platform); it's isolated in functions the shell calls, never called from scientific functions.",
    deps=[7, 8],
    inspect=["grit-engineering/specifications/training.md (immutable configs)", "grit-engineering/specifications/data.md"],
    scope=[
        "`config.py`: `load_config(path, schema: type[T]) -> LoadedConfig[T]` (tomllib → validated frozen dataclass, unknown keys rejected, unit strings converted via `units.parse_quantity` where the field is annotated `Quantity[dim]`), `config_hash`.",
        "`provenance.py`: `Provenance` dataclass; `capture_environment() -> EnvironmentInfo` (python version, platform, package versions of grit packages, numpy, scipy, torch if importable, git commit and dirty flag via `git rev-parse` subprocess with no shell); `notebook_header()` for notebooks.",
    ],
    out=["Persisting provenance (grit_lab)."],
    constraints=["`capture_environment` must not fail outside a git repository: commit becomes `unknown` and `dirty=None`."],
    create={f"{CORE}/config.py": "TOML config loading and hashing", f"{CORE}/provenance.py": "provenance types and environment capture", f"{CT}/test_config.py": "tests", f"{CT}/test_provenance.py": "tests"},
    interfaces="""
@dataclass(frozen=True, slots=True)
class Provenance:
    code_version: str; config_hash: ContentHash | None; input_hashes: tuple[ContentHash, ...]
    created_at: str; synthetic: bool; concept_ids: tuple[str, ...] = ()
def load_config(path: Path, schema: type[T]) -> LoadedConfig[T]: ...
def capture_environment() -> EnvironmentInfo: ...
""",
    tests=[
        "Unknown key in TOML → `ValidationError` naming the key.",
        "Same config with reordered keys → same hash.",
        "`capture_environment` in a temp dir without git returns `unknown` commit.",
    ],
    verify=["uv run pytest packages/grit_core/tests/test_config.py packages/grit_core/tests/test_provenance.py -q", "make check"],
    acceptance=["Config hash stable across platforms (golden test).", "No subprocess uses `shell=True`."],
    complexity="S",
)

prompt(
    15, "Probability distributions and seeding", "C", 1,
    objective="Create `grit_core.probability`: explicit seeding with SeedSequence spawning and thin typed wrappers over SciPy distributions.",
    context="Reproducibility needs one seeding discipline: the shell creates a root seed, spawns child streams per component, and passes Generators down. No module ever touches global RNG state.",
    deps=[7, 9],
    inspect=[SPEC, "NumPy docs: Parallel random number generation (SeedSequence.spawn)"],
    scope=[
        "`make_rng(seed: int | SeedSequence) -> Generator` (PCG64); `spawn(seed_or_rng, n) -> list[Generator]`; `seed_record(rng)` capturing state for provenance.",
        "Distribution wrappers: `Categorical(p: ProbVector)`, `Bernoulli`, `Binomial`, `Poisson`, `Gaussian(mu, sigma)`, `MultivariateGaussian`, `Beta`, `Gamma`, `Dirichlet`, `Exponential`; each with `sample(rng, size)`, `log_prob(x)`, `mean`, `var`, `entropy` where closed form exists.",
        "A repo-wide test that greps `packages/` for `np.random.seed`, `random.seed`, `np.random.<dist>(` module-level calls and fails if found.",
    ],
    out=["Stochastic processes (grit_dynamics)."],
    create={f"{CORE}/probability.py": "seeding and distributions", f"{CT}/test_probability.py": "tests", "tests/test_no_global_rng.py": "repository-wide global RNG ban"},
    modify={REG: "entries for each distribution and the seeding policy"},
    interfaces="""
def make_rng(seed: int | np.random.SeedSequence) -> np.random.Generator: ...
def spawn(source: int | np.random.SeedSequence | np.random.Generator, n: int) -> list[np.random.Generator]: ...
@dataclass(frozen=True, slots=True)
class Gaussian:
    mu: float; sigma: float
    def sample(self, rng: np.random.Generator, size: int | tuple[int, ...] = ()) -> FloatArray: ...
    def log_prob(self, x: ArrayLike) -> FloatArray: ...
    def entropy(self) -> float: ...
""",
    tests=[
        "Same seed → identical samples; spawned streams pairwise correlation |r| < 0.01 over 1e5 draws.",
        "Sample means and variances within z-test bounds (alpha 1e-4) for every distribution.",
        "`log_prob` matches scipy.stats to 1e-12.",
        "Global RNG ban test fails on a planted file (fixture).",
    ],
    verify=["uv run pytest packages/grit_core/tests/test_probability.py tests/test_no_global_rng.py -q", "make check"],
    acceptance=["Global RNG ban active in CI.", "Every distribution has mean/var/log_prob tests."],
    complexity="S",
)

prompt(
    16, "Information theory", "C", 1,
    objective="Create `grit_core.information`: entropy, cross-entropy, KL and JS divergence, mutual information, conditional entropy, bias-corrected estimators, perplexity and bits per byte.",
    context="Information measures are central to GRIT (entropy analysis instruments, bits-per-byte as the primary language modeling metric). Bits per byte is tokenizer-independent: `bpb = total_nll_nats / (n_bytes · ln 2)` (ADR-0013).",
    deps=[7, 15],
    inspect=[SPEC, "Cover & Thomas (2006) ch. 2", "Miller (1955) bias correction"],
    scope=[
        "`entropy(p, base)`, `cross_entropy(p, q, base)`, `kl(p, q, base)`, `js(p, q, base)` (bounded by log 2), `mutual_information(joint, base)`, `conditional_entropy(joint, base)`.",
        "`entropy_plugin(counts)`, `entropy_miller_madow(counts)`, `entropy_ci(counts, rng, level)` (bootstrap).",
        "`differential_entropy_gaussian(cov)`, `kl_gaussian(mu0, cov0, mu1, cov1)` closed forms for tests and instruments.",
        "`perplexity(mean_nll_nats)`, `bits_per_byte(total_nll_nats, n_bytes)`, `nats_to_bits`.",
        "Conventions: `0 log 0 = 0`; KL with `q_i = 0 < p_i` returns `inf`.",
    ],
    out=["Continuous estimators beyond Gaussian closed forms (kNN estimators): add later only if an instrument needs them."],
    create={f"{CORE}/information.py": "information-theoretic measures", f"{CT}/test_information.py": "unit, property and reference tests"},
    modify={REG: "entries for every measure (definitions with LaTeX)"},
    interfaces="""
def entropy(p: ProbVector, *, base: float = math.e) -> float: ...
def kl(p: ProbVector, q: ProbVector, *, base: float = math.e) -> float: ...
def mutual_information(joint: FloatArray, *, base: float = math.e) -> float: ...
def entropy_miller_madow(counts: IntArray, *, base: float = math.e) -> float: ...
def bits_per_byte(total_nll_nats: float, n_bytes: int) -> float: ...
""",
    tests=[
        "Properties: H ≥ 0; H ≤ log n; KL ≥ 0; KL(p,p)=0; JS symmetric and ≤ log 2; I(X;Y)=I(Y;X) ≥ 0; chain rule H(X,Y)=H(X)+H(Y|X).",
        "Closed forms: Gaussian differential entropy; KL between Gaussians vs Monte Carlo (1e6 samples, z-test).",
        "Miller-Madow reduces bias vs plug-in on 1,000 seeded small-sample trials (mean error closer to truth).",
        "`bits_per_byte` on a uniform byte model equals 8.0 exactly.",
    ],
    verify=["uv run pytest packages/grit_core/tests/test_information.py -q", "make check"],
    acceptance=["All properties pass under `thorough` profile.", "No NaN for any valid ProbVector input including zeros."],
    complexity="M",
    review=["scientific"],
)

prompt(
    17, "Statistics, uncertainty, scoring rules and calibration math", "C", 1,
    objective="Create `grit_core.statistics`: descriptive statistics, bootstrap confidence intervals, hypothesis tests, effect sizes, multiple-comparison corrections, power analysis, proper scoring rules and calibration metrics.",
    context="Every comparison in GRIT reports uncertainty. Calibration math lives here (pure) so `grit_cognition` and `grit_verify` share one implementation without depending on each other.",
    deps=[15],
    inspect=[SPEC, "Efron (1987) BCa; Holm (1979); Benjamini & Hochberg (1995); Murphy (1973); Guo et al. (2017)"],
    scope=[
        "`describe(x)`, `bootstrap_ci(data, statistic, *, level, method='bca'|'percentile', n_resamples, rng)` (wrapping scipy.stats.bootstrap), `paired_bootstrap_diff`.",
        "`permutation_test(a, b, statistic, n, rng)`, `welch_t(a, b)`, `mann_whitney(a, b)`; results include statistic, p-value, effect size, CI.",
        "`cohens_d`, `hedges_g`, `cliffs_delta`; `holm(pvals)`, `benjamini_hochberg(pvals)`; `power_two_sample(effect, n, alpha)`, `required_n(effect, power, alpha)`.",
        "Scoring rules: `brier(probs, outcomes)`, `log_score`.",
        "`calibration` submodule: `reliability_bins(conf, correct, n_bins, strategy='uniform'|'equal_mass')`, `ece`, `mce`, `brier_decomposition` (reliability, resolution, uncertainty).",
    ],
    out=["Bayesian modeling frameworks.", "Model-specific calibration evaluation (grit_verify.calibration wraps this)."],
    create={f"{CORE}/statistics/__init__.py": "statistics API", f"{CORE}/statistics/calibration.py": "calibration metrics", f"{CT}/test_statistics.py": "tests", f"{CT}/test_calibration.py": "tests", f"{CT}/test_ci_coverage.py": "coverage simulation (marked slow)"},
    modify={REG: "entries for each estimator, test and scoring rule"},
    interfaces="""
def bootstrap_ci(data: ArrayLike | tuple[ArrayLike, ...], statistic: Callable[..., float], *, level: float = 0.95,
                 method: Literal["bca", "percentile"] = "bca", n_resamples: int = 10_000, rng: np.random.Generator) -> ConfidenceInterval: ...
def benjamini_hochberg(pvalues: ArrayLike) -> FloatArray: ...
def brier_decomposition(conf: ArrayLike, correct: ArrayLike, n_bins: int = 15) -> BrierDecomposition: ...
""",
    tests=[
        "Coverage simulation (slow): 95% BCa CI for the mean of exponential samples (n=50) covers truth in 93 to 97% of 2,000 trials.",
        "Holm and BH match published worked examples.",
        "Identity: Brier = reliability − resolution + uncertainty within 1e-12 (with equal-width bins, binned forecast definition).",
        "Perfectly calibrated synthetic forecasts: ECE < 0.01 at n=1e5.",
    ],
    verify=["uv run pytest packages/grit_core/tests/test_statistics.py packages/grit_core/tests/test_calibration.py -q", "uv run pytest packages/grit_core/tests/test_ci_coverage.py -m slow -q", "make check"],
    acceptance=["Coverage simulation passes.", "Every test function returns a result object with effect size and CI, not only a p-value."],
    complexity="M",
    review=["scientific"],
)

prompt(
    18, "Numerical reference suite and micro-benchmarks (milestone M1)", "C", 1,
    objective="Close Phase 1: a consolidated numerical reference suite, a benchmark harness with recorded baselines per hardware profile, and the M1 milestone report.",
    context="Reference values pin behavior across library upgrades; benchmarks pin performance. Both are needed before domain packages build on the core.",
    deps=[8, 10, 11, 12, 13, 14, 16, 17],
    inspect=["grit-engineering/specifications/testing.md (milestones)", SPEC],
    scope=[
        "`packages/grit_core/tests/reference/`: a TOML file of reference cases (function, inputs, expected, tolerance, source citation) and one parametrized test that runs them all.",
        "Benchmark harness: `benchmarks/core/` with pytest-benchmark (dev dependency) for: logsumexp 1e7, entropy 1e6 bins, bootstrap BCa 10k×1k, Lorenz 1e5 steps via `integrate_ode`.",
        "`benchmarks/baselines/<hardware-id>.json` recorded for the machine running this prompt; `make bench-compare` flags > 20% regressions.",
        "`docs/milestones/M1.md`: what's implemented, reference results table, benchmark table, known limitations.",
    ],
    out=["New core functionality."],
    constraints=["Add `pytest-benchmark` to the dev dependency group only."],
    create={
        "packages/grit_core/tests/reference/cases.toml": "reference cases with citations",
        "packages/grit_core/tests/reference/test_reference_cases.py": "parametrized reference runner",
        "benchmarks/core/bench_core.py": "core micro-benchmarks",
        "benchmarks/baselines/README.md": "how baselines are recorded and compared",
        "scripts/bench_compare.py": "compare benchmark JSON against a baseline",
        "docs/milestones/M1.md": "milestone report",
    },
    modify={"pyproject.toml": "add pytest-benchmark to dev group", "Makefile": "bench and bench-compare targets"},
    tests=["Reference runner covers at least 30 cases across numerics, information, statistics, algebra.", "bench_compare flags a synthetic 25% regression."],
    verify=["uv run pytest packages/grit_core/tests/reference -q", "make bench", "uv run python scripts/bench_compare.py --baseline benchmarks/baselines/<hardware-id>.json", "make check"],
    acceptance=["≥ 30 reference cases, each with a citation.", "Baseline JSON committed with hardware profile.", "M1 report lists every grit_core module with test counts."],
    complexity="M",
    review=["scientific"],
)
