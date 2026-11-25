# GRIT-PNNN: <Title>

New prompts are added to `tools/catalog/*.py` with `prompt(...)`, not written by hand. `tools/build.py` renders this structure. This file documents the fields so reviewers know what each section must contain.

| Section | Catalog field | Must contain |
|---|---|---|
| Prompt identifier | `num` | Next free number; must be greater than every dependency |
| Objective | `objective` | One engineering outcome, two to four sentences |
| Scientific context | `context` | The GRIT concept and mathematics involved, with ADR or spec references |
| Prerequisites | `deps` | Prompt numbers; files from them are listed automatically |
| Existing repository context | `inspect` | Files and references to read first |
| Scope | `scope` | Exact functionality, as bullet points |
| Out of scope | `out` | What not to build, including tempting neighbors |
| Architecture constraints | `constraints` | Prompt-specific rules; group and standard rules are added automatically |
| Files to create | `create` | Path → purpose; a path may be created by one prompt only |
| Files to modify | `modify` | Path → change; the creating prompt must be an ancestor |
| Public interfaces | `interfaces` | Signatures, types, schemas |
| Implementation requirements | `requirements` | Precise, minimal |
| Testing requirements | `tests` | Unit, property, numerical, integration as appropriate, with tolerances and their sources |
| Verification commands | `verify` | Exact commands; `make check` is appended automatically |
| Acceptance criteria | `acceptance` | Objective, measurable |
| Failure handling | `failure` | Prompt-specific cases; standard cases are appended |
| Completion report | (standard) | |
| Metadata | `complexity`, `resources`, `review`, `conditional`, `phase`, `group` | See `tools/catalog/model.py` |
