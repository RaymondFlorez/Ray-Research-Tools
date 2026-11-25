"""Groups D and E: grit_algebra and grit_dynamics (Phase 2)."""

from .model import prompt

AL = "packages/grit_algebra/src/grit_algebra"
AT = "packages/grit_algebra/tests"
AREG = "docs/registry/concepts/grit_algebra.toml"
DY = "packages/grit_dynamics/src/grit_dynamics"
DT = "packages/grit_dynamics/tests"
DREG = "docs/registry/concepts/grit_dynamics.toml"
ASPEC = "grit-engineering/specifications/scientific-modules.md section 2 (grit_algebra)"
DSPEC = "grit-engineering/specifications/scientific-modules.md section 3 (grit_dynamics)"

prompt(
    19, "State spaces, typed operators, composition and higher-order functions", "D", 2,
    objective="Create the `grit_algebra` package with state spaces, typed operators, type-checked composition and higher-order operator combinators, with controlled reference examples.",
    context="GRIT treats intelligence-related processes as operators acting on state spaces; composition and iteration of operators are the basic moves. This prompt gives them a precise, testable software form. All definitions are standard set-theoretic ones; GRIT-specific readings are recorded as provisional registry entries for owner review.",
    deps=[18],
    inspect=[ASPEC, "docs/registry/README.md (block 0500 to 0699)"],
    scope=[
        "Package skeleton `packages/grit_algebra` (deps: grit-core) with its own pyproject.",
        "`state_spaces.py`: `StateSpace` protocol; `FiniteSpace`, `BoxSpace`, `ProductSpace`, `SimplexSpace`; membership and seeded sampling.",
        "`operators.py`: `Operator[S, T]` frozen dataclass; call validates domain membership at contract level `boundary`.",
        "`composition.py`: `compose`, `identity`, `iterate`, `pipeline`; compatibility check of codomain/domain (same space object or declared subspace).",
        "`higher_order.py`: `map_op`, `curry`, `uncurry`, `lift`, `fixed_point_operator`.",
        "Reference examples module `examples.py`: rotation operators on a finite cyclic space, affine maps on boxes, a contraction on [0, 1].",
    ],
    out=["Relations (P020).", "Fixed point algorithms (P021).", "Symbolic math (P022)."],
    create={
        "packages/grit_algebra/pyproject.toml": "package metadata",
        f"{AL}/__init__.py": "public API",
        f"{AL}/py.typed": "PEP 561 marker",
        f"{AL}/state_spaces.py": "state spaces",
        f"{AL}/operators.py": "typed operators",
        f"{AL}/composition.py": "composition",
        f"{AL}/higher_order.py": "operator combinators",
        f"{AL}/examples.py": "controlled reference examples",
        f"{AT}/test_spaces_operators.py": "tests",
        f"{AT}/test_composition.py": "tests",
        AREG: "grit_algebra registry",
    },
    interfaces="""
class StateSpace(Protocol):
    @property
    def dimension(self) -> int | None: ...
    @property
    def is_finite(self) -> bool: ...
    def contains(self, x: object) -> bool: ...
    def sample(self, rng: np.random.Generator, n: int) -> Sequence[object]: ...

@dataclass(frozen=True)
class Operator(Generic[S, T]):
    fn: Callable[[S], T]; domain: StateSpace; codomain: StateSpace; name: str; concept_id: str | None = None
    def __call__(self, x: S) -> T: ...

def compose(g: Operator[T, U], f: Operator[S, T]) -> Operator[S, U]: ...
def iterate(f: Operator[S, S], n: int) -> Operator[S, S]: ...
""",
    tests=[
        "Property: associativity of compose pointwise on sampled inputs; identity laws.",
        "Incompatible composition raises `ValidationError` naming both spaces.",
        "Property: `sample` output always `contains`.",
        "`iterate(f, 0)` is identity; `iterate(f, m+n) == compose(iterate(f, m), iterate(f, n))` pointwise.",
    ],
    verify=["uv sync --all-packages", "uv run pytest packages/grit_algebra -q", "make check"],
    acceptance=["Category laws hold as property tests.", "`make layers` passes with the new package declared."],
    complexity="M",
    review=["scientific"],
)

