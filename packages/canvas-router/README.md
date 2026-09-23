# @picasso/canvas-router

PRD 4's model orchestration: the versioned routing policy, hard rules a score cannot
override, the speculative cascade with deterministic verifiers, budget ceilings that ask
rather than degrade, and the trace store the eval harness reads.

```bash
npm test --workspace @picasso/canvas-router    # 82 tests
```

## Phase 3's exit criterion

> Cascade terminates >70 percent of requests at cheap tier with <1 percent quality delta.

Measured against a simulated fleet, 400 requests on `sql.generate`:

| | measured | PRD |
|---|---|---|
| cheap-tier terminations | **86.8%** | >70%, reports ~78% |
| quality delta | **0.00%** | <1% |
| cost vs always-frontier | **5.5× cheaper** | "roughly 5x" |

The quality delta is the honest part: it compares the cascade's final answers against
sending *every* request to the frontier, on the same requests. A cascade that terminates
cheap on the easy ones and escalates the rest should lose almost nothing, and "almost" is
what the number checks.

## Rules first, scores second, and the order is load-bearing

PRD 4.3: "Hard rules run first and cannot be overridden by a score." A score is a number
about expected quality per cent; a rule is a statement about where data is allowed to go. If
a score could outvote a rule, then a sufficiently good frontier model would eventually be
worth sending positions to — which is exactly the reasoning the rule exists to forbid.

So the test does not check that the router *prefers* a local model. It rigs the policy to
make the vendor model free, instant and perfect, and checks it still cannot be chosen.

## The table has to drive the ladder

> Nothing in that table is hardcoded in application logic. It lives in a versioned routing
> policy document that the eval harness rewrites.

The first version of `escalate` re-scored from scratch, and it quietly ignored the
`fallback` column. On a tight latency budget that meant `sql.generate` escalated to a
*cheaper self-hosted* model — one no more likely to succeed than the one that just failed —
and the exit criterion came out at a 9.5% quality delta.

Escalation means *up*, and the table is what says which way that is. The ladder now comes
from the policy; the score still chooses within a tier when one lists several models.

With the ladder fixed, the delta went to zero and the cost saving landed at 5.5×, which is
independently close to the "roughly 5x" the PRD reports.

There is a second, quieter check on the table in the tests: `summarize.bulk` lists the 8B as
primary and the 32B as fallback, and the utility score lands on the 8B *without being told
to* — the 32B wins on quality and loses on latency against an 800ms budget. Give it a 6s
budget and the fallback wins, which is what a fallback is.

## Deterministic verifiers are the point

> The verifier is either deterministic (does the SQL parse and return rows; does the code
> pass its generated tests; do the extracted numbers reconcile to the reported total) or a
> small judge model.

A judge model that is wrong 5 percent of the time caps the whole cascade's accuracy at 95
percent. A SQL parser is wrong zero percent of the time, and when it accepts, the cheap
answer is *known* good rather than probably good. So a deterministic verdict reports
confidence 1 — it either parsed or it did not — and the reconciliation verifier, which PRD
4.3 names specifically, is the strongest of the three: a filing states its own total, and a
model that hallucinates a segment will not hit it.

When every tier fails, the cascade returns the last answer rather than throwing. "Here is
the best available answer, and it did not verify" is more useful to an analyst than nothing.

## Budgets ask; they do not degrade

> The orchestrator refuses dispatch past the ceiling and surfaces a clear "this node wants
> $0.42 more, approve?" prompt rather than silently degrading.

*Rather than silently degrading* is the requirement. A system that quietly drops to a
cheaper model when money runs short produces a worse answer that looks exactly like a better
one. The prompt also names the **tightest** ceiling rather than the first one checked,
because raising the wrong one changes nothing.

### The tenant's monthly bill is a different budget

PRD 7.3 adds one 4.3 does not mention: "per-tenant monthly inference budgets with soft
warnings at 70 percent and hard stops with an override path at 100 percent". `budget.ts`
stops one canvas running away; `tenantBudget.ts` is the organisation's monthly bill, and it
has three parts that are easy to get subtly wrong.

