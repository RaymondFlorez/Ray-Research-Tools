# @picasso/canvas-router

PRD 4's model orchestration: the versioned routing policy, hard rules a score cannot
override, the speculative cascade with deterministic verifiers, budget ceilings that ask
rather than degrade, and the trace store the eval harness reads.

```bash
npm test --workspace @picasso/canvas-router    # 117 tests
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

## The SLO is stated in the table's own unit

PRD 4.2 gives most rows a p95 in time, `asr` "0.15x realtime" and `embed` no
SLO at all. The policy had one millisecond field for every row, which forced
`asr` to a fixed ten seconds and `embed` to an invented 500ms; both rows also
pointed at a general 8B model as a placeholder, since nothing in the fleet was
scored for either. Each row's SLO is now `p95`, `realtime` or `none`, and
`latencyBudgetFor` turns it into a budget: a sixty-minute call gets nine
minutes, a thirty-second clip four and a half seconds, an ASR request with no
duration is refused rather than given a typical-call guess, and embedding is
unbounded.

ASR models carry their latency as a fraction of the audio too, so the risk
score compares like with like: whisper's 0.11x p95 is equally comfortable inside
the budget for an hour as for thirty seconds, and the old fixed ten seconds
applied to the hour scores above 0.95. The fleet now has the models the table
names — `whisper-large-v3` self-hosted, `vendor-asr` as the fallback, an open
embedding model — with the same placeholder status as every other fleet figure:
the realtime fractions are stated, not measured. Positions-classified audio
stays on the self-hosted model by the usual hard rule. The cascade's exit
figures are unchanged: 86.8% cheap terminations, 0.00% quality delta.

Some of the table's escalation triggers are properties of the input rather
than outcomes of a verifier — low SNR for ASR, table ambiguity or a footnote
cross-reference for `doc.extract`. They are known before the first dispatch, so
a row declares them as `escalateOn` signals and a request carrying one starts
on the fallback tier instead of failing on the primary first. The usual hard
rules still run over that tier: low-SNR audio goes to the vendor ASR, unless it
is positions-classified, in which case it is transcribed self-hosted and the
decision says which signal asked and what refused it. Detecting the signals —
measuring SNR, spotting the cross-reference — is the caller's job.

## Capability manifests

PRD 4.4: "Every model is registered with a capability manifest." The fleet
carried quality, cost and latency, but not what a model can *take* — so an image
request could be scored against a text-only model, and a tool-calling request
against one that cannot call tools. Every model now declares `version`,
`modalities`, `tools` and structured-output support, and two hard rules run
before any score: a model that cannot read the request's modalities, or cannot
call tools when the request needs them, is excluded with the reason.

`parseManifest` reads the PRD's YAML example, parsed by hand rather than by a
YAML library that would also honour anchors and tags. An unknown key is refused
— `eval_score:` for `eval_scores:` would otherwise register a model the router
never routes to. A manifest cannot widen a hard rule: a vendor-placed model
whose `sensitivity_allowed` lists `positions` is refused at registration. The
PRD's example has no placement field and the sensitivity line cannot be checked
without one, so `placement` is required here, an addition to the PRD's schema.

One consequence, stated rather than discovered later: nothing in the fleet the
PRD specifies reads images *and* runs inside the tenant, so positions-classified
page images have no route at all, and the router refuses them with the rules
that removed each candidate.

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

## A routed call has a fingerprint

`fingerprintOf(decision, promptHash)` is what a routed call contributes to the cache key of
the value it produces: the model, its version as the policy states it, and the seed and
temperature when the call is pinned. A manifest that bumps a version therefore moves every
key the model fed, and canvas-core's `explainKeyChange` names the model as the reason.

## A refusal is not a queue

Rung 2 of PRD 7.4: "GPU fleet saturated → local 3B handles classification and
autocomplete; heavy tasks queue with a visible position indicator." The router already got
the first half right — on a fleet reduced to the on-device model a codegen request throws
`NoEligibleModel` rather than being answered by the 3B — and stopped there, so the analyst
got an error where the PRD promised a place in line.

`InferenceQueue.submit` routes against the fleet that is up and, when that fails, asks
whether the healthy fleet would have served the request. If it would, the failure is
capacity and the task queues with its position; if not, it is policy — a modality no model
for that class accepts, say — and the healthy fleet's refusal is thrown now, because
queueing it would mean waiting for a recovery that could never admit it. Positions are
interactive first, then oldest first (7.3: "interactive over batch"), so a waiting batch
task's position gets worse whenever an interactive one arrives, and the number reported is
the true one rather than its place at arrival. `drain` releases, in that order, whatever a
recovering fleet can now serve and keeps the rest.

## The cascade over real models

`scripts/cascade-live.mjs` runs `doc.extract` on positions data through `services/gateway`:
read a position statement, return each holding's market value and the stated total, and
`reconciliationVerifier` (exact) decides whether to escalate. The statements are SYNTHETIC,
from a fixed seed, so every accepted answer can also be checked against the truth, which the
cascade never sees. The ladder is three open-weight models on the gateway's machine, served by
llama.cpp on four CPU cores, then a vendor model:

| Tier | Model | Tried | Accepted |
|---|---|---|---|
| primary | SmolLM2-360M-Instruct, Q8_0 | 20 | 0 |
| fallback | Qwen2.5-1.5B-Instruct, Q4_K_M | 20 | 10 |
| fallback | SmolLM2-1.7B-Instruct, Q4_K_M | 10 | 0 |
| fallback | a vendor model | 0 | — |

Measured on 20 November 2026, 20 statements: 10 accepted, all 10 right; 10 unverified, all
10 wrong; none accepted wrong; 14.2s end to end at p50, 18.0s at most. The vendor tier was
never offered the statements, and the gateway's trail holds 96 records, two per call, for the
three local providers only.

The first run found two bugs, both now covered by tests that fail without the fix:
- **The cascade did not start on the primary.** It began from `route`, which scores the
  whole fleet: right for one dispatch, wrong for a cascade, whose saving is that the cheap
  model goes first. Qwen outscored the 360M, so the 360M was never tried. The cascade now
  starts on the table's primary tier and scores the whole fleet only when no primary may
  serve the request.
- **Escalation went back down.** Each step passed `escalate` only the model that had just
  failed, so from the second tier it returned to the first. The run went Qwen, 1.7B, Qwen,
  1.7B. The cascade now carries every failure forward.

Fixing the second cost acceptance on this run: 15 of 20 before (14 right, one consistent
but wrong), 10 after. The going back down had given Qwen a second sample, and the gateway sends
no temperature, so a second sample is a second chance. A policy that wants that asks for it with
`escalateAfterFailures`; the ladder should not do it by accident. The measured figures above
for the simulated fleet are unchanged by both fixes (86.8%, 0.00%, 5.5×).

What this says about the table: the primary tier accepted nothing in 20, so on this task it
only adds latency. On the simulated fleet the cheap tier ended 86.8% of requests; on these
models, 0%. Those are the numbers the eval harness exists to replace.

### The harness, on the same models

`scripts/eval-live.mjs` runs `runEval` through the gateway on 40 SYNTHETIC statements from
another seed (an item scores 1 only when the extraction is exactly right) and writes
`rewrite()`'s policy for `cascade-live.mjs` to use (`POLICY_FILE`). Measured 21 November 2026:

| Model | Shipped quality (an ordering by size) | Measured, 40 items |
|---|---|---|
| SmolLM2-360M | 0.5 | 0.000 |
| SmolLM2-1.7B | 0.6 | 0.000 |
| Qwen2.5-1.5B | 0.7 | 0.450 ± 0.080 |

Rewritten, the policy routed exactly as before: 20 requests made 49 calls, 13.3s at p50 and
22.0s at most, the 360M tried first every time and the 1.7B after Qwen failed. A score is
something the router weighs, and zero still left both eligible. `route` now excludes a model
measured at 0 for the class, as it excludes an untested one; `rewrite` writes nothing from fewer
than 30 items, so such a zero means none of at least 30 succeeded. On the same 20 requests:
20 calls, one each, 6.5s at p50 and 8.8s at most, 15 accepted and all 15 right, none sent to
the vendor tier.

The 15 is not the rule's doing. Qwen answers every request in both runs, and its acceptance on
these 20 has been 10, 11 and 15 across runs, since the gateway sent no temperature and each
answer was a fresh sample. What the rule changed is the calls and the time. 0 of 40 also does
not mean the model can never succeed: the 95% upper bound on its rate is about 7%.

### Pinned

`PINNED=<seed> cascade-live.mjs` marks the request as one that must reproduce and sends every
call at temperature 0 with that seed (`GatewayPrompt.pinned`; the gateway passes both to
llama.cpp and records the seed on the trail). Two pinned runs on the shipped ladder, 21
November 2026: identical, line for line, in every tier tried, every verdict, and the
fingerprint of every answer, on all 20 statements; 13 accepted in each, all right, 47 calls
each, and all 94 on the trail as "pinned at temperature 0, seed 1". The unpinned runs of the
same 20 had accepted 10, 11 and 15, so the drift was sampling, and pinning removes it on this
server and these CPUs. A different build or hardware may change the arithmetic and with it the
answers; that is not measured here.

A pinned retry is the same request at the same seed, so with `determinismRequired` the cascade
escalates at the first failure instead of retrying on the tier. Claude takes no temperature and
no seed, so a pinned call to a provider the gateway lists as `pins: false` is refused before it
is sent (`NotPinnable`); the shipped manifest calls both frontier models deterministic, and the
test routes put them on Claude.

## What is not here

- **No preemption of running work.** 7.3 says batch work "is preempted". The queue orders
  waiting work; nothing here knows what is running, so nothing is stopped mid-flight.

- **Dispatch is the gateway's.** This package calls no model itself. `gateway.ts`
  supplies a `Dispatch` that sends each routed model to `services/gateway` under
  its provider's name, and refuses one whose manifest placement differs from the
  gateway provider's. Every call carries a `purpose`, a task name, which the
  gateway writes to PRD 7.2's audit trail before dispatching and refuses to go
  without. Its tests run against a stand-in gateway in-process, and
  `apps/canvas-demo/scripts/models-shots.mjs` drives the client against the real
  one. `scripts/cascade-live.mjs` has run the cascade over real open-weight models
  (above); no vendor model's output has been through it, and its run is not in CI.
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
