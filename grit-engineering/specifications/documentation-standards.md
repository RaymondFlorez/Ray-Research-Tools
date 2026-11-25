# Documentation Standards and Scientific Traceability

## The traceability chain

```
Scientific concept → Mathematical definition → Software module → Test → Experiment → Evidence
GRIT-C-0042          docs/registry/…          grit_core.information.kl   test_kl_nonnegative   ALPHA-G1-S2   eval result + report
```

Every link is machine-checkable:

| Link | Where recorded | Checked by |
|---|---|---|
| Concept → definition | `docs/registry/concepts/<package>.toml`: `definition_tex`, `treatise_ref` | `scripts/check_registry.py` (schema, unique ids, required fields by status) |
| Definition → module | registry `implementations = ["grit_core.information.kl"]` | checker imports the dotted path |
| Module → concept | docstring line `Concept: GRIT-C-0042` | checker greps public functions |
| Module → test | `@pytest.mark.traces("GRIT-C-0042")` | pytest plugin collects markers; checker fails if an `implemented` concept has none |
| Test → experiment | `ExperimentSpec.concept_ids` | lab validation |
| Experiment → evidence | signed evaluation + report; registry `evidence = ["ALPHA-G1-S2@verified"]` | report generator; checker validates refs exist |

`make traceability` generates `docs/traceability.md`: a matrix of concepts with their status, implementations, test counts, experiments and evidence (P112).

## Registry entry

```toml
[[concept]]
id = "GRIT-C-0042"
name = "Kullback-Leibler divergence"
kind = "definition"              # definition | assumption | claim | conjecture | theorem | empirical_finding
status = "implemented"           # proposed | provisional | implemented | verified | retired
treatise_ref = "Ch. 3 §3.2"      # or "external" with citation
citation = "Cover & Thomas 2006, §2.3"
definition_tex = "D_{KL}(p\\|q) = \\sum_i p_i \\log \\frac{p_i}{q_i}"
assumptions = ["p and q are distributions on the same finite support", "0 log 0 = 0"]
implementations = ["grit_core.information.kl"]
evidence = []
notes = ""
```

Rules: `provisional` concepts must have a `notes` entry saying what's provisional and who confirms it. Conjectures can't have `status = "verified"`. A `claim` with `status = "verified"` needs at least one evidence ref.

## Docstrings

NumPy style. Every public scientific function documents: what it computes (with the formula in LaTeX), parameters with units, returns with units, raises, the concept ID, the reference citation, and at least one example that runs as a doctest.

```python
def kl(p: ProbVector, q: ProbVector, *, base: float = math.e) -> float:
    r"""Kullback-Leibler divergence :math:`D_{KL}(p \| q) = \sum_i p_i \log(p_i / q_i)`.

    Concept: GRIT-C-0042
    Reference: Cover & Thomas (2006), Elements of Information Theory, §2.3.

    Parameters
    ----------
    p, q : ProbVector
        Distributions on the same support.
    base : float
        Logarithm base. ``math.e`` gives nats, ``2`` gives bits.

    Returns
    -------
    float
        Divergence in units of ``log base``. ``math.inf`` if some ``p_i > 0`` where ``q_i = 0``.

    Examples
    --------
    >>> kl(ProbVector.of([0.5, 0.5]), ProbVector.of([0.5, 0.5]))
    0.0
    """
```

## Document types

| Document | Location | Template | Generated from | Human-written part |
|---|---|---|---|---|
| ADR | `docs/decisions/ADR-NNNN-slug.md` | [adr.md](../templates/adr.md) | | all |
| Module spec | `docs/specifications/<package>.md` | | this spec | refinements |
| API reference | docs site | | mkdocstrings + OpenAPI | |
| Math docs | `docs/math/` | | | all, KaTeX |
| Developer guide | `docs/guides/` | | | all |
| Tutorial | `notebooks/tutorials/` | | | all, executed in CI |
| Model card | `docs/models/<model>@<version>.md` | [model-card.md](../templates/model-card.md) | run record + signed eval | intended use, limitations |
| Dataset card | `docs/datasets/<id>@<version>.md` | [dataset-card.md](../templates/dataset-card.md) | manifest | motivation, known issues |
| Experiment report | `experiments/<domain>/<id>/report.md` | [experiment-report.md](../templates/experiment-report.md) | lab + eval | conclusion (reviewed) |
| Incident report | `docs/security/incidents/` | | | all |

## Writing style

Plain, specific, short. Units on every number. State uncertainty directly ("we don't know", "n=3 seeds, CI overlaps zero"). No marketing adjectives. Every claim of a result links to its evidence.

## Notebooks

- First cell: `grit_core.provenance.notebook_header()` prints commit, environment hash, seeds, date.
- No hidden state: CI runs them top to bottom with `nbclient` on a clean kernel.
- Outputs stripped on commit (`nbstripout`), except tutorials whose rendered output is part of the docs (rendered in CI, not committed).
- Data: only from `grit_data` manifests or synthetic generators with seeds.
