# @picasso/canvas-hypothesis

PRD 3.5's hypothesis tracker: claims that carry their own falsifiers, resolve themselves
when the data arrives, and accumulate into a calibration record.

> This is the feature that turns the canvas into an accountability instrument rather than a
> mood board.

```bash
npm test --workspace @picasso/canvas-hypothesis    # 54 tests
```

| Module | PRD | What it does |
|---|---|---|
| `hypothesis.ts` | 3.5, 7.4 | Claims, observables, and the four-state resolution |
| `calibration.ts` | 5.5, 5.7 | Brier score, Murphy decomposition, reliability diagram |
| `node.ts` | 3.3, 3.5 | `HypothesisNode` on the canvas |
| `ledger.ts` | 3.5, 7.4 | `HypothesisLedger`: the append-only record, re-resolved as data arrives |

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

**Only data inside the claim's window counts**: dated after the claim was made, and no later
than the observable's due date. A number dated earlier was known when the claim was written,
and counting it would let a record be padded with calls made after the answer was in; a number
dated later is the prediction expiring and the data turning up anyway. `validate` also refuses
an observable due before the claim was made.

## The ledger

PRD 3.5's tracker "tracks the claim automatically: as data arrives ... and logs the analyst's
calibration history over time." `resolve` is the half that says what a claim's status is.
`HypothesisLedger` is the half that remembers: an append-only log of three events — a claim
stated, a number observed, a claim withdrawn — from which every status is derived and none is
stored.

`observe()` is the trigger. Each number is routed to every claim that names its observable,
every open claim is re-resolved, and what changed comes back as a list of transitions; expiries
that came due since the last event are in the same list. `tick(now)` does the same with no new
data. A claim resolves "whether or not she remembers it", as long as the data reaches the ledger.

The rules that keep the record from becoming a scoreboard are refusals, not conventions:

- **The ledger dates a claim, not the caller.** `createdAt` is replaced by the moment the
  ledger received it, so a claim written after the print cannot be backdated before it.
- **The first number received counts.** `resolve` takes the earliest *dated* observation; the
  ledger takes the earliest *received*, so a number backdated into the log after the call
  settled changes nothing. The seam test shows a node fed the raw log flipping on exactly that
  backfill, which is why the node reads through the ledger.
- **The clock does not run backwards**, an observation cannot be dated after it was received,
  and a refused event changes neither the log nor the clock.
- **A claim id is used once.** A changed claim is a new claim.
- **Withdrawal** needs a reason, is refused once any data has counted or the claim has expired,
  and stays on the record.
- **No edit, delete or clear.** `events()` and every entry are copies; a `matching` predicate is
  shown a copy too.

`scored(filter)` is the calibration history — supported and contradicted calls only, filtered
by author and by a caller-defined "same shape" predicate — and it is what `calibrate` and the
Critic's base rate read. `record()` is the Critic's sentence with what the score leaves out
named after it: *"made this call 3 times, right once (1 expired unchecked, 1 withdrawn before
the data)"*. An analyst who withdraws or abandons the calls that are going badly has a record
the bare sentence flatters.

Persistence is the log. It is plain JSON, and `HypothesisLedger.replay` rebuilds a ledger by
applying each event through the same methods a live caller uses, so a log with a gap, a number
redated past its receipt, or a claim moved before the data is refused on replay. Over five
random 300-day histories the replayed ledger matches the original entry for entry, and over
three more every status matches a from-scratch reading of the log that does not use the
ledger's bookkeeping.

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

## What is not covered

- **A durable store.** The ledger's log is what gets persisted, and nothing here writes it
  anywhere; that is the Postgres the PRD names (3.9), which this repo does not run. Nor is the
  stored log tamper-evident: replay catches a gap and any event the rules refuse, but not an
  edit that keeps every rule — a number changed in place, or an event removed and the rest
  renumbered. `AuditLog` in `canvas-guard` carries a digest chain for that; this does not.
- **Wiring data to the ledger.** `observe` is the trigger, and something must call it when an
  observable's data lands. That is the data plane's job.
- **Observation provenance.** A number carries a `source` and the time it was received, and the
  ledger trusts both. A late-received number dated inside the window resolves a claim the
  ledger had reported expired, which is right for ingest lag and is also how a fabricated
  backfill would look.
- **Withdrawal timing.** A claim can be withdrawn up to the moment its data arrives, including
  the day before a print. The withdrawal is named in `record()`; it is not prevented.
- **Observable extraction.** An observation is a number with a date and a source. Reading
  "reported segment GM" out of a filing is ingest, not this package.