prompt(
    20, "Relations, equivalence and invariants", "D", 2,
    objective="Add finite binary relations, equivalence classes and quotients, and invariant checking (exhaustive and sampled) with counterexample reporting to `grit_algebra`.",
    context="Equivalence and invariance formalize when two states are the same for a purpose and what an operator preserves.",
    deps=[19],
    inspect=[ASPEC, "Warshall (1962) A theorem on Boolean matrices"],
    scope=[
        "`relations.py`: boolean-matrix `Relation` over a `FiniteSpace`; property predicates; `transitive_closure` (Warshall); `reflexive_closure`, `symmetric_closure`; `compose_relations`.",
        "`equivalence.py`: `equivalence_classes`, `quotient`, `is_congruence(R, op)`, `kernel_relation(op)` (x ~ y iff op(x) == op(y)).",
        "`invariants.py`: `Invariant`, `check_invariant(op, inv, space, mode, n, rng) -> InvariantReport` with up to 10 counterexamples.",
    ],
    out=["SMT-based proofs (P023)."],
    create={f"{AL}/relations.py": "finite relations", f"{AL}/equivalence.py": "equivalence and quotients", f"{AL}/invariants.py": "invariant checking", f"{AT}/test_relations.py": "tests", f"{AT}/test_invariants.py": "tests"},
    modify={f"{AL}/__init__.py": "export new API", AREG: "entries"},
    tests=["Property: closure idempotent and contains original.", "Equivalence classes partition the space.", "Kernel relation is always an equivalence.", "Exhaustive check finds a planted violation; sampled check finds it with stated probability."],
    verify=["uv run pytest packages/grit_algebra -q", "make check"],
    acceptance=["Warshall closure on 500 elements < 1 s.", "Counterexamples reported with inputs and outputs."],
    complexity="S",
)

prompt(
    21, "Fixed points and capability metrics (provisional)", "D", 2,
    objective="Add fixed-point algorithms (Banach, Kleene, Newton) and provisional capability metrics (reachability, coverage, composition depth) over operator sets to `grit_algebra`.",
    context="Fixed points describe self-consistent states of recursive processes. Capability metrics here are standard reachability notions used as stand-ins until the owner confirms the treatise's definitions; their registry entries are `provisional` with a note naming the chapter to confirm against.",
    deps=[20],
    inspect=[ASPEC, "Banach (1922); Tarski (1955); Kleene fixed point theorem"],
    scope=[
        "`fixed_points.py`: `banach_iterate(f, x0, tol, max_iter) -> FixedPointResult` with empirical Lipschitz estimate and a priori error bound; `kleene_iterate(f, bottom, leq, max_iter)`; `newton_fixed_point(f, jac, x0)`.",
        "`capability_metrics.py`: `reachable_set(ops, start, max_depth, max_states)`, `coverage(ops, start, target)`, `composition_depth(ops, start, target)`, `capability_profile(ops, tasks)`.",
    ],
    out=["Any claim that these metrics measure intelligence."],
    create={f"{AL}/fixed_points.py": "fixed point algorithms", f"{AL}/capability_metrics.py": "provisional capability metrics", f"{AT}/test_fixed_points.py": "tests", f"{AT}/test_capability_metrics.py": "tests"},
    modify={f"{AL}/__init__.py": "export", AREG: "entries; capability metrics marked provisional"},
    tests=["cos fixed point 0.739085133215161 within 1e-12.", "Kleene on powerset lattice reaches least fixed point of a monotone map.", "Property: coverage monotone under adding operators.", "`max_states` limit enforced."],
    verify=["uv run pytest packages/grit_algebra -q", "make check"],
    acceptance=["Capability metric registry entries are `provisional` with notes.", "Non-contractive maps reported as such, not silently iterated."],
    complexity="S",
    review=["scientific"],
)

