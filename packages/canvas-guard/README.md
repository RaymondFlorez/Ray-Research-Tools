# @picasso/canvas-guard

PRD 7's hardening layer.

| Module | What it is |
|---|---|
| `classification.ts` | The four data classes, ordered, with `positions` as a floor rather than a pair of equality checks. |
| `tenant.ts` | A query that cannot be built without a tenant, and per-tenant collections with no path between them. |
| `egress.ts` | Two independent controls: the router gate reads the stamp, the proxy reads the bytes. |
| `untrusted.ts` | Content fences derived from the content, so the fence is unforgeable by construction. |
| `injection.ts` | The instruction-pattern classifier. The weakest of the four defenses, and last in the file for that reason. |
| `capabilities.ts` | Task-scoped tool allowlists. The defense that works because it does not have to recognize anything. |
| `degradation.ts` | The six rungs, and the one rule underneath them expressed as the only way to display a number. |
| `slo.ts` | SLO burn, per-node-kind paging, canary promotion, and the automatic-rollback rule. |
| `audit.ts` | Append-only with no delete path, expressed in the interface rather than in a policy document. |
| `exportBundle.ts` | Audit appendix, vendor licence redaction, and the refusal to export a figure that cannot be reproduced. |
| `redteam.ts` | The suite phase 7 exits on. |

## The exit criterion

> **Full red-team pass including prompt-injection and cross-tenant attempts.**
> — Appendix B, phase 7

```
injection: 11/11 capabilities refused, classifier 75% detection at 0% false
positives, fence held, cross-tenant: 6/6 blocked, egress: 8/8 correct
```

Corpus: 12 injections, 10 benign filing and transcript excerpts, 8 egress
cases, 6 cross-tenant attempts.

### The claim that matters is not the detection rate

An injection is stopped here because the capability it reaches for is not in
the running task's table — not because the text was recognized. Every
injection case declares the task class the agent is running and the tool the
injected text is trying to reach, and the assertion is that the allowlist
refuses it. `read.portfolio`, `read.positions` and `send.message` appear in no
row at all: position data reaches a prompt by being computed into a cell and
cited, which is the path `canvas-agents`' Reconciler can check.

The classifier's rates are reported separately and **together**. Quoting a
detection rate alone hides the tuning that produced it, and a classifier that
flags a third of real 10-Ks gets switched off by the first analyst who hits
it, at which point its detection rate is zero. Three of the twelve injections
are marked as not expected to be caught — the politely-phrased indirect ones,
and a base64 blob — because claiming otherwise would mean writing a rule that
fires on ordinary prose.

That 75 percent is measured against a twelve-case corpus written by the same
person who wrote the rules, which is the weakest kind of evidence a classifier
can have. It is a floor to regress against, not a capability claim.

### Two controls, two failure modes

The word in the PRD is *independently*, and it is not satisfied by calling the
same function twice.

| | Router gate | Egress proxy |
|---|---|---|
| Reads | the classification stamp | the bytes on the wire |
| Cannot be fooled by | encoding, paraphrase, obfuscation | a wrong stamp |
| Can be fooled by | a wrong stamp — and agents influence what gets assembled | encoding — a scanner that sees base64 sees nothing |

Measured over the eight egress cases: five should be blocked, the router alone
catches three of them and the proxy alone catches three. Neither covers the
set; together they cover all five. Two tests assert exactly that, including a
compromised-router case (a position dump stamped `public`, stopped at the
wire) and a blind-proxy case (a base64 dump the scanner passes, stopped by the
stamp).

The proxy holds hashes of `SYMBOL|quantity`, not the position book. That is a
blast-radius measure and not a privacy guarantee: the preimage space of a
ticker and a share count is small enough to enumerate. What it buys is that a
proxy log or a heap dump does not hand over the book in readable form.

**What counts as a fingerprint** is the part that decides whether the proxy
survives contact with production. 100 shares of AAPL is the most common
position size in the world; blocking every payload that mentions AAPL near 100
takes the proxy offline within a day. So a quantity is distinctive at three or
more significant digits and not a round multiple, a distinctive pair blocks on
its own, and non-distinctive pairs block at three — three of the tenant's exact
holdings in one payload is a portfolio dump, not a coincidence.

### The rollback rule needed fixing before it could ship

> "automatic rollback if a model's verification failure rate rises above its
> trailing 30-day baseline by more than 3 standard deviations"

Read naively this fires constantly. A model that verified perfectly for thirty
days has a sample standard deviation of zero, so *any* failure on day
thirty-one is infinitely many sigma above baseline and the fleet rolls back its
best model on one bad answer.

A daily rate is a binomial estimate and carries sampling noise even when every
draw came out the same, so the sigma used is the larger of the observed one and
`sqrt(p(1-p)/n)`, with `p` floored at `1/n`. Thirty perfect days then mean "we
have not seen a failure in this many draws", not "failures are impossible".

Measured rather than asserted:

```
rollback rule: 0.10% false rollbacks on a stable model over 2000 trials
rollback rule: catches 99% of a 5% -> 12% regression at 3 sigma
```

## What is not here

- **No egress proxy process.** The proxy is a class, not a service in front of
  a socket. The PRD's deployment puts it out of reach of the code agents
  influence, and that separation is the actual control; what is implemented and
  measured here is its decision function.
- **No Firecracker, no seccomp, no CSP.** PRD 7.2's sandbox and client-side
  sections are deployment configuration, not library code.
- **No Postgres row-level security.** `TenantQuery` is the shape the query
  layer enforces, tested against in-memory rows.
- **No OIDC or MFA.** The audit log records an actor; it does not authenticate
  one.
- **No PDF pipeline.** `buildBundle` produces the bundle and the appendix; the
  PRD renders it through the existing WeasyPrint path.
