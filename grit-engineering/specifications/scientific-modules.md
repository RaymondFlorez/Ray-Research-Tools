# Scientific Module Architecture

The contract for all ten software families and their 112 submodules. Each family section gives the shared facts once (dependencies, schemas, errors, security, benchmarks), then one row per submodule with the module-specific facts. A module's contract is: its public interface, its reference algorithm with a citation, the tests that pin its behavior, and the acceptance criterion that says it's done.

Conventions that apply to every module unless the row says otherwise:

- **Error handling.** Invalid input raises `ValidationError` with the offending field named. Numerical failure (non-convergence, singular matrix, overflow) raises `NumericalError` or returns a result with `converged=False` and a message. Never a silent `NaN`.
- **Purity.** No I/O, no logging, no global RNG. Stochastic functions take `rng: np.random.Generator`.
- **Outputs.** Frozen dataclasses (`@dataclass(frozen=True, slots=True)`) holding numpy arrays (made read-only with `arr.setflags(write=False)`) and scalar metadata. Every result type has `to_dict()` for canonical serialization.
- **Tests.** Every module has: unit tests on hand-computed cases; property tests (Hypothesis) on its invariants; numerical reference tests against a closed form or published value with a stated tolerance; and a `traces` marker linking each test to a registry concept.
- **Security.** Scientific modules accept only typed values, never strings that are interpreted as code. Size limits on inputs (array length, iteration count, graph size) are parameters with conservative defaults, so the API can't be used to burn CPU.
- **Benchmarks.** Only where the row lists one. Benchmarks run under `pytest -m bench` and are never part of the default CI gate.
- **Synthetic vs empirical.** Any module that produces example data marks it `synthetic=True`. Empirical data enters only through `grit_data` or `grit_discovery` with a citation.

Status column values: **standard** (textbook, implement as cited), **provisional** (GRIT-specific concept with a stand-in definition until the owner confirms it against the treatise).

---

## 1. `grit_core` (L1)

**Dependencies:** numpy, scipy, networkx, pint. Nothing else. **Prompts:** P007 to P018.

**Shared schemas:** `GritError` hierarchy; `ProbVector` (validated 1-D float64, nonnegative, sums to 1 within `1e-12`); `Interval(lo, hi, closed)`; `ConfidenceInterval(estimate, lo, hi, level, method)`; `ContentHash` (hex sha256); `Provenance(code_version, config_hash, input_hashes, created_at, synthetic)`.