prompt(
    22, "Symbolic mathematics with a safe expression parser", "D", 2,
    objective="Add `grit_algebra.symbolic_math`: a recursive-descent parser that turns user text into SymPy expressions without ever calling `eval`, plus Jacobians, simplification and safe lambdification.",
    context="SymPy's `sympify` and `parse_expr` evaluate Python code; they're unsafe on user input. The Symbolic Algebra Scratchpad (MA4) and stability analysis need symbolic expressions from users. This parser is a security boundary.",
    deps=[19],
    inspect=[ASPEC, "grit-engineering/specifications/security.md (injection row)"],
    scope=[
        "Tokenizer accepting numbers, identifiers, `+ - * / ^ **`, parentheses, commas; rejecting everything else.",
        "Grammar with precedence and unary minus; identifiers must be in `allowed_symbols` or `allowed_functions` (default functions: sin, cos, tan, exp, log, sqrt, abs, tanh, sinh, cosh, asin, acos, atan).",
        "Builds SymPy objects directly (`sympy.Symbol`, `sympy.Add`, ...).",
        "Limits: max length 2,000 characters, max depth 64, max 500 nodes.",
        "`jacobian(exprs, vars)`, `simplify_expr`, `lambdify_safe(expr, vars)` using numpy module only.",
    ],
    out=["Equation solving UI.", "LaTeX input."],
    constraints=["Add `sympy` to grit_algebra dependencies.", "No call to `sympify`, `parse_expr`, `eval` or `exec` anywhere in the module (test greps the source)."],
    create={f"{AL}/symbolic_math.py": "safe parser and symbolic helpers", f"{AT}/test_symbolic_math.py": "parser, security and Jacobian tests", f"{AT}/fixtures/malicious_expressions.txt": "negative corpus"},
    modify={"packages/grit_algebra/pyproject.toml": "add sympy", f"{AL}/__init__.py": "export", AREG: "entries"},
    interfaces="""
def parse_expression(text: str, *, allowed_symbols: Collection[str], allowed_functions: Collection[str] = DEFAULT_FUNCTIONS,
                     max_length: int = 2000, max_depth: int = 64) -> sympy.Expr: ...
def jacobian(exprs: Sequence[sympy.Expr], variables: Sequence[sympy.Symbol]) -> sympy.Matrix: ...
def lambdify_safe(expr: sympy.Expr, variables: Sequence[sympy.Symbol]) -> Callable[..., FloatArray]: ...
""",
    tests=[
        "Negative corpus (≥ 40 entries: `__import__`, attribute access, lambda, subscripts, strings, f-strings, very deep nesting) all rejected with `ValidationError`.",
        "Hypothesis fuzz: arbitrary text never raises anything but `ValidationError` and never calls `eval` (patched builtins assert).",
        "Round trip: parse(str(expr)) equals expr for 200 generated expressions.",
        "Jacobian of Lorenz system matches hand derivation.",
    ],
    verify=["uv run pytest packages/grit_algebra/tests/test_symbolic_math.py -q", "make check"],
    acceptance=["Zero uses of eval/sympify/parse_expr in the module.", "Fuzz test passes under `thorough` profile.", "Security review recorded."],
    complexity="M",
    review=["security"],
)

