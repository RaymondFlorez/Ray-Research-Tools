# Working in this repository

Picasso, built against `docs/picasso/PRD.md`. Sixteen npm workspace packages
under `packages/`, one Rust crate under `crates/pricing-core`, demo surfaces
under `apps/canvas-demo`.

## Commands

```bash
npm install
npm run build        # MUST precede typecheck: tsc resolves cross-package
                     # imports through each package's dist, not its src.
                     # Runs in dependency order (scripts/workspaces.mjs) and
                     # includes apps/canvas-demo.
npm run typecheck
npm test             # vitest, per workspace; suites that load the WASM build
                     # it once first (scripts/ensure-wasm.mjs)

cd crates/pricing-core && cargo test --release
node scripts/verify-wasm-parity.mjs   # native vs WASM, bit for bit
```

`.github/workflows/ci.yml` runs all of this, plus the demo's browser checks,
from a clean checkout. Verify a build-system change the same way — a fresh
clone with no `dist` and no `target` — because stale output on disk hid a
build that could not run from scratch until it was checked that way.

Vitest resolves `@picasso/*` to each package's **source** through aliases in
`vitest.config.ts`, so tests see uncompiled changes immediately. `tsc` does
not. A typecheck failure saying a package "has no exported member" almost
always means the build is stale, not that the export is missing.

## Conventions this codebase actually follows

**A number in a comment or README was measured.** Not estimated, not quoted
from a paper — produced by a test in this repo. If you change code that a
stated figure depends on, re-measure and update the figure.

**When a measurement contradicts the design, the design is wrong.** This has
happened repeatedly, and each is documented in the commit that fixed it: the
accuracy guard was checking Andersen-Lake against a lattice that was itself
wrong; clustered event dates do not inflate significance unless the benchmark
fails to span the common factor; the microprice runs the opposite way to the
obvious guess; tail dependence does not decay slowly in the degrees of freedom.
Later ones: a t copula applied per step is Gaussian at the horizon; Roll's
spread estimator reports tens of basis points on a series with no spread; the
textbook standard errors for impact calibration and for realized vol both
under-covered once noise was heteroskedastic or fat-tailed.
Before concluding the code is wrong, check whether the test encodes the same
assumption the code does — twice it did.

**A rule stated strongly is expressed where it cannot be forgotten.** Examples
to follow rather than work around:

- `present()` in `canvas-guard/src/degradation.ts` is the only way to produce a
  displayable number and cannot be called without a source and an as-of.
- `AuditLog` has no delete, truncate or clear, and hands out copies.
- `TenantQuery` has no constructor without a tenant, and applies it separately
  from caller predicates.
- `metric()` in `canvas-equity/src/transcript.ts` throws on a non-zero value
  with no spans behind it.
- `accept()` in `canvas-ink/src/semantic.ts` is the only path from a sketch to
  a node.

**What is not verified is written down.** Every package README ends with a
section stating what it does not cover. Keep it accurate; do not quietly widen
a claim.

**Four scoring nodes deliberately refuse to compute.** `ERQ12Node`,
`AXM8Node`, and the SIV and BPS frameworks in `canvas-equity/src/nodes.ts`
report `unspecified_rubric` because the PRD names them and defines none. Do not
invent a formula for any of them.

## Testing

Unit suites test one package against its own fixtures. `canvas-integration`
has no `src` — it tests the **seams**, and it is where the bugs that survive
unit tests were found (two bugs and two cross-package disagreements so far, all
documented in its README). When a
change crosses a package boundary, add the assertion there.

Numerical routines with a published definition are checked against that
definition in code that does not call the routine under test — see
`canvas-causal/test/hac-verify.test.ts`, `canvas-sim/test/dsr-verify.test.ts`,
and the `derivatives` and `closed_form` modules in the Rust crate.

## The Rust crate takes no dependencies

Only `libm`. Everything compiles to both a native target and
`wasm32-unknown-unknown` and must produce identical bits: use `libm` rather
than `std` float methods, integer-only RNG, and bisection rather than Newton
where control flow would otherwise depend on a value rather than a sign.
`scripts/verify-wasm-parity.mjs` enforces this across 5,757 values.
