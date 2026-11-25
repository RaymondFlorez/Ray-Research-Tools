"""Groups F and G: grit_bio (Phase 3)."""

from .model import prompt

B = "packages/grit_bio/src/grit_bio"
BT = "packages/grit_bio/tests"
REG = "docs/registry/concepts/grit_bio.toml"
SPEC = "grit-engineering/specifications/scientific-modules.md section 4 (grit_bio)"
EDU = "Educational and scientific simulations of documented models only, with parameters taken from the cited paper and stored with the citation. No wet-lab protocols."

prompt(
    29, "Biochemistry, reaction kinetics and catalysis", "F", 3,
    objective="Create the `grit_bio` package with reaction network representation, mass-action and stochastic kinetics, conservation law detection, and enzyme kinetics with fitting.",
    context=f"Reaction networks are the simplest physical systems that compute and regulate. {EDU}",
    deps=[28, 11, 13],
    inspect=[SPEC, "Feinberg (2019) Foundations of Chemical Reaction Network Theory; Michaelis & Menten (1913)"],
    scope=[
        "Package skeleton (deps: grit-core, grit-dynamics).",
        "`biochemistry.py`: `Species`, `Reaction`, `ReactionNetwork` (validated: species referenced exist, stoichiometry integer), `stoichiometry_matrix`, `conservation_laws` (left nullspace via core.algebra, rationalized when possible).",
        "`reaction_kinetics.py`: `mass_action_rhs(net)`, `simulate_deterministic`, `simulate_stochastic` (Gillespie via grit_dynamics) with volume scaling.",
        "`catalysis.py`: Michaelis-Menten, Hill, competitive/uncompetitive/noncompetitive inhibition, `fit_michaelis_menten(S, v)` with standard errors.",
        "`parameters/` TOML files for any literature parameter set, each with citation.",
    ],
    out=["Thermodynamic feasibility checks.", "SBML import (later, if needed)."],
    create={
        "packages/grit_bio/pyproject.toml": "package metadata",
        f"{B}/__init__.py": "public API", f"{B}/py.typed": "marker",
        f"{B}/biochemistry.py": "reaction networks", f"{B}/reaction_kinetics.py": "kinetics", f"{B}/catalysis.py": "enzyme kinetics",
        f"{B}/parameters/README.md": "parameter file conventions (citation required)",
        f"{BT}/test_biochemistry.py": "tests", f"{BT}/test_kinetics.py": "tests", f"{BT}/test_catalysis.py": "tests",
        REG: "grit_bio registry",
    },
    tests=["Conserved moieties constant along trajectories (1e-9).", "Stochastic mean converges to deterministic as volume grows (CI test).", "MM fit recovers Vmax, Km within 5% from synthetic noisy data (seeded)."],
    verify=["uv sync --all-packages", "uv run pytest packages/grit_bio -q", "make check"],
    acceptance=["Every literature parameter has a citation.", "Invalid networks rejected with named species."],
    complexity="M",
    review=["scientific"],
)

prompt(
    30, "Regulatory networks, systems biology and homeostasis", "F", 3,
    objective="Add gene regulatory motifs (toggle switch, repressilator, feed-forward loops, Boolean networks), metabolic control analysis and homeostasis models with perfect adaptation tests.",
    context=f"Regulation and homeostasis are biological feedback control, a recurring GRIT theme. {EDU}",
    deps=[29, 27],
    inspect=[SPEC, "Gardner et al. (2000); Elowitz & Leibler (2000); Mangan & Alon (2003); Kacser & Burns (1973); Yi et al. (2000)"],
    scope=["`regulatory_networks.py`: toggle switch, repressilator, coherent/incoherent FFL, `boolean_network(rules)` with synchronous/asynchronous update and attractor enumeration (small n).", "`systems_biology.py`: `steady_state`, `sensitivity_analysis` (normalized local), flux control coefficients.", "`homeostasis.py`: integral feedback model, `perfect_adaptation_test(model, perturbation)`."],
    out=["Large-scale network inference."],
    create={f"{B}/regulatory_networks.py": "regulatory motifs", f"{B}/systems_biology.py": "steady states and control analysis", f"{B}/homeostasis.py": "homeostasis", f"{BT}/test_regulatory.py": "tests", f"{BT}/test_homeostasis.py": "tests"},
    modify={f"{B}/__init__.py": "export", REG: "entries"},
    tests=["Toggle switch: two stable equilibria and one saddle with published params.", "Repressilator oscillates (Lyapunov or period detection) with published params.", "Flux control coefficients sum to 1 (summation theorem) on a linear pathway.", "Integral feedback: perfect adaptation to step."],
    verify=["uv run pytest packages/grit_bio -q", "make check"],
    acceptance=["Each motif reproduces its cited qualitative behavior in a test."],
    complexity="M",
    review=["scientific"],
)

