"""FastAPI application exposing the securities master, prices, fundamentals, filings,
insider transactions, and institutional ownership as read-only JSON endpoints.

Run with: uvicorn src.api.app:app --reload
"""
from __future__ import annotations

from fastapi import FastAPI

from src.api.routes import filings, fundamentals, insiders, ownership, prices, securities

app = FastAPI(
    title="U.S. Equities Data Platform API",
    description="Free/legal U.S. public equities securities master, prices, fundamentals, and filings.",
    version="0.1.0",
)

app.include_router(securities.router)
app.include_router(prices.router)
app.include_router(fundamentals.router)
app.include_router(filings.router)
app.include_router(insiders.router)
app.include_router(ownership.router)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