| Module | Purpose and scope | Public interface (sketch) | Foundations / reference | Key tests | Acceptance |
|---|---|---|---|---|---|
| types | Validated value types and type aliases used everywhere | `FloatArray = NDArray[np.float64]`; `ProbVector.of(x)`; `Interval`; `errors.{GritError, ValidationError, NumericalError, ConvergenceError}`; `hashing.canonical_json(obj)`, `hashing.content_hash(obj)` | Canonical JSON: sorted keys, no whitespace, floats via `repr` (shortest round-trip) | Round-trip `hash(x)==hash(loads(dumps(x)))`; key order invariance | mypy strict passes; hash stable across Python 3.12/3.13 |
| units | Unit-aware boundaries, SI internally | `ureg` (single pint registry); `to_si(q, dim) -> float`; `require_dimension(q, "[time]")` | pint; SI base units | Conversion table tests (s, ms, J, kWh, FLOP is dimensionless count) | Wrong dimension raises `ValidationError` naming expected vs actual |
| algebra | Linear algebra helpers | `stable_solve(A, b) -> SolveResult`; `condition_number`; `nullspace(A, tol)`; `project(v, basis)` | LAPACK via scipy.linalg; nullspace via SVD with relative tolerance | Residual `‖Ax−b‖` bound; nullspace orthogonality | Raises on cond > 1e12 unless `allow_ill_conditioned=True` |
| geometry | Distances, simplices, embeddings for viz | `pairwise_distances(X, metric)`; `simplex_project(v)`; `pca(X, k) -> PcaResult` | Duchi et al. 2008 simplex projection; SVD-based PCA | Projection lands on simplex; PCA explained variance sums ≤ 1 | Property tests pass 1,000 examples |
| probability | Distributions and seeding | `make_rng(seed) -> Generator`; `spawn(rng_or_seed, n)`; `Categorical`, `Gaussian`, `Bernoulli`, `Beta`, `Dirichlet` thin typed wrappers over scipy.stats | NumPy `SeedSequence` spawning | Same seed → same draws; spawned streams independent (correlation test) | No global RNG use anywhere in repo (grep test) |
| statistics | Inference and uncertainty | `bootstrap_ci(data, stat, level, method="bca", rng)`; `permutation_test`; `welch_t`; `mann_whitney`; `cohens_d`, `hedges_g`; `holm`, `benjamini_hochberg`; `power_two_sample`; scoring rules `brier`, `log_score`; `calibration.{reliability_bins, ece, brier_decomposition}` | Efron 1987 (BCa); Holm 1979; Benjamini & Hochberg 1995; Murphy 1973 Brier decomposition; Guo et al. 2017 ECE | CI coverage simulation (95% CI covers truth in 93 to 97% of 2,000 synthetic trials); decomposition identity `BS = REL − RES + UNC` | Coverage test passes; all tests deterministic under fixed seed |
| information | Entropy and divergences | `entropy(p, base)`; `cross_entropy`; `kl(p, q)`; `js(p, q)`; `mutual_information(joint)`; `conditional_entropy`; `entropy_plugin(counts)`, `entropy_miller_madow(counts)`; `perplexity(nll_nats_per_token)`; `bits_per_byte(total_nll_nats, n_bytes)` | Cover & Thomas 2006; Miller 1955 bias correction | `H ≥ 0`; `KL(p,p)=0`; `KL ≥ 0`; `I(X;Y)=I(Y;X)`; chain rule `H(X,Y)=H(X)+H(Y|X)`; Gaussian closed forms | KL with `q_i=0, p_i>0` returns `inf` explicitly, never NaN |
| graphs | Typed graph helpers | `Dag.from_edges(edges)` (validates acyclic); `topological_order`; `d_separated(g, X, Y, Z)`; `backdoor_adjustment_sets(g, x, y)`; `to_json`/`from_json` | NetworkX; Pearl 2009 backdoor criterion | Cycle rejected; d-separation on textbook graphs (Pearl's figures) | Backdoor sets match hand-derived answers on 5 reference DAGs |
| numerics | Stable primitives and solver wrappers | `logsumexp`, `softmax`, `log1mexp`, `pairwise_sum`; `finite_difference(f, x, h, order)`; `integrate_ode(f, t_span, y0, method, rtol, atol, max_steps) -> OdeResult`; `find_root(f, bracket) -> RootResult`; `quad(f, a, b) -> QuadResult` | Higham 2002; Mächler 2012 (log1mexp); scipy solve_ivp, brentq, quad | `softmax` invariant to shift; `logsumexp` no overflow at 1e308; ODE on exponential decay vs closed form | All wrappers return `converged` flag; max_steps enforced |
| optimization | Minimization and fitting | `minimize(f, x0, method, bounds) -> OptResult`; `least_squares(residuals, x0)`; `linprog`; `check_gradient(f, grad, x)`; `gradient_descent(f, grad, x0, lr, steps)` (teaching reference) | scipy.optimize; Nocedal & Wright 2006 | Rosenbrock minimum found to 1e-6; gradient check catches a wrong gradient | Reference GD matches scipy on a convex quadratic |
| validation | Runtime contracts | `@contract(pre=..., post=...)`; `require_finite(x, name)`; `require_shape(x, (n, None))`; `ContractLevel = Literal["off", "boundary", "full"]` set via shell config | Design by contract (Meyer) | Violations raise `ValidationError` with the predicate text | Overhead < 5% at `boundary` level on core benchmarks |

**Benchmarks (P018):** `logsumexp` on 1e7 elements; `entropy` on 1e6 bins; `bootstrap_ci` BCa with 10,000 resamples of n=1,000; `integrate_ode` Lorenz 1e5 steps. Baselines recorded per hardware profile, regression threshold 20%.

---

## 2. `grit_algebra` (L2)

**Dependencies:** `grit_core`, sympy. Optional extra `formal`: z3-solver. **Prompts:** P019 to P023.

**Shared schemas:** `StateSpace` protocol (`contains(x) -> bool`, `sample(rng, n)`, `dimension`, `is_finite`, `elements()` for finite spaces); `Operator[S, T]` frozen dataclass wrapping a pure callable with `domain: StateSpace`, `codomain: StateSpace`, `name`, `concept_id`.

| Module | Purpose and scope | Public interface (sketch) | Foundations / reference | Key tests | Status / acceptance |
|---|---|---|---|---|---|
| state_spaces | Represent the spaces operators act on | `FiniteSpace(elements)`; `BoxSpace(lo, hi)`; `ProductSpace(*spaces)`; `SimplexSpace(n)` | Set theory; product topology | `sample` always `contains`; product dimension adds | standard |
| typed_operators | Functions with declared domain and codomain | `Operator(fn, domain, codomain, name)`; `op(x)` validates membership at `boundary` contract level | Category of sets | Out-of-domain input raises | standard |
| composition | Compose operators with type checking | `compose(g, f)` (raises if `f.codomain` not compatible with `g.domain`); `identity(S)`; `iterate(f, n)`; `pipeline(*ops)` | Associativity of composition | `compose(h, compose(g, f)) == compose(compose(h, g), f)` pointwise (property test) | standard |
| higher_order_functions | Operators on operators | `map_op(F, ops)`; `curry`, `uncurry`; `fixed_point_operator(F)` (returns the operator whose application finds fixed points); `lift(f)` over product spaces | Lambda calculus basics | Curry/uncurry round trip | standard |
| relations | Finite binary relations | `Relation.from_pairs(space, pairs)` (boolean matrix); `is_reflexive/symmetric/transitive/antisymmetric`; `transitive_closure` (Warshall); `compose_relations` | Warshall 1962 | Closure idempotent; closure contains original | standard |
| equivalence | Equivalence classes and quotients | `equivalence_classes(R)`; `quotient(space, R) -> FiniteSpace`; `is_congruence(R, op)` | Quotient sets | Classes partition the space | standard |
| invariants | Check that properties are preserved | `Invariant(predicate, name)`; `check_invariant(op, inv, space, mode="exhaustive"|"sampled", n, rng) -> InvariantReport` (counterexamples included) | Floyd-Hoare invariants | Exhaustive on finite spaces finds planted violation | standard |
| capability_metrics | Quantify what a set of operators can reach | `reachable_set(ops, start, max_depth)`; `coverage(ops, start, target)`; `composition_depth(ops, start, target)`; `capability_profile(ops, tasks) -> dict` | Reachability in transition systems | Coverage monotone in operator set (adding an op never lowers coverage) | **provisional**: stand-in until the treatise's capability definition is confirmed |
| symbolic_math | Symbolic expressions without `eval` | `parse_expression(text, allowed_symbols, allowed_functions) -> sympy.Expr` (own tokenizer + recursive descent parser builds SymPy objects directly); `jacobian(exprs, vars)`; `simplify`; `lambdify_safe(expr, vars)` | SymPy; recursive descent | Rejects `__import__`, attribute access, unknown names; fuzz test with Hypothesis-generated strings never reaches `eval` | standard; security review required |
| fixed_points | Find and certify fixed points | `banach_iterate(f, x0, tol, max_iter) -> FixedPointResult` (with empirical contraction estimate); `kleene_iterate(f, bottom, leq)` on finite lattices; `newton_fixed_point(f, J, x0)` | Banach 1922; Kleene; Tarski 1955 | Cosine fixed point 0.7390851332; Kleene on powerset lattice reaches least fixed point | standard |
| formal_verification_adapters | Hand finite checks to SMT/proof tools | `z3_check_invariant(spec) -> FormalResult` (optional extra); `export_lean_definitions(defs) -> str` (text only) | de Moura & Bjørner 2008 | Adapter skipped cleanly when z3 is absent | standard; optional |

**Benchmarks:** `transitive_closure` on 500-element relation; `reachable_set` depth 10 with 20 operators on a 10,000-element space.

**Security:** `symbolic_math` is the only module in the family that takes text. Its parser is the security boundary. P022 requires a negative test corpus and a fuzz test.

---

## 3. `grit_dynamics` (L2)

**Dependencies:** `grit_core`. **Prompts:** P024 to P028.

**Shared schemas:** `Trajectory(t: FloatArray, x: FloatArray, units: Mapping[str, str], params: Mapping[str, float], provenance)`; `DiscreteSystem(step: Callable[[x, params], x])`; `ContinuousSystem(rhs: Callable[[t, x, params], dx])`; `StochasticSystem(drift, diffusion)`.

| Module | Purpose and scope | Public interface (sketch) | Foundations / reference | Key tests | Acceptance |
|---|---|---|---|---|---|
| discrete_systems | Iterated maps | `simulate_map(sys, x0, n_steps)`; reference systems: logistic, Hénon, tent, linear | May 1976; Hénon 1976 | Logistic r=2.5 converges to 0.6 | Matches closed-form fixed points |
| continuous_systems | ODE systems | `simulate_ode(sys, x0, t_span, t_eval, method)`; references: harmonic oscillator, damped pendulum, Lorenz, Van der Pol | Hairer et al. 1993 | Harmonic oscillator energy drift < 1e-6 over 100 periods (DOP853) | Returns `Trajectory` with units |
| stochastic_processes | Random processes | `random_walk`; `ornstein_uhlenbeck_exact`; `euler_maruyama(sys, x0, dt, n, rng)`; `gillespie(network, x0, t_max, rng, max_events)`; `markov_chain_stationary(P)` | Gillespie 1977; Kloeden & Platen 1992 | OU sample mean and variance match theory (z-test at 1e4 paths); stationary `πP=π` | All take `rng`; `max_events` enforced |
| control | Classical and modern control | `LtiSystem(A, B, C, D)`; `controllability`, `observability`; `lqr(A, B, Q, R)`; `pid_step(state, error, gains, dt)`; `simulate_closed_loop` | Åström & Murray 2008 | LQR closed loop eigenvalues in left half plane on double integrator | Rank tests correct on textbook examples |
| feedback | Feedback motifs and loop analysis | `loop_gain`; `negative_feedback_steady_state`; `integral_feedback_adaptation` | Åström & Murray 2008 | Integral feedback gives zero steady-state error to step | standard |
| stability | Equilibria and linear stability | `find_equilibria(sys, guesses)`; `jacobian_numeric(sys, x)`; `classify_equilibrium(J) -> Literal[...]`; `lyapunov_spectrum(sys, x0, ...)` (Benettin) | Strogatz 2015; Benettin et al. 1980 | Lorenz largest exponent ≈ 0.906 ± 0.02 | Classification matches all 2-D cases (node, saddle, spiral, center) |
| attractors | Attractor characterization | `poincare_section`; `recurrence_matrix`; `correlation_dimension` (Grassberger-Procaccia) | Grassberger & Procaccia 1983 | Lorenz dimension ≈ 2.05 ± 0.1 | standard |
| bifurcations | Parameter dependence | `bifurcation_sweep(map_or_flow, param_grid, x0, transient, keep)`; normal forms: saddle-node, pitchfork, transcritical, Hopf | Kuznetsov 2004 | Logistic period doubling at r≈3.0, 3.449 | Feigenbaum ratio from first 4 doublings within 2% of 4.669 |
| multiscale_models | Fast-slow systems | `quasi_steady_state_reduce(sys, fast_vars)`; `fast_slow_simulate` | Segel & Slemrod 1989 | QSSA Michaelis-Menten agrees with full system when `E0 ≪ S0 + Km` | standard |
| resource_constraints | Dynamics under budgets | `consumer_resource_model`; `budgeted_simulation(sys, budget)` (stop on resource exhaustion); `chemostat` | MacArthur 1970; Monod 1950 | Mass conservation in closed system | standard |
| scenario_simulation | Parameter sweeps and ensembles | `Scenario(system, param_grid, seeds, budget)`; `run_scenarios(scenario) -> pyarrow.Table` (tidy: one row per param × seed × time) | Experimental design | Same seeds → identical table hash | Hard cap on total steps across the sweep |

**Benchmarks:** Lorenz 1e6 steps; bifurcation sweep 1,000 params × 1,000 iterates; Gillespie 1e6 events.

---

## 4. `grit_bio` (L2)

**Dependencies:** `grit_core`, `grit_dynamics`. **Prompts:** P029 to P035. Educational and scientific simulations of documented models only. Parameter sets come from the cited paper and are stored with the citation. No organism-level or wet-lab protocol content.

**Shared schemas:** `ReactionNetwork(species, reactions: [Reaction(reactants, products, rate_law, params)])`; `NeuronParams` per model (canonical sets); `Population(genotypes, frequencies)`.

| Module | Purpose and scope | Public interface (sketch) | Foundations / reference | Key tests | Acceptance |
|---|---|---|---|---|---|
| biochemistry | Reaction network representation | `ReactionNetwork`; `stoichiometry_matrix(net)`; `conservation_laws(net)` (left nullspace) | Feinberg 2019 | Conserved moieties constant along simulated trajectories | standard |
| reaction_kinetics | Rate laws and simulation | `mass_action_rhs(net)`; `simulate_deterministic(net, x0, t)`; `simulate_stochastic(net, x0, t, rng)` (Gillespie via dynamics) | Guldberg-Waage; Gillespie 1977 | Stochastic mean → deterministic at large volume | standard |
| catalysis | Enzyme kinetics | `michaelis_menten(S, Vmax, Km)`; `hill(S, Vmax, K, n)`; inhibition (competitive, uncompetitive, noncompetitive); `fit_michaelis_menten(S, v)` | Michaelis & Menten 1913; Briggs & Haldane 1925 | Fit recovers params from synthetic noisy data within 5% | standard |
| regulatory_networks | Gene regulatory motifs | `toggle_switch` (Gardner et al. 2000); `repressilator` (Elowitz & Leibler 2000); `feed_forward_loop` (Mangan & Alon 2003); `boolean_network(rules)` | cited papers | Toggle bistability: two stable equilibria; repressilator oscillates with published params | standard |
| systems_biology | Network-level analysis | `sensitivity_analysis(model, params)` (local, normalized); `steady_state(model)` | Kacser & Burns 1973 (control coefficients) | Summation theorem: flux control coefficients sum to 1 | standard |
| homeostasis | Regulation around set points | `integral_feedback_model`; `robust_perfect_adaptation_test(model, perturbation)` | Yi et al. 2000 | Perfect adaptation to step input | standard |
| genetics | Population genetics | `hardy_weinberg(p)`; `wright_fisher(N, p0, s, mu, generations, rng)`; `moran(N, ...)`; `fixation_probability_kimura(N, s, p0)` | Kimura 1962 | Simulated fixation frequency matches Kimura within CI (1e4 runs) | standard |
| population_dynamics | Ecological dynamics | `logistic_growth`; `lotka_volterra`; `competitive_lv`; `sir`, `seir` (educational) | Lotka 1925; Kermack & McKendrick 1927 | LV conserved quantity constant; SIR final size relation | standard |
| evolutionary_landscapes | Fitness landscapes and adaptation | `nk_landscape(N, K, rng)`; `adaptive_walk(landscape, start, rule, rng)`; `replicator_dynamics(A, x0)`; `quasispecies(Q, f)` | Kauffman 1993; Taylor & Jonker 1978; Eigen 1971 | K=0 landscape has single peak; replicator preserves simplex | standard |
| computational_neuroscience | Network-level neural simulation (circuits) | `wilson_cowan(params)`; `spiking_network(n_e, n_i, p_conn, model, rng)`; `raster(spikes)` | Wilson & Cowan 1972; Brunel 2000 | E/I balance regime produces asynchronous irregular firing (CV ISI ≈ 1) | 1,000 LIF neurons × 1 s sim at dt=0.1 ms in < 10 s on M-series CPU |
| neuron_models | Single neuron dynamics | `lif`; `izhikevich(params_preset)`; `hodgkin_huxley`; `fitzhugh_nagumo`; `fi_curve(model, currents)` | Izhikevich 2003; Hodgkin & Huxley 1952 | HH resting potential ≈ −65 mV; Izhikevich presets reproduce published firing patterns | standard |
| synaptic_dynamics | Synaptic conductances | `exponential_synapse`; `alpha_synapse`; `tsodyks_markram(U, tau_rec, tau_facil)` | Tsodyks & Markram 1997 | Depression ratio for paired pulses matches closed form | standard |
| plasticity | Learning rules | `stdp_pair(dt, A_plus, A_minus, tau)`; `bcm`; `oja`; `hebb` | Bi & Poo 1998; Bienenstock et al. 1982; Oja 1982 | Oja converges to first principal component | standard |
| comparative_biology | Cross-species scaling | `allometric_fit(mass, y)` (log-log OLS with CI); `kleiber_reference` | Kleiber 1932; West et al. 1997 | Synthetic data with exponent 0.75 recovered | Empirical datasets require citation + license via `grit_data` |

**Benchmarks:** spiking network above; Gillespie on repressilator 1e6 events; Wright-Fisher 1e4 replicates × 1,000 generations.

---

## 5. `grit_cognition` (L2)

**Dependencies:** `grit_core`, `grit_dynamics`. **Prompts:** P036 to P039. Measures and models of capability for humans, animals and machines, applied to data supplied from outside. It doesn't run models.

**Shared schemas:** `CapabilityTaxonomy` (tree: `Dimension(id, name, description, parent)`); `CapabilityScore(dimension_id, estimate: ConfidenceInterval, n_items, method)`; `CapabilityProfile(subject_id, scores, provenance)`; `TaskInstance(task_id, prompt, answer, metadata, generator_version, seed)`.

| Module | Purpose and scope | Public interface (sketch) | Foundations / reference | Key tests | Status / acceptance |
|---|---|---|---|---|---|
| capability_profiles | Multi-dimensional capability records | `CapabilityTaxonomy.from_toml`; `profile_from_item_results(results, taxonomy, rng) -> CapabilityProfile` (bootstrap CIs per dimension) | Item response theory basics | Profile never collapses to one number unless `aggregate()` is called explicitly with weights | **provisional** taxonomy |
| knowledge_representation | Typed concept graphs | `ConceptGraph(nodes, typed_edges)`; `is_a_closure`; `consistency_check` | Description logic lite | Cycle in `is_a` reported | standard |
| memory | Memory models | `act_r_base_level(times_since_use, decay)`; `exponential_forgetting`; `power_forgetting` | Anderson & Schooler 1991 | Activation decreases with time since use | standard |
| attention | Attention models | `softmax_attention(scores, temperature)`; `capacity_limited_selection(saliency, k)` | Normative models; Bundesen 1990 TVA (reference only) | Temperature → 0 approaches argmax | standard |
| reasoning | Task generators with answer keys | `generators.{copy, reverse, sort, modular_arithmetic, bracket_matching, associative_recall, syllogism, multi_hop_lookup}`; each `generate(n, difficulty, rng) -> list[TaskInstance]` | Procedural benchmarks | Every instance's answer verified by an independent checker function | Determinism: same seed → same instances, byte for byte |
| learning_curves | Fit and compare learning curves | `fit_power_law`, `fit_exponential`, `fit_logistic`; `compare_models_aic(fits)` | Newell & Rosenbloom 1981; Heathcote et al. 2000 | Recovers parameters from synthetic curves; AIC picks the generating model in ≥ 90% of trials | standard |
| retention | Forgetting over time | `fit_forgetting(times, recall)`; `spacing_schedule(target_retention, model)` | Ebbinghaus 1885; Wixted & Ebbesen 1991 | Schedule intervals increase monotonically | standard |
| metacognitive_calibration | Confidence vs accuracy | `calibration_report(confidences, correct, n_bins) -> CalibrationReport` (uses `grit_core.statistics.calibration`); `overconfidence`; `resolution` | Lichtenstein et al. 1982 | Perfectly calibrated synthetic data gives ECE ≈ 0 | standard |
| generalization | Train/test task matrices | `generalization_matrix(results, train_tasks, test_tasks) -> Matrix with CIs`; `ood_gap(in_dist, out_dist)` | Standard ML evaluation | Diagonal equals in-distribution scores | standard |
| transfer | Transfer metrics | `jumpstart`, `asymptotic_gain`, `area_ratio`, `time_to_threshold` | Taylor & Stone 2009 | Zero transfer when curves are identical | standard |
| comparative_assessment | Compare profiles without one score | `dominance(profile_a, profile_b)`; `pareto_front(profiles)`; `irt_fit(responses, model="1pl"|"2pl")` | Embretson & Reise 2000 | Pareto front excludes dominated profiles | standard |

**Security:** task generators produce benchmark data that will later be committed and protected. P039 requires that the generator output for protected benchmarks is produced once, hashed, and handed to `grit_verify`. Training pipelines must never import `grit_cognition.reasoning` (enforced by layer rules: `alphalytica` and `grit_data` can't import `grit_cognition`).

---

## 6. `grit_physics` (L2)

**Dependencies:** `grit_core`, psutil. Optional extra `nvidia`: pynvml. Never imports torch; framework-specific measurements are passed in as callbacks. **Prompts:** P040 to P042.

**Shared schemas:** `HardwareProfile(platform, cpu_model, cores, ram_bytes, accelerators: [Accelerator(kind, name, memory_bytes, peak_flops_by_dtype)], os, python)`; `Measurement(value, unit, method: Literal["measured","estimated"], ci, n_reps)`; `PriceTable` (TOML, user-supplied, dated).

| Module | Purpose and scope | Public interface (sketch) | Foundations / reference | Key tests | Acceptance |
|---|---|---|---|---|---|
| compute_accounting | FLOP and parameter accounting | `transformer_params(cfg) -> int`; `transformer_flops_per_token(cfg, seq_len, include_attention=True)`; `training_flops(n_params, n_tokens) ≈ 6ND`; `inference_flops_per_token ≈ 2N` | Kaplan et al. 2020; Hoffmann et al. 2022 appendix | Analytical params equal torch count for every G0/G1 config (tested in P059) | Formulas documented with derivation |
| memory_profiling | Memory use | `rss_peak(fn)`; `tracemalloc_peak(fn)`; `training_memory_estimate(n_params, optimizer, precision, activations)` | Rajbhandari et al. 2020 (ZeRO memory accounting) | Estimate within 30% of measured on CPU for G0 | standard |
| energy_measurement | Energy use | `estimate_energy(duration_s, avg_power_w)`; `nvml_energy(fn)` (optional); `tdp_based_estimate(hardware, utilization)` | Henderson et al. 2020 | Every value tagged `measured` or `estimated` | No sudo, no background daemons |
| latency | Timing | `time_fn(fn, warmup, reps) -> Measurement` (perf_counter_ns, median + bootstrap CI) | Standard benchmarking practice | Sleep(10 ms) measured within 2 ms | standard |
| throughput | Rate measurement | `throughput(fn, units_per_call, warmup, reps)` | | Consistent with latency inversion | standard |
| hardware_profiles | Detect and describe hardware | `detect_hardware() -> HardwareProfile`; `peak_flops_lookup(accelerator, dtype)` from a reviewed TOML table | Vendor specs (cited per entry) | Detection works on Linux CI and macOS | Unknown hardware → `None` peak, never a guess |
| scaling_laws | Fit and apply scaling laws | `fit_chinchilla(N, D, L) -> ScalingFit` (L = E + A/N^α + B/D^β, Huber loss on log L); `compute_optimal(C, fit)`; `fit_power_law(x, y)` | Hoffmann et al. 2022; Besiroglu et al. 2024 replication | Recovers synthetic parameters; bootstrap CIs | Refuses extrapolation > 10x beyond data unless flagged |
| computational_efficiency | Normalized comparisons | `loss_per_flop`, `tokens_per_joule`, `mfu(achieved_flops, peak_flops)` | Chowdhery et al. 2022 (MFU) | MFU ≤ 1 enforced | standard |
| thermodynamic_models | Physical limits | `landauer_limit_joules(bits, T_kelvin)`; `efficiency_gap(measured_j_per_op, bits_per_op, T)` | Landauer 1961; Bennett 2003 | kT ln2 at 300 K ≈ 2.87e-21 J | Educational framing in docstring |
| pareto_analysis | Multi-objective tradeoffs | `pareto_front(points, senses)`; `non_dominated_sort`; `hypervolume_2d` | Deb et al. 2002 | Front points mutually non-dominated | standard |

**Cost estimation** (P042) is a CLI on top of these: `grit-cost estimate --params 514e6 --tokens 10e9 --hardware a100-80gb --prices prices.toml`. See [compute-cost.md](compute-cost.md).

---

## 7. `grit_discovery` (L2)

**Dependencies:** `grit_core`. **Prompts:** P043 to P045. A workbench for analyzing research processes and evidence. It records, links and analyzes. It doesn't generate hypotheses autonomously, doesn't modify code, and doesn't act on anything.

**Shared schemas:** `Work(id, doi, title, authors, year, venue, bibtex)`; `Claim(id, text, kind: Literal["definition","assumption","claim","conjecture","theorem","empirical_finding"], status, evidence: [EvidenceLink], source_work)`; `EvidenceLink(target, kind: Literal["supports","contradicts","replicates","fails_to_replicate"], strength_note)`; `ProvRecord(entity, activity, agent, used, generated_by, at)` (W3C PROV subset).

| Module | Purpose and scope | Public interface (sketch) | Foundations / reference | Key tests | Acceptance |
|---|---|---|---|---|---|
| literature | Bibliographic records | `Work.from_bibtex(text)` (bibtexparser); `normalize_doi`; `dedupe_works` | DOI handbook | DOI normalization idempotent | Malformed BibTeX → `ValidationError` |
| scientific_claims | Claims and evidence | `ClaimStore` (pure, immutable updates); `evidence_summary(claim)` | | Contradicting evidence always surfaces in summary | standard |
| provenance | PROV-style lineage | `ProvGraph`; `lineage(entity)`; `to_prov_json` | W3C PROV-DM 2013 | Lineage is a DAG | standard |
| hypotheses | Pre-registered hypotheses | `Hypothesis(id, statement, prediction, falsification_criterion, registered_at, content_hash)` | Nosek et al. 2018 (preregistration) | Hash changes on any edit | Registered hypothesis immutable |
| concept_graphs | Concept networks | `ConceptGraph` (shared with cognition via core.graphs types); `centrality`; `communities` (Louvain via networkx) | Newman 2010 | Community detection deterministic under seed | standard |
| analogy_analysis | Structural analogy | `structure_map(graph_a, graph_b, max_size) -> Mapping` (subgraph isomorphism via networkx VF2, size-limited) | Gentner 1983 | Finds planted isomorphic substructure | Hard size cap (default 50 nodes) |
| discovery_classification | Classify discoveries | `classify(discovery, scheme)` with a documented scheme (incremental, recombinant, paradigm) | Kuhn 1962; Uzzi et al. 2013 | Scheme loaded from TOML; unknown labels rejected | **provisional** scheme |
| intellectual_lineage | Citation and mentorship DAGs | `lineage_depth`; `common_ancestors`; `influence_paths` | | Works on reference citation DAG | standard |
| research_complexity | Problem complexity proxies | `dependency_depth(claim_graph)`; `prerequisite_count` | | Depth matches hand-computed | **provisional** |
| productivity_measurement | Bibliometric indicators with caveats | `h_index`, `g_index`, `field_normalized_citation(c, field_baseline)`; each returns value plus a caveat string | Hirsch 2005; Waltman 2016 review | h-index on textbook examples | Every metric carries its documented limitations |
| methodology_comparison | Meta-analysis | `fixed_effect(effects, variances)`; `random_effects_dl(effects, variances)` (DerSimonian-Laird); `i_squared`; `egger_test` | DerSimonian & Laird 1986; Higgins et al. 2003 | Matches metafor reference values on a published dataset | standard |
| causal_attribution | Qualitative causal attribution | `attribution_report(dag, outcome, candidates)` (uses `grit_core.graphs` backdoor sets; reports identifiability, not estimates) | Pearl 2009 | Non-identifiable effect reported as such | standard |

---

## 8. `grit_verify` (L5)

**Dependencies:** `grit_core` only (plus `cryptography` for signatures). **Prompts:** P046 (public types, protocols, signing), P054 to P058 (framework), P077 to P080 (model evaluation suites). Operationally independent: separate process, separate data store, own signing key.

**Shared schemas:** `EvaluationProtocol(id, version, suites, metrics, acceptance_criteria, statistical_plan, content_hash)` (frozen before an experiment is authorized); `EvaluationRequest(experiment_id, model_artifact_hash, protocol_hash)`; `EvaluationResult(request, metrics, per_dimension, ci, passed: dict[criterion, bool], evaluator_version, signature)`; `BenchmarkCommitment(benchmark_id, version, item_hashes_merkle_root, n_items, committed_at)`.

| Module | Purpose and scope | Public interface (sketch) | Foundations / reference | Key tests | Acceptance |
|---|---|---|---|---|---|
| contracts | Verification contracts | `VerificationContract(property, reference, tolerance)`; `verify(contract, observed) -> ContractResult` | | Tolerance boundaries inclusive/exclusive as documented | standard |
| invariants | Invariant suites over results | `InvariantSuite`; `run_suite(suite, artifact) -> SuiteReport` | | Planted violation detected | standard |
| independent_benchmarks | Benchmark registry and commitments | `commit_benchmark(items) -> BenchmarkCommitment` (Merkle root over sha256 of canonical items); `verify_commitment(items, commitment)` | Merkle 1987 | One-byte change breaks verification | Commitment published (audit log) before any experiment uses it |
| statistical_validation | Pre-registered comparisons | `StatisticalPlan(metric, test, alpha, correction, min_effect, n_seeds)`; `execute_plan(plan, results) -> Decision` | Uses core.statistics | Plan with 3 seeds and BH correction reproduces hand-computed decision | No plan, no decision |
| causal_inference | Effect estimation | `regression_adjustment`, `ipw`, `aipw` with bootstrap CIs | Hernán & Robins 2020 | Recovers known effect on synthetic confounded data | standard |
| regression_testing | Golden numeric baselines | `GoldenStore` (JSON files, tolerance per value); `compare_to_golden(results) -> RegressionReport` | | Drift beyond tolerance flagged with diff | standard |
| calibration | Model calibration evaluation | `evaluate_calibration(probs, labels)` (ECE, MCE, Brier decomposition, reliability bins with CIs) | Guo et al. 2017; Nixon et al. 2019 | Matches core.statistics.calibration | standard |
| replication | Replication checks | `replication_check(original, rerun, tolerance_spec) -> ReplicationReport` | Open Science Collaboration 2015 | Identical runs pass; seed-only differences within stated tolerance | standard |
| formal_verification | Run proof checkers | `run_checker(command_spec, inputs, timeout) -> FormalResult` in a sandboxed subprocess | | Timeout enforced; nonzero exit recorded as failure | optional |
| audit | Independent audit verification | `verify_audit_chain(path) -> AuditVerification` (reads the documented file format, not lab code) | Hash chains (Haber & Stornetta 1991) | Tampered middle record detected | Runs as a standalone CLI |

`grit_verify.protocols` defines `TextModel` (`score(tokens) -> logprobs`, `generate(prompt, config) -> text`, `metadata() -> ModelMetadata`). `grit_verify.model_eval` (P077 to P080) holds the language modeling, capability, calibration, robustness and generalization suites.

---

## 9. `grit_lab` (L3)

**Dependencies:** `grit_core`, `grit_verify` (public types only). **Prompts:** P047 to P053.

**Shared schemas:** `ExperimentSpec`, `ExperimentState`, `Transition`, `RunRecord`, `Budget`, `ArtifactRef`, `ReviewRecord`, `AuditEvent`. Field-level definitions in [data.md](data.md).

| Module | Purpose and scope | Public interface (sketch) | Key tests | Acceptance |
|---|---|---|---|---|
| experiment_specs | Experiment definitions | `ExperimentSpec.from_toml(path)`; `spec.content_hash`; `validate_spec(spec) -> list[Issue]` | Missing hypothesis, baseline, budget or protocol → issue | All 8 required fields enforced |
| datasets | Dataset references for experiments | `DatasetRef(id, version, content_hash)`; resolver against `grit_data` manifests (by file, no import) | Unknown version rejected | standard |
| baselines | Named baselines | `Baseline(name, run_id, verified_at)`; only `VERIFIED` runs can become baselines | Unverified run rejected | standard |
| execution | Job execution | `Executor.run(job) -> RunHandle`; local subprocess backend | Job exit code, stdout, stderr captured as artifacts | standard |
| artifacts | Content-addressed storage | `ArtifactStore.put(bytes|path) -> ArtifactRef`; `get(ref)`; `verify(ref)` | Corrupted byte detected; path traversal rejected | Atomic writes (temp + rename) |
| experiment_registry | Experiments over time | `Registry.create`, `transition`, `history`, `query` | Every transition persisted with audit event | standard |
| provenance | Run provenance | `RunRecord` with all 17 required fields; `capture_environment()` | Record round-trips through SQLite | No run without code commit (dirty tree flagged) |
| isolated_execution | Process isolation | subprocess with scrubbed env, `RLIMIT_AS`, `RLIMIT_CPU`, wall timeout, cwd sandbox, no inherited fds | Child can't read parent env secrets (test sets a canary var) | Limits documented per OS (macOS lacks some rlimits) |
| resource_budgets | Budgets and ledgers | `Budget(wall_s, cpu_s, gpu_h, est_flops, cost_usd, storage_bytes)`; `BudgetLedger.charge`, `remaining`; `BudgetExceeded` | Charge beyond limit raises; ledger append-only | A running job can't raise its own budget |
| authorization | Roles and permissions | `Role` enum; `PERMISSIONS: Mapping[Role, frozenset[Action]]`; `authorize(actor, action, resource) -> Decision`; separation of duties | Exhaustive matrix test; author can't approve own spec | Deny by default |
| human_review | Review records | `ReviewRecord(reviewer, decision, comment, at, spec_hash)`; review required for listed transitions | Review bound to spec hash; stale review rejected | standard |
| reporting | Experiment reports | `render_report(experiment) -> (markdown, json)` with all metadata, stats, signed eval, reviewed conclusion | Report without reviewed conclusion can't be archived | standard |

---

## 10. Observatory (L6, L7)

**Dependencies:** `services/api` depends on L1 to L5; `apps/observatory` depends on the API over HTTP only. **Prompts:** P082 to P095. Full UI architecture, instrument catalog and component tree in [observatory.md](observatory.md).

| Module | Purpose and scope | Public interface (sketch) | Key tests | Acceptance |
|---|---|---|---|---|
| API | Versioned HTTP API | `/api/v1/{health, instruments, compute/{id}, experiments, runs, evaluations, registry}`; problem+json errors; OpenAPI 3.1 | Contract tests against generated OpenAPI; authz tests | OpenAPI diff in CI flags breaking changes |
| frontend | Observatory app shell | Vite + React + TS; routes per workspace | Vitest + Playwright + axe | No a11y violations at serious or critical |
| research_studio | Integrated workspace | Workspace layout, panes, command palette | Keyboard-only navigation e2e | Every action reachable without a mouse |
| notebooks | Reproducible notebooks | `notebooks/` conventions; first cell records provenance; CI executes tutorials with nbclient | Tutorials execute in < 5 min total | standard |
| scientific_visualization | Chart primitives | `src/viz/*` D3 components with mandatory `units` and `provenance` props | Visual regression screenshots | Can't render an axis without a unit label (type error) |
| interactive_simulators | Live simulations | Instruments that re-run compute on parameter change (debounced) | e2e: change param → chart updates | p95 compute < 500 ms for default params |
| analytical_dashboards | Dashboards for runs and evals | Training dashboard, benchmark tables | Renders 10,000-point loss curves at 60 fps | standard |
| knowledge_maps | Concept and claim graphs | Force-directed graph view over registry + discovery | Graph with 2,000 nodes interactive | standard |
| curriculum | Learning paths | Ordered instrument sequences with exercises | Progress stored per user | standard |
| publication | Report export | Markdown + SVG figures + BibTeX bundle with provenance | Export reproducible (same inputs → same bytes) | standard |