prompt(
    31, "Genetics and population dynamics", "F", 3,
    objective="Add population genetics (Hardy-Weinberg, Wright-Fisher, Moran, Kimura fixation) and population dynamics (logistic, Lotka-Volterra, competition, SIR/SEIR educational models).",
    context=f"Selection, drift and population feedback are the original recursive improvement processes. {EDU}",
    deps=[29, 25],
    inspect=[SPEC, "Kimura (1962); Lotka (1925); Kermack & McKendrick (1927)"],
    scope=["`genetics.py`: `hardy_weinberg`, `wright_fisher(N, p0, s, mu, generations, rng, replicates)`, `moran`, `fixation_probability_kimura`.", "`population_dynamics.py`: logistic, LV, competitive LV, SIR, SEIR with R0 and final size relation."],
    out=["Epidemic forecasting for real populations."],
    create={f"{B}/genetics.py": "population genetics", f"{B}/population_dynamics.py": "ecological dynamics", f"{BT}/test_genetics.py": "tests", f"{BT}/test_population.py": "tests"},
    modify={f"{B}/__init__.py": "export", REG: "entries"},
    tests=["Simulated fixation frequency within CI of Kimura's formula (1e4 replicates, slow).", "LV conserved quantity constant (1e-8).", "SIR final size matches implicit relation."],
    verify=["uv run pytest packages/grit_bio -q", "uv run pytest packages/grit_bio -m slow -q", "make check"],
    acceptance=["Educational framing in SIR docstrings (not for forecasting)."],
    complexity="S",
)

prompt(
    32, "Evolutionary landscapes and comparative biology", "F", 3,
    objective="Add NK fitness landscapes, adaptive walks, replicator dynamics, quasispecies, and allometric scaling fits with empirical-data provenance requirements.",
    context=f"Fitness landscapes are search spaces; adaptive walks are search. Comparative biology connects scaling laws across organisms and machines. {EDU}",
    deps=[31, 11, 17],
    inspect=[SPEC, "Kauffman (1993); Taylor & Jonker (1978); Eigen (1971); Kleiber (1932); West et al. (1997)"],
    scope=["`evolutionary_landscapes.py`: `nk_landscape(N, K, rng)`, `adaptive_walk(landscape, start, rule, rng)`, landscape statistics (number of local optima, autocorrelation), `replicator_dynamics`, `quasispecies`.", "`comparative_biology.py`: `allometric_fit(mass, y)` (log-log OLS with CIs), `kleiber_reference`; empirical inputs must be a `CitedDataset(values, citation, license)`."],
    out=["Phylogenetic comparative methods (PGLS). Note as future work."],
    create={f"{B}/evolutionary_landscapes.py": "landscapes and replicators", f"{B}/comparative_biology.py": "allometry", f"{BT}/test_landscapes.py": "tests", f"{BT}/test_comparative.py": "tests"},
    modify={f"{B}/__init__.py": "export", REG: "entries"},
    tests=["K=0 landscape has a single optimum.", "Replicator dynamics stays on the simplex (property).", "Synthetic allometry exponent 0.75 recovered within CI.", "Uncited empirical input rejected."],
    verify=["uv run pytest packages/grit_bio -q", "make check"],
    acceptance=["Landscape statistics match published NK trends (mean local optima increase with K) in a seeded test."],
    complexity="M",
    review=["scientific"],
)

