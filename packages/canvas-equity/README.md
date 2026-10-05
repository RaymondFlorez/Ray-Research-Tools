# @picasso/canvas-equity

PRD 5.2 and 5.8's factor attribution. 60 tests.

| Module | What it is |
|---|---|
| `transcript.ts` | Diarized, section-tagged transcripts, and the `Metric` type that refuses a number with no evidence. |
| `subtext.ts` | The five earnings metrics, each citing the sentences that produced it. |
| `eventStudy.ts` | CAR across three benchmark models, with event clustering measured. |
| `factors.ts` | FF5 + quality, reporting the fit and the collinearity alongside the betas. |
| `ols.ts` | Least squares with its diagnostics exposed. |
| `nodes.ts` | The 5.2 node constructors — including two that refuse to compute. |

## Every number cites its sentences

> "Each metric outputs both a number and the specific spans that produced it,
> so the analyst can click a score and land on the sentences."

That is only true if something enforces it, so `metric()` throws on a non-zero
value with no spans. Each of these five is a lexical count dressed up as an
insight, and the spans are what keep that honest: a hedging density of 33 is
not a finding, but thirty-three specific sentences are — and an analyst who
reads them will sometimes conclude the number is noise. That is the correct
outcome.

Sections are the unit of analysis, never "the whole call". Prepared remarks are
written, lawyered and rehearsed; the Q&A is not. A hedging density across both
measures how long the prepared section was relative to the questions, which
varies by company and quarter for reasons that have nothing to do with what
anyone is hiding.

The metric worth the most is **question evasion**, because the PRD defines it
operationally — "does the answer contain the entities the question asked
about" — which is checkable rather than interpretive. An executive asked about
China and datacenter gross margin who answers about "the overall demand
environment" has evaded, whatever the tone was. The spans point at the
*answer*, since the question is already in front of the reader.

**Tone delta carries its own caveat.** Four trailing calls do not support a
standard deviation — a sigma from four observations has roughly 41% relative
error — so the z is produced, because the PRD asks for it and it is not
useless, but it ships with a caveat naming the sample size and that error.
Same failure the model-rollback rule in `canvas-guard` had, given a weaker
version of the same treatment.

## Event studies: the clustering claim had to be corrected

The three benchmark models are the easy part. The standard error is where an
event study lives or dies, and the first version of this module made a claim
the simulation then refuted.

The claim was that clustered event dates inflate significance because the
events "share that day's market-wide surprise". Measured under a null with no
abnormal return at all:

```
spread events reject at 3.3%, same-day events reject at 5.3%  (nominal 5%)
```

No effect. The reason is that the simulated world had one common factor and
the market model spanned it completely, so the residuals on a shared date
really were independent.

The concern was right and the simulation was wrong. What breaks the test is
common variation the benchmark **does not span** — a sector shock a market
model has never heard of, carried by all twenty residuals on the same day.
Adding an orthogonal industry factor:

```
spread events reject at 3.3%, same-day events reject at 60.3%  (nominal 5%)
```

### A second finding the measurement handed over

While fixing the above, the "spread" arm was rejecting at 12.3% when it should
have been at 5%. The events were on twenty distinct dates — perfectly
unclustered by every date-based count — but five days apart with an eleven-day
window, so consecutive windows overlapped by six days and shared the same
unspanned shocks.

```
events 5 days apart (windows overlap):  9.3%
events 30 days apart:                   3.3%   (nominal 5%)
```

`Clustering.overlappingPairs` now detects it, and the warning says plainly that
the calendar-time statistic **does not repair it**, because the dates genuinely
differ so every event is still its own calendar-time observation. The fix is
wider spacing or a calendar-time portfolio regression, and saying so is the
only honest move available.

## Factor exposures are mostly diagnostics

The regression is four lines. The value is in the three ways an exposure lies:

- **A beta with no fit behind it.** 1.4 on an R-squared of 0.06 is a number,
  not an exposure. Warned below 0.2.