prompt(
    23, "Formal verification adapters (optional Z3 and Lean export)", "D", 2,
    objective="Add optional adapters that hand finite invariant checks to Z3 and export algebra definitions as Lean text, skipped cleanly when the tools are absent.",
    context="Property tests sample; SMT solvers can prove properties of finite or bounded encodings. This is optional research tooling, not a dependency of anything else.",
    deps=[20],
    inspect=[ASPEC],
    scope=[
        "Optional extra `formal = [\"z3-solver\"]` on grit_algebra.",
        "`formal/z3_adapter.py`: encode a finite relation property or bounded integer invariant as SMT; `z3_check(spec, timeout_s) -> FormalResult(status: proved|refuted|unknown|unavailable, counterexample)`.",
        "`formal/lean_export.py`: `export_lean(defs) -> str` for finite spaces, relations and operators (text only; no Lean toolchain needed).",
    ],
    out=["Running Lean in CI.", "General theorem proving."],
    conditional=None,
    create={f"{AL}/formal/__init__.py": "optional formal adapters", f"{AL}/formal/z3_adapter.py": "Z3 adapter", f"{AL}/formal/lean_export.py": "Lean text export", f"{AT}/test_formal.py": "tests (skip when z3 missing)"},
    modify={"packages/grit_algebra/pyproject.toml": "optional `formal` extra"},
    tests=["Z3 proves transitivity of a closure; refutes a planted false invariant with counterexample.", "Without z3 installed, status is `unavailable` and tests skip with a reason.", "Lean export golden file test."],
    verify=["uv run pytest packages/grit_algebra/tests/test_formal.py -q", "uv run --extra formal pytest packages/grit_algebra/tests/test_formal.py -q", "make check"],
    acceptance=["Core install doesn't pull z3.", "Timeouts enforced."],
    complexity="S",
)

prompt(
    24, "Discrete and continuous dynamical systems", "E", 2,
    objective="Create the `grit_dynamics` package with discrete maps and continuous ODE systems, typed trajectories with units, and canonical reference systems.",
    context="Dynamical systems are GRIT's language for processes over time: learning, adaptation, population change, neural activity.",
    deps=[18],
    inspect=[DSPEC, "Strogatz (2015) Nonlinear Dynamics and Chaos"],
    scope=[
        "Package skeleton `packages/grit_dynamics` (deps: grit-core).",
        "`systems.py`: `DiscreteSystem`, `ContinuousSystem`, `Trajectory` (t, x, units, params, provenance, state_names).",
        "`discrete.py`: `simulate_map`; references: logistic, Hénon, tent, linear map.",
        "`continuous.py`: `simulate_ode` over `grit_core.numerics.integrate_ode`; references: harmonic oscillator, damped pendulum, Lorenz, Van der Pol, Lotka-Volterra (generic form).",
        "Hard limits on steps.",
    ],
    out=["Stochastic systems (P025).", "Stability analysis (P026)."],
    create={
        "packages/grit_dynamics/pyproject.toml": "package metadata",
        f"{DY}/__init__.py": "public API",
        f"{DY}/py.typed": "marker",
        f"{DY}/systems.py": "system and trajectory types",
        f"{DY}/discrete.py": "maps",
        f"{DY}/continuous.py": "ODE systems",
        f"{DT}/test_discrete.py": "tests",
        f"{DT}/test_continuous.py": "tests",
        DREG: "grit_dynamics registry",
    },
    interfaces="""
@dataclass(frozen=True, slots=True)
class Trajectory:
    t: FloatArray; x: FloatArray; state_names: tuple[str, ...]; units: Mapping[str, str]
    params: Mapping[str, float]; converged: bool; message: str
def simulate_map(system: DiscreteSystem, x0: ArrayLike, n_steps: int, *, max_steps: int = 10_000_000) -> Trajectory: ...
def simulate_ode(system: ContinuousSystem, x0: ArrayLike, t_span: tuple[float, float], *, t_eval: ArrayLike | None = None,
                 method: OdeMethod = "DOP853", rtol: float = 1e-9, atol: float = 1e-12) -> Trajectory: ...
""",
    tests=["Logistic r=2.5 → 0.6.", "Harmonic oscillator energy drift < 1e-6 over 100 periods.", "Lorenz trajectory deterministic (golden hash of first 1,000 points at fixed tolerance).", "Units recorded on every trajectory."],
    verify=["uv sync --all-packages", "uv run pytest packages/grit_dynamics -q", "make check"],
    acceptance=["All reference systems have a citation in the registry.", "Every trajectory carries units and params."],
    complexity="M",
)

