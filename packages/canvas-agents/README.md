# @picasso/canvas-agents

PRD 4.5's multi-agent layer, plus the provenance rule that makes its output
safe to wire into anything.

| Module | What it is |
|---|---|
| `blackboard.ts` | The typed shared workspace. Facts are append-only; `contested` is derived from the conflict set, not asserted by the agent that wrote the fact. |
| `coordinator.ts` | Turn allocation as wave scheduling over the plan's dependency graph, the shared budget, and the join. |
| `reconciler.ts` | Every number in the answer traces to a cell, or it is a finding. |
| `critic.ts` | The four deterministic critiques that run at every independence tier, and Appendix C.5's ladder. |
| `provenance.ts` | A model-sourced fact cannot feed a compute node without an override that records who, when and why. |
| `digest.ts` | The return card: four lines, deterministic in shape, composed without a model. |
| `redteam.ts` | The suite phase 6 exits on. |
| `context.ts` | PRD 4.6's context builder: the lineage slice, the spatial neighborhood, and the budget that decides what reaches the prompt. |

## The exit criterion

> **Reconciler catches 100 percent of injected numeric mismatches in the
> red-team suite.** — Appendix B, phase 6

Measured by `runRedTeam()`:

```
red team: 21/21 caught, 0/8 false positives, 1 documented gap
```

The second number is the one that makes the first mean anything. A checker
that rejects every draft catches 100 percent of injections, so the suite
carries eight clean variants — an honest rounding, a hedged total, a unicode
minus from a copied cell, a form number in the prose, a date, a percent alias
— and none of them may raise a blocking finding.

Every injection also declares the finding kind it should produce, and
`misattributed` is asserted empty. Catching the sign flip for the wrong reason
is not catching it: the analyst reads the finding, and a wrong one sends them
to the wrong place.

## Why the catch rate is structural

The tempting implementation pulls numbers out of prose and looks for a cell
that is close to each one. It fails in both directions: a hallucinated total
that happens to sit near some other cell passes, and an honest number the
matcher cannot place fails.

So the contract runs the other way. The Scribe emits text *with spans*, every
numeral in the text must lie inside a span, and every span names the fact it
renders. Reconciliation is then a chain of equalities:

```
text span  ->  fact.value  ->  cell.value at this cacheKey
```

with units compared at every link and never converted, plus a fourth link for
derived facts (a total is recomputed from its operands) and a fifth for
document-sourced facts (the cited character range has to contain the number).
A number with no handle is not an unparseable number — it is an unsourced one,
and that is the finding.

Every injection in the suite breaks one of those links.

### The tolerance rule

The rendering declares the precision. A narrative that says `-3,870` is
claiming the ones digit: `-3,870.4` in the cell is a correct rounding,
`-3,880` is not. So the tolerance is half a unit in the last displayed place,
read off the text rather than configured.

A fixed relative tolerance would pass `-3,900` against `-3,870` — 0.8 percent,
inside most defaults — which is exactly the PRD's motivating failure with a
smaller typo. A number that wants slack has to say so in the text: `about
4,200` widens to a one percent band, where the analyst can see it.

### The gap that is still a gap

`KNOWN_LIMITS` holds one case, asserted to stay uncaught: a number that is
correct, traceable, in the right unit, and attached to the wrong idea — the
tech leg's vega presented as the semis leg's, where both are dollars and both
are live cells. Nothing short of reading the sentence distinguishes those, and
reading the sentence is the Critic's job. If a later change catches it, the
test fails and the entry should be deleted with the change that earned it.

## The Critic without a model

Appendix C.5 moves the mechanical half of the Critic off the model entirely,
and this package treats that as the primary path rather than the fallback.
`critique()` with `available: []` still returns:

- **assumption extraction** — params on wired nodes whose input port has
  nothing connected, and causal mappings estimated below R² 0.2;
- **base rate** — the analyst's own hypothesis tracker, via
  `@picasso/canvas-hypothesis`;
