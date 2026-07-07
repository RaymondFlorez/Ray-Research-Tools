"""Command-line entrypoint for the U.S. equities data platform.

Examples:
    python -m src.main init-db
    python -m src.main daily-refresh
    python -m src.main quarterly-refresh --year 2025 --quarter 2
    python -m src.main backfill --ticker-limit 50
    python -m src.main serve --port 8000
"""
from __future__ import annotations

import click


@click.group()
def cli() -> None:
    """U.S. equities data platform CLI."""


@cli.command("init-db")
def init_db_cmd() -> None:
    """Create all tables and apply pending migrations."""
    from src.database.db import init_db

    init_db()
    click.echo("database initialized")


@cli.command("daily-refresh")
@click.option("--ticker-limit", type=int, default=None, help="Limit price refresh to N securities (testing/debug).")
def daily_refresh_cmd(ticker_limit: int | None) -> None:
    """Run the daily securities-master + price refresh job."""
    from src.jobs.daily_refresh import run

    run(ticker_limit=ticker_limit)


@cli.command("quarterly-refresh")
@click.option("--year", type=int, default=None)
@click.option("--quarter", type=int, default=None)
@click.option("--limit", type=int, default=None, help="Limit CIKs/filings processed (testing/debug).")
def quarterly_refresh_cmd(year: int | None, quarter: int | None, limit: int | None) -> None:
    """Run the quarterly fundamentals + Forms 3/4/5 + 13F-HR refresh job."""
    from src.jobs.quarterly_refresh import run

    run(year=year, quarter=quarter, limit=limit)


@cli.command("backfill")
@click.option("--ticker-limit", type=int, default=None)
@click.option("--cik-limit", type=int, default=None)
def backfill_cmd(ticker_limit: int | None, cik_limit: int | None) -> None:
    """Run a full cold-start backfill of securities master, fundamentals, and price history."""
    from src.jobs.backfill import run

    run(ticker_limit=ticker_limit, cik_limit=cik_limit)


@cli.command("serve")
@click.option("--host", default=None)
@click.option("--port", type=int, default=None)
@click.option("--reload", is_flag=True, default=False)
def serve_cmd(host: str | None, port: int | None, reload: bool) -> None:
    """Start the read-only JSON API server."""
    import os

    import uvicorn

    host = host or os.getenv("API_HOST", "0.0.0.0")
    port = port or int(os.getenv("API_PORT", "8000"))
    uvicorn.run("src.api.app:app", host=host, port=port, reload=reload)


if __name__ == "__main__":
    cli()
