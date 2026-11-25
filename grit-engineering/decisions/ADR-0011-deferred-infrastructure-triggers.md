# ADR-0011: Deferred infrastructure with written triggers

Status: proposed · Date: 2026-11-25

## Decision
Infrastructure beyond Profile 1 is adopted only when its trigger fires. Each adoption gets its own ADR referencing the measurement.

| Component | Trigger |
|---|---|
| Single server (Profile 2) | First user other than the owner, or need for always-on API |
| Rented GPU (Profile 3) | A planned run estimated > 6 h on MPS, or training memory estimate > 10 GB |
| Object storage | Artifacts > 50 GB, or any GPU worker in use |
| PostgreSQL | > 5 concurrent writers, or more than one API host |
| Job queue beyond subprocess/Postgres | Queue wait > 1 h for a week |
| OpenTelemetry | More than one service on the request path |
| Multi-GPU training | A single run > 72 h on one GPU |
| Horizontal API scaling | Sustained p95 > 300 ms at measured load |
| Distributed inference engine | Deployed multi-user inference with measured throughput need |
