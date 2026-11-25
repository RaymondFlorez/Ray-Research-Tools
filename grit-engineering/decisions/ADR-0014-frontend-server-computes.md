# ADR-0014: React + TypeScript + D3 frontend; the server computes

Status: proposed · Date: 2026-11-25

## Decision
Vite, React, TypeScript strict, React Router, TanStack Query, a small Zustand store, D3 for charts, Playwright + axe for e2e. All scientific computation happens in Python behind `/api/v1/compute`; the client renders. API types are generated from OpenAPI.

## Why
One implementation of every equation, so the UI can't disagree with the library. Charts need exact control of scales and units, which D3 gives and most chart libraries hide.

## Consequences
Interactive instruments depend on API latency; the budget is p95 < 500 ms and instruments are classed instant/interactive/batch.
