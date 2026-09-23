# Working in this repository

Picasso, built against `docs/picasso/PRD.md`. Sixteen npm workspace packages
under `packages/`, one Rust crate under `crates/pricing-core`, demo surfaces
under `apps/canvas-demo`.

## Commands

```bash
npm install
npm run build        # MUST precede typecheck: tsc resolves cross-package
                     # imports through each package's dist, not its src
npm run typecheck
npm test             # vitest, per workspace

cd crates/pricing-core && cargo test --release
node scripts/verify-wasm-parity.mjs   # native vs WASM, bit for bit
```

Vitest resolves `@picasso/*` to each package's **source** through aliases in
`vitest.config.ts`, so tests see uncompiled changes immediately. `tsc` does
not. A typecheck failure saying a package "has no exported member" almost
always means the build is stale, not that the export is missing.

## Conventions this codebase actually follows

**A number in a comment or README was measured.** Not estimated, not quoted
from a paper — produced by a test in this repo. If you change code that a
stated figure depends on, re-measure and update the figure.

**When a measurement contradicts the design, the design is wrong.** This has
happened four times and each is documented in the commit that fixed it: the
accuracy guard was checking Andersen-Lake against a lattice that was itself
wrong; clustered event dates do not inflate significance unless the benchmark
fails to span the common factor; the microprice runs the opposite way to the
obvious guess; tail dependence does not decay slowly in the degrees of freedom.
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

**Two nodes deliberately refuse to compute.** `ERQ12Node` and `AXM8Node` in
`canvas-equity/src/nodes.ts` report `unspecified_rubric` because the PRD names
them and defines neither. Do not invent a formula for them.

## Testing

Unit suites test one package against its own fixtures. `canvas-integration`
has no `src` — it tests the **seams**, and it is where the bugs that survive
unit tests were found (two so far, both documented in its README). When a
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
`scripts/verify-wasm-parity.mjs` enforces this across 5,187 values.
