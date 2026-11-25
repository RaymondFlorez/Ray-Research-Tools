# Scientific review

For prompts with `review: scientific` and for moving any experiment to VERIFIED.

## Code
- [ ] Each formula matches its cited source (check one derivation by hand).
- [ ] Reference test values come from the cited source, not from the implementation's own output.
- [ ] Tolerances are justified in comments.
- [ ] Stochastic tests state their false-failure rate.
- [ ] Provisional concepts are marked provisional with a note.

## Experiments
- [ ] Hypothesis, baseline, protocol and acceptance criteria were frozen before running (spec hash at AUTHORIZED equals report).
- [ ] Parameter-matched and compute-matched comparisons both reported where required.
- [ ] Seeds sufficient per the power analysis; per-seed values shown.
- [ ] Differences within seed noise are reported as "no detectable difference".
- [ ] Contamination check ran and passed.
- [ ] Deviations from plan documented.
- [ ] Claims audit: every sentence in the conclusion and model card is supported by a reported number. No capability claims beyond measured suites.