- **disconfirming retrieval** — the same search with the thesis negated;
- **sensitivity sweep** — one assumption at a time, one sigma, reporting which
  single change flips the conclusion.

Only `prose` goes missing. The ladder is walked in order and never scored:
independence is not a quantity the Critic trades for cost, because a score
that can exchange it will exchange it every time.

## Provenance

`checkWire` refuses a model-sourced fact into a compute node, and refuses it
again when the override is a bare flag. An override that does not record an
approver, a time and a reason is indistinguishable from no override, which is
what it would become after one refactor. `OverrideLog` keeps the record
outside the edge, because the edge can be deleted and the fact that somebody
approved a fabricated number into a simulation should outlive it.

## The digest

Composed without a model: the selection, the ranking, the numbers and the line
count are computed here, and a supplied prose writer may only restate a line —
never add, drop or reorder one. "Deterministic in shape" is unachievable if
the model chooses what to mention, because two identical mornings would then
produce two different cards.

Measured cost on the policy's 8B row: **0.0033 cents**, against the PRD's
"about 0.02 cents". The payload is a few hundred characters of structured
detector output; the series data never reaches the prompt.

## Context assembly

PRD 4.6 builds the prompt from the canvas rather than from chat history, and
`assembleContext` implements it: the question and the selection, the **lineage
slice**, the spatial neighborhood, pinned canvas memory, retrieved evidence.

Three of its decisions are not restatements of the specification.

**Ancestors, not descendants.** The lineage slice is what the selected value
was computed *from*. The obvious generalisation — everything connected — pulls
in the node's descendants, which are the conclusions drawn from it; handing
those to a model asked to derive them produces agreement with the canvas
because it was read off the canvas. Ancestors carry their distance from the
selection, so a slice that has to be cut is cut at the far end.

**A table is never inlined, structurally.** `tableContext` is the only way to
put a table in a context and it cannot produce rows, because it is never given
any: it takes a schema, summary statistics and the handle of the tool that can
query the table. A 2.5-million-row table enters the prompt as **25 tokens**.

**The classification travels.** Every item carries the classification of what
it came from and the assembled context reports the most sensitive one *that
was kept* — a class that got dropped at the ceiling is not reported, because
the gate would then refuse a payload that does not contain it.

### What the floors actually protect

The PRD gives the per-category floors a purpose: "so that retrieval never
crowds out the lineage slice". Measured, that is not what they do here. The
greedy fill is greedy *within* the priority order, so a category is exhausted
before the next is looked at: forty retrieved chunks scoring 100 against six
ancestors scoring 1 leaves the lineage slice **fully intact with no floor at
all**, and the test asserts it both ways.

What does get crowded out is everything below whichever category is large. A
selection with 400 ancestors under a 1,000-token ceiling spends **1,000 on
lineage and 0 on memory** — the analyst's own stated thesis never reaches the
prompt. That is the failure the floors are load-bearing against, and the
README says so rather than repeating the sentence from the PRD.

A floor larger than its category's content is released rather than held: 80
reserved for a lineage slice holding one 10-token ancestor leaves 90 for
evidence under a 100-token ceiling, not 20.

## What is not here

- No real model calls. Every agent in the runtime is a function the caller
  supplies, and the Critic's prose is a callback. What is measured is the
  runtime, the reconciliation and the deterministic critiques.
- No retrieval index. `disconfirming` takes a `Retrieve` function, and
  `assembleContext` takes evidence already ranked by one.
- No tokenizer. `approximateTokens` is four characters to a token, which
  under-counts code and over-counts long prose; `countTokens` takes a real one.
  The budget's guarantees are exact in whatever unit it is handed.
- `assembleContext` does not decide what a node's latest value is. A
  `PicassoNode` does not carry one — `NodeRuntimeState` holds a status, a cache
  key and a cost — so the value is a caller-supplied function rather than a
  field invented here for two places to disagree about.
- The blackboard runs in one process. The PRD's `agent-runtime` is a Python
  service with concurrent sessions; the scheduling semantics here are the
  contract it would implement, not the service.
