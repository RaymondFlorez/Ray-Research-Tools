"""Ingest SEC EDGAR's per-company submissions API.

https://data.sec.gov/submissions/CIK##########.json returns entity metadata
(name, SIC, exchanges, tickers) plus former names with date ranges -- which is
exactly what we need to detect historical company/ticker name changes -- and
a rolling window of recent filings (form type, accession number, filing date).
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field

import yaml

from src.common.http import HttpClient, sec_user_agent
from src.common.paths import PROJECT_ROOT, raw_path, timestamped_filename
from src.normalization.identifiers import normalize_cik

_SOURCE = "sec_submissions"


def _load_config() -> dict:
    with open(PROJECT_ROOT / "config" / "sources.yaml") as fh:
        return yaml.safe_load(fh)["sec"]


def _client() -> HttpClient:
    cfg = _load_config()
    return HttpClient(user_agent=sec_user_agent(), requests_per_sec=cfg.get("rate_limit_per_sec", 5))


@dataclass
class FormerName:
    name: str
    start_date: str | None
    end_date: str | None


@dataclass
class FilingRef:
    accession_number: str
    form_type: str
    filing_date: str
    period_of_report: str | None
    primary_document: str | None


@dataclass
class SubmissionsRecord:
    cik: str
    company_name: str
    sic_code: str | None
    sic_description: str | None
    exchanges: list[str] = field(default_factory=list)
    tickers: list[str] = field(default_factory=list)
    former_names: list[FormerName] = field(default_factory=list)
    listing_status: str = "active"  # SEC does not directly expose this; caller may override
    recent_filings: list[FilingRef] = field(default_factory=list)


def parse_submissions_payload(payload: dict) -> SubmissionsRecord:
    former_names = [
        FormerName(name=fn.get("name", ""), start_date=fn.get("from"), end_date=fn.get("to"))
        for fn in payload.get("formerNames", [])
    ]

    recent = payload.get("filings", {}).get("recent", {})
    filings = []
    accession_numbers = recent.get("accessionNumber", [])
    for i in range(len(accession_numbers)):
        filings.append(
            FilingRef(
                accession_number=accession_numbers[i],
                form_type=recent.get("form", [None] * len(accession_numbers))[i],
                filing_date=recent.get("filingDate", [None] * len(accession_numbers))[i],
                period_of_report=recent.get("reportDate", [None] * len(accession_numbers))[i] or None,
                primary_document=recent.get("primaryDocument", [None] * len(accession_numbers))[i],
            )
        )

    return SubmissionsRecord(
        cik=normalize_cik(payload["cik"]),
        company_name=payload.get("name", ""),
        sic_code=payload.get("sic") or None,
        sic_description=payload.get("sicDescription") or None,
        exchanges=[e for e in payload.get("exchanges", []) if e],
        tickers=[t.upper() for t in payload.get("tickers", []) if t],
        former_names=former_names,
        listing_status="delisted" if payload.get("tickers") == [] else "active",
        recent_filings=filings,
    )


def fetch_submissions(cik: int | str, client: HttpClient | None = None) -> SubmissionsRecord:
    cik10 = normalize_cik(cik)
    cfg = _load_config()
    client = client or _client()
    url = cfg["submissions_url_template"].format(cik10=cik10)
    response = client.get(url)
    raw_path(_SOURCE, timestamped_filename(f"CIK{cik10}", "json")).write_bytes(response.content)
    return parse_submissions_payload(response.json())


def parse_submissions_bytes(content: bytes) -> SubmissionsRecord:
    return parse_submissions_payload(json.loads(content))
