# ADR-0010: Units at boundaries (pint), SI floats inside

Status: proposed · Date: 2026-11-25

## Decision
Configs, API inputs and displayed outputs carry units via one pint registry (`grit_core.units.ureg`). They're converted to SI once, at the boundary. Scientific functions take and return SI floats and arrays, with units documented in docstrings and recorded in result `units` mappings.

## Why
Unit-aware arrays inside numerical loops cost 10 to 100x and complicate typing. Unit errors happen at boundaries (config typos, ms vs s), which is where pint checks.

## Consequences
A function called internally with the wrong unit isn't caught by pint; docstrings and result `units` fields plus reference tests cover that.
