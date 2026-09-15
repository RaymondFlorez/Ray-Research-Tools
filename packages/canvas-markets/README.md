# @picasso/canvas-markets

PRD 5.5 (crypto) and 5.6 (prediction markets), with Appendix C.4's de-vigging
decision.

| Module | What it is |
|---|---|
| `devig.ts` | C.4's routing rule: market type decides the treatment, and the binary-CLOB row is a correctness fix. |
| `probability.ts` | `ProbabilityCurveNode`, which cannot be built without its resolution criteria. |
| `calibration.ts` | The market's Brier score and the analyst's, on the same contracts. |
| `weights.ts` | A probability becoming an actual weight in an expected-value calculation. |
| `chain.ts` | Crypto market and on-chain series, emitted as ordinary `series` ports. |

## C.4: the routing rule is the decision

| Market type | Treatment |
|---|---|
| Binary CLOB (Polymarket, Kalshi) | **No de-vig.** Microprice with a spread-width band. |
| Multi-outcome summing above 1 | Multiplicative |
| Sportsbook-derived | Multiplicative, with Shin surfaced by the divergence flag |

The first row is a correctness fix rather than a preference. A Polymarket
binary is a collateralized two-outcome book: YES and NO are the two halves of a
dollar and there is no bookmaker taking a margin out of the middle. Treating
the bid-ask spread as vig and normalizing it away **introduces** a bias.
Measured on a book of `0.34 bid / 0.36 ask`:

```
normalizing the asks:  YES = 0.3529
the book's microprice: YES = 0.3599
                       ---------------
                       69.8 bps of pure artefact
```

on a market whose whole spread is 100bps — and the direction depends only on
which side happens to be thicker, so the artefact moves when the book does.

### The microprice runs the opposite way to the obvious guess

I reached for the wrong intuition first and the test caught it. A book showing
`0.34` bid for 50,000 against `0.36` ask for 200 does **not** sit near 0.34
"because that's where the depth is". It sits at 0.3599, because the thin side
is the side about to be consumed: fifty thousand lots of buying interest
against two hundred offered is a queue that will lift the ask. Size on a side
pushes the price *away* from that side.

### The divergence flag fires on the absolute gap and ranks on the relative one

Shin runs silently alongside multiplicative, and the node shows both when they
differ by more than 150bps. Ranking *which* outcome to show turned out to
matter: in a two-outcome book the absolute gaps are identical, because both
sets sum to one, so whatever Shin takes from one side it gives back to the
other. Ranking by absolute gap was a coin flip, and it landed on the
favourite — explaining a favourite-longshot effect while pointing at the
favourite.

On `[0.92, 0.14]` the gap is 221bps either way. That is 2.5% of the
favourite's price and **16.7%** of the longshot's, and the analyst sizing a
position off the longshot is the one whose number moved.

## Resolution criteria are enforced, not documented

> "Most prediction market mistakes are resolution-criteria mistakes, so the
> criteria are first-class, not a footnote."

A criteria field that can be left empty is a footnote with a longer name, so
`curve()` throws without one. The failure mode is specific: two venues list
what looks like the same contract, the prices differ by eight points, and the
difference is entirely that one settles on the BLS initial print and the other
on a revision. An analyst who cannot see both settlement texts reads that
spread as an opportunity.

So `crossVenue` compares criteria **first** and returns `different_questions`
rather than a divergence when they differ. Whitespace and case are normalized
away; the deciding source never is.

## What the type claim is worth

> "normalized into the same `series` type as everything else, which is the
> point: a crypto on-chain series and an equity fundamental series wire into
> the same regression node."

That is a claim about types, and `test/chain.test.ts` checks it through
`canvas-core`'s real `connect` rather than asserting it in prose: a
`ChainMetricNode` and an equity `DataTile` both wire into the two inputs of one
`TransformNode`.

A second thing I had backwards: I assumed a daily-into-quarterly wire would
get a silent `resample` adapter. It does not. The only implicit coercion in
the entire lattice is `series -> scalar`, and the comment above it says why —
a silent conversion is a silent assumption. Aggregating daily gas prices to a
quarter is a choice between mean, last and sum, so `canvas-core` rejects and
hands back a named fix. These nodes declare their real frequency and let that
rejection happen.

## Weights multiply money, so they get stricter rules

A scenario set whose weights sum to 0.94 is not an estimate with wide error
bars. It is arithmetic that assumes the missing 6% is worth zero P&L. `weigh`
computes the residual and carries it rather than normalizing the stated weights
up to one, which would silently spread unmodelled mass across the scenarios the
analyst happened to think of. A set summing past one is reported as a
contradiction, not a rounding issue.

C.4's flag travels with the number onto the scenario node, per the appendix —
a flag that stays on the probability node is a flag on the screen the analyst
has already stopped looking at.

`worst` and `best` are labelled as the extremes of the *stated* scenarios,
which is a different claim from the worst and best things that can happen. A
scenario set is exactly the artefact where those two get confused.

## Calibration compares on the overlap

The Brier machinery is reused from `@picasso/canvas-hypothesis` rather than
rewritten, so the analyst's calls and the market's prices are scored by the
same rule. `compare` intersects the two sets and reports how many contracts
survived: an analyst who states a probability on the twelve questions they find
interesting and compares to the market across four hundred is measuring
question selection, and the answer will flatter them.

## What is not here

- **No venue clients.** No Polymarket or Kalshi API, no node RPC, no indexer.
  The modules take quotes and series; fetching them is the data spine's job.
- **No liquidation-cluster or MEV extraction models.** 5.5 lists them as
  primitives to ingest; what is built here is the normalization they arrive
  into.
- **No power/additive defaults.** Both are implemented and neither is routed
  to; `additive` returns a negative probability rather than clamping one,
  because that negative is the method saying its assumption does not hold.
