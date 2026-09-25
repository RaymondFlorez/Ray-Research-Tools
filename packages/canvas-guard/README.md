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
| `latency.ts` | PRD 7.1's budget table as data, with the evidence behind each row and the check against an observed distribution. |
| `redteam.ts` | The suite phase 7 exits on. |
| `session.ts` | PRD 7.2's session policy: MFA per tenant, fifteen-minute tokens, and a silent refresh that can extend a session but never upgrade one. |

## The latency table, and where it actually stands

> These are contractual, monitored per-interaction, and alerted on. — PRD 7.1

A contractual table that lives only in a document is monitored by whoever
remembers it. `latency.ts` is the fourteen rows as data, each carrying either
the harness that measured it and what that measurement does not cover, or the
reason there is no measurement.

```
14 budgets · 7 measured · 4 met · 3 missed · 7 unmeasured
```

**An unmeasured row is never reported as met.** That is the whole reason for a
third state: a missing measurement and a passing one are different, and
collapsing them turns a coverage figure into a ceiling on what anyone will look
at. Seven rows have nothing behind them for structural reasons — no ClickHouse, no
DuckDB, no models, no market data feed — and naming each gap beats a silent row
that implies 14/14.

**The three missed rows stay recorded as missed.** A table where every row
passes is a table whose thresholds were chosen after the measurements.

| Row | Budget p95 | Observed p95 | |
|---|---|---|---|
| Pan / zoom frame | 16ms | 18.8ms | 5,000 nodes on SwiftShader, a CPU rasterizer. The p50 is inside at 7.1ms. Real hardware should clear it, but that is an inference. |
| Options book reprice, 40 legs × 375 cells | 90ms | 171.7ms | Quality-dependent. `draft` reprices in 55.9ms and meets it; `standard` goes through Andersen-Lake and does not. The canvas drags at draft and settles at standard, so the budget holds while the analyst is moving and misses when they stop. The recorded figure is the one that fails — taking the draft number would be choosing the measurement that passes. |
| Monte Carlo 100k × 252 × 40 | 9s | 30.0s | Single-threaded native, against a budget the PRD explicitly puts on a cluster. 3.3x over, landing exactly on the 30s ceiling, with throughput flat at 3.3e7 asset-steps/s from 10k paths to 100k — so the useful reading is that the budget assumes about four cores. |

`checkLatency` throws on an interaction name that is not in the table rather
than passing it. A monitor that silently accepts an unbudgeted name reports
green for something nobody checked, and a typo in a metric name is how that
happens in practice.

## The exit criterion

> **Full red-team pass including prompt-injection and cross-tenant attempts.**
> — Appendix B, phase 7

```
injection: 11/11 capabilities refused, classifier 75% detection at 0% false
positives, fence held, cross-tenant: 6/6 blocked, egress: 12/12 correct
```

Corpus: 12 injections, 10 benign filing and transcript excerpts, 12 egress
cases, 6 cross-tenant attempts.

### What a security review found that the corpus did not

The egress corpus had eight cases and the proxy got all eight right, which is
the number a red-team suite reports when it tests one spelling of the attack.
A review of this branch found four more, and they are not clever:

| | |
|---|---|
| `nvda 12,450` | The scan matched `\b[A-Z]{1,6}\b` while the fingerprint constructor upper-cased on ingest, so an all-lowercase dump produced no symbols, and the scan returned before the number pass ever ran. |
| `{"symbol":"NVDA","qty":12450}` | Caught here; **missed** by the second scanner in `canvas-data`, which required the ticker and the quantity to be adjacent after normalization. `qty` sits between them. |
| `\| NVDA \| 12,450 \|` | Same, and the normalization there stripped a denylist of punctuation that omitted `\|`, `:` and `/` — every separator a serializer emits. |
| `<td>NVDA</td><td>12450</td>` | Same, with tag names in the gap. |

Nothing is hidden in any of them. Each states the holding in plain text, in a
format a serializer produces by default, which is what makes them the cases
worth having: an agent does not need to invent an evasion if `JSON.stringify`
is one. All four are now in `EGRESS_CASES`, the corpus reads 12/12, and the
proxy-with-a-compromised-router figure went from 3 to 7.

The other five findings, and the regression test each now has, are in the
commit that fixed them. The pattern common to four of them is the same shape:
a check written as a denial of the known-bad case, so an input nobody
enumerated — an unrecognized classification, an unrecognized model placement, a
`licensed` record with no vendor, a value that is not a number — took the
allow path. Each is now written as an allowlist, and the unknown input is
refused.

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

## Sessions

PRD 7.2: "OIDC with mandatory MFA for any tenant with `positions` class data.
Short-lived (15 minute) session tokens with silent refresh." `session.ts` turns
that sentence into four rules.

**MFA belongs to the tenant, not the request.** A single-factor session is
refused anywhere in a tenant holding positions, including on a public canvas.
The per-request reading leaves a one-factor session inside a positions tenant,
one authorization bug away from the book, and a second factor exists precisely
so that nothing depends on every other check being right.

**A long-lived token is refused, not trusted.** The fifteen minutes is checked
on the token. An identity provider misconfigured to issue eight-hour tokens
produces tokens that verify perfectly.

**Refresh extends, never upgrades.** A refreshed token keeps the original login
time and methods. One claiming a second factor with an unchanged `auth_time` is
claiming a factor nobody presented, and is refused; so is one that drops a
factor, changes subject or tenant, or comes from an earlier login.

**Silent refresh ends — and this one is ours, not the PRD's.** Fifteen-minute
tokens with unlimited silent refresh are an unlimited session. After twelve
hours from the interactive login the user logs in again. The figure is a
choice made here; the specification does not give one.

## What is not here

- **No egress proxy process.** The proxy is a class, not a service in front of
  a socket. The PRD's deployment puts it out of reach of the code agents
  influence, and that separation is the actual control; what is implemented and
  measured here is its decision function.
- **No Firecracker, no seccomp.** PRD 7.2's sandbox is deployment
  configuration, not library code. The client-side CSP and COOP/COEP are
  applied by the demo server (`scripts/security-headers.mjs`) and checked in
  Chromium by `apps/canvas-demo/scripts/csp-check.mjs`; there is no production
  origin here, and no separate Pyodide or sandbox origin.
- **No Postgres row-level security.** `TenantQuery` is the shape the query
  layer enforces, tested against in-memory rows.
- **No OIDC.** `session.ts` decides what *verified* claims may do; verifying
  them — signature, issuer, audience, key rotation — is the OIDC library's
  job and is deliberately not reimplemented, since a hand-rolled JWT verifier
  is a known way to accept `alg: none`. MFA counts SMS as a second factor
  because the PRD asks for MFA, not phishing-resistant MFA; a tenant that wants
  the latter needs a narrower method set than this one.
- **No PDF pipeline.** `buildBundle` produces the bundle and the appendix; the
  PRD renders it through the existing WeasyPrint path.
