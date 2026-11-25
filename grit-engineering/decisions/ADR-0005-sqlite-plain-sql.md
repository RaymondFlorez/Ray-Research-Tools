# ADR-0005: SQLite with plain SQL migrations, no ORM

Status: proposed · Date: 2026-11-25

## Decision
Metadata lives in SQLite (WAL mode) via stdlib `sqlite3`. Schema changes are numbered `.sql` files applied in a transaction and recorded in `schema_migrations`. Repositories are small modules of hand-written SQL. Current experiment state is derived from the transitions table, never stored separately.

## Why
Zero operational cost, transactional, portable SQL. An ORM adds a dependency and a second schema language for a dozen tables.

## Exit
At the ADR-0011 trigger (more than ~5 concurrent writers or multi-host), move to PostgreSQL. Migrations are written in the common subset of SQL; P106 adds a PostgreSQL CI job before the switch.