prompt(
    25, "Stochastic processes", "E", 2,
    objective="Add stochastic processes to `grit_dynamics`: random walks, exact Ornstein-Uhlenbeck, Euler-Maruyama SDE integration, Gillespie SSA and Markov chain stationary analysis.",
    context="Noise matters in biology (gene expression), neuroscience (spiking) and learning. Gillespie is reused by `grit_bio.reaction_kinetics`.",
    deps=[24, 15],
    inspect=[DSPEC, "Gillespie (1977); Kloeden & Platen (1992)"],
    scope=[
        "`stochastic.py`: `random_walk`, `ornstein_uhlenbeck_exact(theta, mu, sigma, x0, dt, n, rng)`, `euler_maruyama(system, x0, dt, n, rng)`, `gillespie(propensities, stoichiometry, x0, t_max, rng, max_events)`, `markov_chain_simulate`, `stationary_distribution(P)`.",
        "Ensemble helpers returning arrays shaped (paths, time, state).",
    ],
    out=["Tau-leaping and other approximate SSA methods."],
    create={f"{DY}/stochastic.py": "stochastic processes", f"{DT}/test_stochastic.py": "statistical tests"},
    modify={f"{DY}/__init__.py": "export", DREG: "entries"},
    tests=["OU stationary mean/variance via z-test over 1e4 paths.", "Euler-Maruyama weak order ~1 on geometric Brownian motion (slope test).", "Gillespie birth-death stationary mean = k_birth/k_death within CI.", "`πP = π` within 1e-12; reducible chain flagged."],
    verify=["uv run pytest packages/grit_dynamics/tests/test_stochastic.py -q", "make check"],
    acceptance=["All functions require `rng`.", "`max_events` enforced."],
    complexity="M",
    review=["scientific"],
)

prompt(
    26, "Stability, attractors and bifurcations", "E", 2,
    objective="Add equilibrium finding, Jacobians, linear stability classification, Lyapunov exponents, attractor characterization and bifurcation sweeps to `grit_dynamics`.",
    context="These power the Phase Portrait, Bifurcation Diagram and Stability Analyzer instruments, and the stability questions GRIT asks of learning dynamics.",
    deps=[24],
    inspect=[DSPEC, "Benettin et al. (1980); Grassberger & Procaccia (1983); Kuznetsov (2004)"],
    scope=[
        "`stability.py`: `find_equilibria(system, guesses)`, `jacobian_numeric`, `classify_equilibrium(J)` (stable/unstable node, saddle, stable/unstable spiral, center, degenerate), `lyapunov_spectrum(system, x0, t_total, dt_renorm)`, `nullclines_2d(system, grid)`.",
        "`attractors.py`: `poincare_section`, `recurrence_matrix`, `correlation_dimension`.",
        "`bifurcations.py`: `bifurcation_sweep(system, param, values, x0, transient, keep)` for maps and flows (via Poincaré maxima), normal forms (saddle-node, transcritical, pitchfork, Hopf).",
    ],
    out=["Full numerical continuation (AUTO-style). Add only if an experiment needs it."],
    create={f"{DY}/stability.py": "equilibria and stability", f"{DY}/attractors.py": "attractor measures", f"{DY}/bifurcations.py": "bifurcation sweeps and normal forms", f"{DT}/test_stability.py": "tests", f"{DT}/test_bifurcations.py": "tests", f"{DT}/test_attractors.py": "tests (some slow)"},
    modify={f"{DY}/__init__.py": "export", DREG: "entries"},
    tests=["Lorenz largest exponent 0.906 ± 0.02 (slow).", "Classification correct on all 2-D canonical cases.", "Logistic period doublings at r ≈ 3.0 and 3.449; Feigenbaum ratio from first four within 2% of 4.669.", "Lorenz correlation dimension 2.05 ± 0.1 (slow)."],
    verify=["uv run pytest packages/grit_dynamics -q", "uv run pytest packages/grit_dynamics -m slow -q", "make check"],
    acceptance=["All reference values within stated tolerance with citations.", "Sweeps respect step caps."],
    complexity="L",
    review=["scientific"],
)

