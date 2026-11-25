# ADR-0003: Functional scientific core, imperative infrastructure shell

Status: proposed · Date: 2026-11-25

## Decision
L1, L2, `grit_verify` math and `alphalytica.arch` are pure: no I/O, no logging, no global RNG, no config files, no clocks. Results are frozen dataclasses carrying their own diagnostics. Storage, HTTP, processes, logging, seeding and config loading live in shell code (`grit_lab` stores, `services/api`, CLIs, the training loop driver).

## Why
Pure functions are trivially testable, cacheable by input hash (the API caches instrument results this way) and reproducible. Provenance becomes serialization of inputs and outputs.

## Consequences
Some ceremony passing `rng` and config objects. Training loops are inherently stateful; the loop driver is shell, the step function is as pure as torch allows.
