"""Ingest SEC EDGAR's XBRL "company facts" API: all reported financial facts for one issuer.

https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json returns every
XBRL fact the company has ever reported, grouped by taxonomy (us-gaap, dei,
...) and tag (Assets, Revenues, ...), each with a list of period/value/form
observations. This is the free, official replacement for paid fundamentals
data feeds, at the cost of needing this normalization step.
"""
from __future__ import annotations

import json
from dataclasses import dataclass

import yaml

from src.common.http import HttpClient, sec_user_agent
from src.common.paths import PROJECT_ROOT, raw_path, timestamped_filename
from src.normalization.identifiers import normalize_cik

_SOURCE = "sec_company_facts"


def _load_config() -> dict:
    with open(PROJECT_ROOT / "config" / "sources.yaml") as fh:
        return yaml.safe_load(fh)["sec"]


def _client() -> HttpClient:
    cfg = _load_config()
    return HttpClient(user_agent=sec_user_agent(), requests_per_sec=cfg.get("rate_limit_per_sec", 5))


@dataclass
class XbrlFact:
    cik: str
    taxonomy: str
    tag: str
    unit: str
    value: float
    fiscal_year: int | None
    fiscal_period: str | None
    form: str | None
    period_start: str | None
    period_end: str
    filed_date: str | None
    accession_number: str | None


def parse_company_facts_payload(payload: dict) -> list[XbrlFact]:
    cik = normalize_cik(payload["cik"])
    facts: list[XbrlFact] = []
    for taxonomy, tags in payload.get("facts", {}).items():
        for tag, tag_body in tags.items():
            for unit, observations in tag_body.get("units", {}).items():
                for obs in observations:
                    facts.append(
                        XbrlFact(
                            cik=cik,
                            taxonomy=taxonomy,
                            tag=tag,
                            unit=unit,
                            value=obs["val"],
                            fiscal_year=obs.get("fy"),
                            fiscal_period=obs.get("fp"),
                            form=obs.get("form"),
                            period_start=obs.get("start"),
                            period_end=obs["end"],
                            filed_date=obs.get("filed"),
                            accession_number=obs.get("accn"),
                        )
                    )
    return facts


def fetch_company_facts(cik: int | str, client: HttpClient | None = None) -> list[XbrlFact]:
    cik10 = normalize_cik(cik)
    cfg = _load_config()
    client = client or _client()
    url = cfg["company_facts_url_template"].format(cik10=cik10)
    response = client.get(url)
    raw_path(_SOURCE, timestamped_filename(f"CIK{cik10}", "json")).write_bytes(response.content)
    return parse_company_facts_payload(response.json())


def parse_company_facts_bytes(content: bytes) -> list[XbrlFact]:
    return parse_company_facts_payload(json.loads(content))
