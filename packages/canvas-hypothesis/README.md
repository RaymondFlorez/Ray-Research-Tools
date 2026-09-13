# @picasso/canvas-hypothesis

PRD 3.5's hypothesis tracker: claims that carry their own falsifiers, resolve themselves
when the data arrives, and accumulate into a calibration record.

> This is the feature that turns the canvas into an accountability instrument rather than a
> mood board.

```bash
npm test --workspace @picasso/canvas-hypothesis    # 31 tests
```

| Module | PRD | What it does |
|---|---|---|
| `hypothesis.ts` | 3.5, 7.4 | Claims, observables, and the four-state resolution |
| `calibration.ts` | 5.5, 5.7 | Brier score, Murphy decomposition, reliability diagram |
| `node.ts` | 3.3, 3.5 | `HypothesisNode` on the canvas |

## Two cutoffs, not one

The PRD's worked example carries the design inside it: *"Observable: reported segment GM.
Threshold: 71 percent. Date: the next report. Falsifier: GM above 73 percent."*

Those are two different numbers and the gap between them is the point. A claim with one
cutoff always resolves, which sounds like rigour and is the opposite: gross margin at 72
does not confirm "below 71" and does not refute it, and a tracker forced to call it a win
or a loss is measuring its own arbitrariness rather than the analyst. So `undetermined` is
a real outcome, it carries no `outcome` flag, and nothing about it reaches the calibration
record.

Resolution precedence, in order:

1. **Any falsifier that fired wins.** That is what a falsifier is for. A claim that survives
   by averaging one refutation against two confirmations is not being tested.
2. Every observable supported means the claim is supported.
3. Anything still awaited leaves it open — `undetermined`, not failed.
4. Otherwise: the data never came (`expired`) or it came and said nothing (`undetermined`).

`expired` is deliberately not `undetermined`. A prediction nobody could check and a
prediction that was checked and came out ambiguous are different facts about the analyst.

Two smaller decisions in the same spirit. **The first observation is the one that counts** —
a restatement in November cannot flip a call the August print settled, or the record becomes
editable after the fact. And **being wrong is not an error**: a contradicted claim leaves the
node `ready` with the verdict on its badge, while a claim nothing could refute is what sets
`error`.

## Three times, right once

PRD 7.4 has the Critic cite exactly that, and the next line of the PRD says that sentence is
why the tracker exists. So `trackRecord` produces it, and the constraint it implies is the
hardest thing in the package: **three resolved calls is a fact, not a measurement.** A Brier
score on three observations moves by 0.08 on a single outcome, so reporting one would dress
a coin flip up as an assessment. Below ten resolved predictions the score comes back with a
warning that says the count and the hits and nothing else.

`calibration.ts` reports Murphy's decomposition rather than a bare score, because the two
halves are different skills:

- **reliability** — how far stated probabilities sit from realised rates. Lower is better,
  and this is the part an analyst fixes by adjusting how confident they *say* they are.
- **resolution** — how far realised rates sit from the base rate. *Higher* is better, and
  this is the part that measures whether they know anything. A perfectly calibrated
  forecaster who always states the base rate scores zero here, and a test asserts exactly
  that.

`brier = reliability − resolution + uncertainty` is an identity, and since the score comes
from the raw predictions while the three parts come from bucket statistics, it only holds if
both are right. That test is the self-check on the file.
