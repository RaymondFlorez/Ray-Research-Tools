# @picasso/canvas-sim

PRD 5.8's simulation engine: event-driven backtests that cannot look ahead, the detectors
that run on every one of them, and the statistics that account for how many strategies the
analyst tried before this one.

```bash
npm test --workspace @picasso/canvas-sim    # 38 tests
```

| Module | PRD | What it does |
|---|---|---|
| `pointInTime.ts` | 5.8 | A view of history frozen at one bar, with no method that takes a date |
| `costs.ts` | 5.8 | Commission, spread, square-root impact, borrow, financing |
| `engine.ts` | 5.8 | The bar-by-bar loop; orders fill on the *next* bar |
| `detectors.ts` | 5.8 | Shuffle test and negative-lag correlation, run automatically |
| `statistics.ts` | 5.8 | Sharpe, deflated Sharpe, drawdown, CVaR |

## Phase 4's exit criterion, and what building it taught

> Shuffle test correctly flags a deliberately leaky backtest.

The first leak I wrote did not leak. A signal built from *tomorrow's* return looked like
the classic off-by-one join, and the backtest lost money — because an order decided on bar
`t` fills at `t+1` and earns `t+1 → t+2`, so a one-bar-ahead signal predicts a return the
position never sees. **That was the engine's fill delay working**, and it is the reason the
delay is not configurable.

The second attempt failed differently and more usefully. Shuffling the signal *dates*
scrambles a data-driven leak exactly as thoroughly as it scrambles a real edge, so the test
could not tell them apart. Which finally made PRD 5.8's sentence land:

> A backtest that passes the shuffle test gets flagged loudly, because it means something is
> leaking.

**Real look-ahead does not come from a data read.** The point-in-time view already refuses
those. It comes from a *captured variable* — an array loaded once, indexed by bar, closed
over by the strategy. The view cannot protect against that because the strategy never asks
it anything. And that is precisely what the shuffle test catches: scrambling the dates
changes such a strategy's results by **nothing**.

```
closure leak:   real Sharpe 19.31   shuffled median 19.31   survival 1.00
honest trend:   real Sharpe  0.92   shuffled median -0.70   survival 0.00
```

## Where the shuffle test stops

A strategy with no edge survives its own shuffle, because there was never anything to lose.
The test separates an edge from a leak and **cannot** separate a leak from a strategy that
never worked, so below a Sharpe of 0.5 it reports `inconclusive` rather than `leaking`. A
detector that fires on the absence of a result teaches analysts to ignore it on the runs
where it matters.

The negative-lag detector had a related hole. It looked at lags −1 and earlier, so a signal
that *is* the contemporaneous return — the purest leak there is — sailed straight through.
Lag zero now counts as backward, and the verdict compares how well the signal explains the
past against how well it explains the future.

## Two bugs in the deflated Sharpe

> A deflated Sharpe ratio adjusted for the number of trials the analyst has run on this
> canvas. The trial counter is tracked automatically, which is uncomfortable and correct.

The first version dropped the `σ_SR` scaling from Bailey and López de Prado. The bracket
`(1−γ)Z(1−1/N) + γZ(1−1/(Ne))` is the expected maximum of **N standard normal draws** — about
3 at a thousand trials — and reading that as a Sharpe ratio deflates by an annualized 46. What
is actually distributed that way is the Sharpe estimator's own error, so the bracket
multiplies the dispersion of trial Sharpes. The failure showed up as two probabilities both
underflowing to zero.

The second was mine in a different sense: Acklam's quantile written as a Horner chain full
of `as number` casts, where a misplaced parenthesis had nowhere to hide but did anyway. It
is named coefficients now.

## Costs are where a backtest meets the world

The square-root impact law is the term that decides whether a strategy scales: ten times the
size costs about three times as much per share, so thirty times in total. A test asserts
exactly that ratio, because it is the difference between a result at $1m and the same result
at $100m.

It is also what killed the first honest strategy in the test suite — a 10-day trend follower
flipping between long and short cost more in turnover than its edge was worth. The surviving
fixture holds for sixty days, and that is a fair summary of the tradeoff the model exists to
make visible.