prompt(
    33, "Neuron models", "G", 3,
    objective="Add single-neuron models (LIF, Izhikevich with published presets, Hodgkin-Huxley, FitzHugh-Nagumo) and f-I curve analysis.",
    context="Neurons are the reference biological computing element; their dynamics anchor GRIT's comparative biology of intelligence.",
    deps=[29],
    inspect=[SPEC, "Izhikevich (2003); Hodgkin & Huxley (1952); FitzHugh (1961)"],
    scope=["`neuron_models.py`: `lif(params, I, dt, T)`, `izhikevich(preset|params, I, dt, T)` with presets RS, IB, CH, FS, LTS; `hodgkin_huxley` with canonical squid axon params; `fitzhugh_nagumo`; spike detection; `fi_curve(model, currents)`."],
    out=["Multi-compartment models."],
    create={f"{B}/neuron_models.py": "neuron models", f"{BT}/test_neuron_models.py": "tests"},
    modify={f"{B}/__init__.py": "export", REG: "entries"},
    tests=["HH resting potential ≈ -65 mV and spike threshold behavior.", "Izhikevich presets reproduce published spike patterns (spike count and timing within tolerance from the paper's figure).", "LIF f-I curve matches analytic formula."],
    verify=["uv run pytest packages/grit_bio/tests/test_neuron_models.py -q", "make check"],
    acceptance=["Units: mV, ms, pA/nA, documented per model."],
    complexity="M",
    review=["scientific"],
)

prompt(
    34, "Synaptic dynamics and plasticity", "G", 3,
    objective="Add synapse models (exponential, alpha, Tsodyks-Markram short-term plasticity) and learning rules (pair STDP, BCM, Oja, Hebb).",
    context="Plasticity rules are biological learning algorithms; comparing them with machine learning rules is part of GRIT's comparative program.",
    deps=[33],
    inspect=[SPEC, "Tsodyks & Markram (1997); Bi & Poo (1998); Bienenstock et al. (1982); Oja (1982)"],
    scope=["`synaptic_dynamics.py`: conductance-based synapses, STP model.", "`plasticity.py`: `stdp_pair`, `stdp_window`, `bcm`, `oja`, `hebb` operating on weight arrays."],
    out=["Triplet STDP, neuromodulated rules (future)."],
    create={f"{B}/synaptic_dynamics.py": "synapses", f"{B}/plasticity.py": "plasticity rules", f"{BT}/test_synapses.py": "tests", f"{BT}/test_plasticity.py": "tests"},
    modify={f"{B}/__init__.py": "export", REG: "entries"},
    tests=["STP paired-pulse ratio matches closed form.", "Oja converges to first principal component (cosine > 0.99).", "STDP window antisymmetric with given parameters."],
    verify=["uv run pytest packages/grit_bio -q", "make check"],
    acceptance=["Each rule has a convergence or shape test."],
    complexity="S",
)

prompt(
    35, "Neural circuits and network simulation (milestone M3)", "G", 3,
    objective="Add Wilson-Cowan rate models and a vectorized sparse spiking E/I network with raster output, meet the performance target, and close Phase 3.",
    context="Small circuits show emergent dynamics (balance, oscillation) from simple units. Performance matters because the NE5 instrument runs these interactively.",
    deps=[34, 26],
    inspect=[SPEC, "Wilson & Cowan (1972); Brunel (2000)"],
    scope=["`computational_neuroscience.py`: `wilson_cowan`, `spiking_network(n_e, n_i, p_conn, model, weights, rng)` with sparse CSR connectivity (scipy.sparse), `raster`, firing rate and CV ISI statistics.", "Benchmark: 1,000 LIF neurons, 1 s at dt=0.1 ms.", "`docs/milestones/M3.md`."],
    out=["GPU simulation; external simulators (Brian2, NEST)."],
    create={f"{B}/computational_neuroscience.py": "circuits", f"{BT}/test_circuits.py": "tests", "benchmarks/bio/bench_spiking.py": "spiking benchmark", "docs/milestones/M3.md": "Phase 3 milestone report"},
    modify={f"{B}/__init__.py": "export", REG: "entries"},
    tests=["Asynchronous irregular regime: CV ISI in [0.8, 1.2] for Brunel-style parameters.", "Wilson-Cowan limit cycle for oscillatory parameter set.", "Seeded network reproducible (raster hash)."],
    verify=["uv run pytest packages/grit_bio -q", "uv run pytest benchmarks/bio -m bench -q", "make check"],
    acceptance=["Benchmark < 10 s on the development MacBook (result in M3 report with hardware profile).", "All bio models reproduce cited behavior (M3 table)."],
    complexity="M",
    review=["scientific"],
)