- **Collinear factors.** HML and CMA are correlated enough in most samples that
  their loadings swing while the fit barely moves. VIF is computed per
  regressor and surfaced above 5. An exactly-collinear column reports
  `Infinity` rather than a clamped 1e12, because 1e12 reads like a measurement
  and this is not one.
- **A window chosen after the fact.** Nothing here fixes that, but the window
  and observation count travel with the result.

A custom factor gets no special treatment: an analyst who builds "quality" out
of the same inputs as RMW sees a VIF that says so.

## Factor attribution: exact, and exactly wrong when exposure moves

PRD 5.8 lists factor attribution among a backtest's outputs. `factorAttribution`
regresses per-bar returns on the factors once; OLS with an intercept leaves
residuals summing to zero, so `T·alpha + Σ beta_k·Σf_k` equals the summed
return to rounding (the tests hold it below 1e-12). That sum is additive. An
equity curve compounds, and the difference is reported as its own
`compounding` line rather than spread across the factors Carino-style, which
would make every line slightly wrong so that the total can be exactly right.

Exact is not the same as right. A strategy long the market for half the window
and short it for the other half has a static beta near zero, so the market
P&L moves into alpha. Measured on 500 seeded bars where the true market
contribution is 0.3446 and the true alpha 0.100: the static fit reports alpha
0.5213 and market −0.0096, with no residual to hint at a problem.

`rollingAttribution(returns, factors, window)` estimates each bar's betas from
the `window` bars before it — nothing from the bar itself or later, which a
test checks by moving the last return and seeing only the residual change. On
the same series with a 60-bar window it reports market 0.117 and alpha 0.1192
against a truth (over the bars it can attribute) of 0.1425 and 0.088, and the
0.2755 it cannot explain is reported as residual, not folded into alpha. The
lag is the cost: for up to a window after a change in exposure, the betas
still describe the old one.

Through the real backtest engine, `canvas-integration/test/attribution.test.ts`
measures what happens when the factor series is joined one bar off: a long
book's market line falls from 0.4065 to under 0.005 and the whole return,
0.4256, is reported as alpha.

## Four scoring nodes that refuse to compute

`ERQ12Node` and `AXM8Node` are named in 5.2 as platform rubrics — ERQ12 "from
LEDGER" — with no definition anywhere available: no inputs, no components, no
scale, no weighting. Both are built with their ports, so a canvas referencing
them loads and wires, and both are marked `error` with `code:
'unspecified_rubric'` and a message naming what is missing.

A rubric invented to fill the gap would carry the name of a real house
methodology while computing something nobody agreed to. An analyst reading
"ERQ12: 7.4" would have no way to know it was fabricated, which is strictly
worse than a gap.

PRD 3.3 lists two more under `ScoringNode` — "a platform framework (AXM-8,
ERQ-12, SIV, BPS)" — and defines those nowhere either; not even the acronyms
are expanded. They had no node at all, which is quieter than a refusal and
worse: a canvas referencing one had nothing to load. `sivNode` and `bpsNode`
refuse on the same terms, and `scoringNode(id, framework)` covers all four
with an exhaustive switch, so a framework that one day gains a specification
has to be wired in on purpose.

## What is not here

- **No holdings-based attribution.** Attribution here is returns-based: it
  infers exposure from co-movement. A backtest knows its positions exactly,
  and attributing from them (per-name betas times weights) would not lag a
  change in exposure. That needs per-instrument factor loadings, which nothing
  here estimates.
- **No Carino or Menchero linking.** The compounding difference is one line,
  not distributed across factors.

- **No transcript ingestion.** Diarization and section tagging are ASR and
  pipeline work; these modules take the tagged result.
- **No lexicon research.** The hedging, forward-looking and tone word lists are
  reasonable and not validated against labelled data. They are the kind of
  thing 4.7's eval harness would calibrate.
- **No matched-firm selection.** The matched-firm event study takes the control
  as a function; choosing it (size, industry, book-to-market) is its own
  methodology.