**The warning is a state, not an event.** "Soft warning at 70 percent" reads like something
that fires once — and fired once, it is missed once, by whoever happened to be working at
that moment while the desk head who needed to see it was in a meeting. The tier comes back
on *every* decision. Crossing is derivable from two consecutive checks; being over is not
derivable from an event already delivered.

**Spend belongs to the month it happened in**, not the month of the query. Otherwise a
month's total depends on when somebody asked, two reports of the same month disagree, and
the one that disagrees is always the one somebody is using to argue about a bill. The
month boundary is the tenant's own: 2am UTC on April 1 is still March for a tenant billed
in New York, and the last five hours of a month are not nothing at quarter-end.

**An override that does not expire is not an override.** This is the one that matters.
"Hard stop with an override path" invites an implementation where the stop fires once,
somebody approves, and the tenant is uncapped from then on. An override here raises the
ceiling by a stated amount, for a stated reason, by a named person, *until a stated time*,
and is scoped to one month so it cannot carry into the next. Every one of those is
required — the same rule the provenance override and the audit record already follow. The
base ceiling is reported alongside the raised one, so a lifted ceiling is visible rather
than implied, and it is reported on every decision while it is in force rather than only
when it bites.

## What the trace store is for

Only verified dispatches count toward a model's acceptance rate. An unverified dispatch says
nothing about quality, and folding it in as a pass would let a class with no verifier drift
upward forever. A model with no verified dispatches reports `NaN`, not a number.

## The canary

> New model versions take 5 percent of traffic in shadow (dispatched, result
> compared, not shown) before promotion. Regression on any task class above 2
> percent blocks the promotion. — PRD 4.7

Four decisions sit under that sentence.

**The sample is derived, not drawn.** `Math.random() < 0.05` gives the right
share and nothing else: a trace store whose whole purpose is that a dispatch
can be replayed cannot then say *why* a given request was shadowed, two runs of
one session shadow different requests, and a test of the share has to average
over thousands of draws to see anything. `inShadow` hashes the request id
together with the candidate version, so a replay shadows the same requests, and
a different candidate gets a different 5 percent — keying on the id alone would
evaluate every model version that ever ships against one slice of the product.
Measured over 20,000 requests: **5.195 percent sampled** — 1,039 of them, the
same 1,039 on every run — with two candidates' slices overlapping on **0.25
percent** of traffic, which is exactly what independent 5 percent slices
should share.

**"Not shown" is a type.** `shadow()` returns the incumbent's answer and a
record of scores and costs. There is no field anywhere in the result that can
hold the candidate's output, so a caller cannot show it by mistake, and a
candidate that fails outright scores zero rather than raising — a model under
evaluation cannot fail a request that was not routed to it.

**Per class, and thin evidence blocks.** The threshold is a floor over classes,
not an average: a candidate up five points on SQL and down four on codegen is
better on aggregate and is exactly the promotion the rule exists to stop. A
class with fewer than 30 shadow dispatches blocks too, and so does one the
candidate was never asked to do at all — promotion is the action that needs
justifying, so silence blocks it rather than clearing the gate by default.

**The bill is reported.** A shadowed request is dispatched twice, so 5 percent
of traffic at double cost is a 5 percent increase. The report carries what the
shadow spent, which is better learned here than from an unexplained line later.

## What is not here

- **No dispatch.** Every model in this package is a description and a function
  the caller supplies. What is tested is the routing, the cascade's control
  flow, the budgets and the gates — not any model's output.
- **The canary does not route traffic.** `inShadow` says whether a request is
  in the sample and `shadow()` runs both dispatches, but nothing here sits in
  a request path: the caller decides where to call it from, and a caller that
  never calls it shadows nothing.
- **Cost and latency are the fleet's stated numbers**, not measurements. The
  cascade's 5.5× is a ratio of those numbers under a simulated request mix; a
  real fleet's would differ.
- **No ClickHouse.** `TraceStore` is an in-process array with the queries 4.7
  names. The retention, the right-click path from a node, and the storage are
  the service's, not this package's.