prompt(
    27, "Control and feedback", "E", 2,
    objective="Add LTI systems, controllability and observability, LQR, discrete PID and feedback motif analysis to `grit_dynamics`.",
    context="Feedback and control are how adaptive systems regulate themselves: homeostasis, learning rate control, resource allocation.",
    deps=[24],
    inspect=[DSPEC, "Åström & Murray (2008) Feedback Systems"],
    scope=["`control.py`: `LtiSystem`, `controllability_matrix`, `observability_matrix`, rank tests, `lqr(A, B, Q, R)` via `scipy.linalg.solve_continuous_are`, `dlqr`, `pid_step`, `simulate_closed_loop`.", "`feedback.py`: `loop_gain`, `negative_feedback_steady_state`, `integral_feedback_adaptation`, step response metrics (rise time, overshoot, settling)."],
    out=["Robust control (H-infinity), MPC."],
    create={f"{DY}/control.py": "control", f"{DY}/feedback.py": "feedback motifs", f"{DT}/test_control.py": "tests"},
    modify={f"{DY}/__init__.py": "export", DREG: "entries"},
    tests=["Double integrator LQR closed-loop eigenvalues in left half-plane and match known solution.", "Integral feedback: zero steady-state error to step.", "Step metrics on second-order system match analytic formulas."],
    verify=["uv run pytest packages/grit_dynamics/tests/test_control.py -q", "make check"],
    acceptance=["LQR matches reference to 1e-8."],
    complexity="S",
)

prompt(
    28, "Multiscale models, resource constraints and scenario simulation", "E", 2,
    objective="Add fast-slow reduction, resource-constrained dynamics and a budgeted scenario runner that sweeps parameters and seeds into tidy Arrow tables.",
    context="Scenario simulation is how GRIT explores higher-order dynamics safely: bounded, seeded, budgeted sweeps whose outputs are data. The runner's hard budget is the mechanism that keeps simulations bounded.",
    deps=[25, 26],
    inspect=[DSPEC, "Segel & Slemrod (1989); MacArthur (1970); Monod (1950)"],
    scope=[
        "`multiscale.py`: `quasi_steady_state_reduce`, `fast_slow_simulate`.",
        "`resources.py`: consumer-resource model, chemostat, `budgeted_simulation(system, budget)`.",
        "`scenarios.py`: `Scenario(system_factory, param_grid, seeds, budget: StepBudget)`, `run_scenarios(s) -> pyarrow.Table` (columns: scenario_id, param columns, seed, t, state columns), deterministic ordering, total step cap checked before running.",
    ],
    out=["Parallel execution (add only after profiling)."],
    constraints=["Add `pyarrow` to grit_dynamics dependencies."],
    create={f"{DY}/multiscale.py": "fast-slow systems", f"{DY}/resources.py": "resource-constrained dynamics", f"{DY}/scenarios.py": "budgeted scenario runner", f"{DT}/test_scenarios.py": "tests", f"{DT}/test_multiscale.py": "tests", "docs/milestones/M2.md": "Phase 2 milestone report"},
    modify={"packages/grit_dynamics/pyproject.toml": "add pyarrow", f"{DY}/__init__.py": "export", DREG: "entries"},
    tests=["QSSA matches full Michaelis-Menten system when E0 ≪ S0 + Km (error < 1%).", "Closed consumer-resource system conserves mass.", "Same scenario + seeds → identical table hash.", "Scenario exceeding budget rejected before any simulation runs."],
    verify=["uv run pytest packages/grit_dynamics -q", "make check"],
    acceptance=["M2 report lists ≥ 10 reference results with tolerances.", "Budget pre-check enforced."],
    complexity="M",
    review=["scientific"],
)
