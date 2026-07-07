"""Shared helpers for discovering filings from SEC's free bulk index files.

Two discovery mechanisms are used across the platform:
  * The quarterly full-index (`full-index/{year}/QTR{q}/form.idx`) lists every
    filing of every form type submitted that quarter -- the free bulk source
    used to discover which CIKs filed 13F-HR / Forms 3,4,5 without needing a
    hardcoded filer list.
  * Each individual filing's own directory index (`.../{accession}/index.json`)
    lists every document within that filing, which is how we find a 13F's
    information-table XML (a filer-chosen filename, not exposed by the
    submissions API's `primaryDocument` field).
"""
from __future__ import annotations

import re
from dataclasses import dataclass

import yaml

from src.common.http import HttpClient, sec_user_agent
from src.common.paths import PROJECT_ROOT, raw_path, timestamped_filename
from src.normalization.identifiers import normalize_cik


def _load_config() -> dict:
    with open(PROJECT_ROOT / "config" / "sources.yaml") as fh:
        return yaml.safe_load(fh)["sec"]


def _client() -> HttpClient:
    cfg = _load_config()
    return HttpClient(user_agent=sec_user_agent(), requests_per_sec=cfg.get("rate_limit_per_sec", 5))


@dataclass
class FormIndexEntry:
    form_type: str
    company_name: str
    cik: str
    date_filed: str
    file_name: str
    accession_number: str


def accession_from_file_name(file_name: str) -> str:
    """Turn 'edgar/data/1234/000095012310000000.txt' into '0000950123-10-000000'."""
    stem = file_name.rsplit("/", 1)[-1].removesuffix(".txt")
    digits = re.sub(r"\D", "", stem)
    if len(digits) != 18:
        raise ValueError(f"unexpected accession digits in file name: {file_name!r}")
    return f"{digits[0:10]}-{digits[10:12]}-{digits[12:18]}"


def parse_form_index(text: str) -> list[FormIndexEntry]:
    lines = text.splitlines()
    divider_idx = next(
        (
            i
            for i, line in enumerate(lines)
            if line.strip() and set(line.strip()) <= {"-", " "} and "-" in line
        ),
        None,
    )
    if divider_idx is None:
        return []

    spans = [m.span() for m in re.finditer(r"-+", lines[divider_idx])]
    if len(spans) < 5:
        return []

    entries: list[FormIndexEntry] = []
    for line in lines[divider_idx + 1 :]:
        if not line.strip():
            continue
        fields = [line[s:e].strip() for s, e in spans[:-1]]
        fields.append(line[spans[-1][0] :].strip())  # File Name column may run past its dash span
        if len(fields) < 5:
            continue
        form_type, company_name, cik, date_filed, file_name = fields[:5]
        try:
            accession_number = accession_from_file_name(file_name)
        except ValueError:
            continue
        entries.append(
            FormIndexEntry(
                form_type=form_type,
                company_name=company_name,
                cik=normalize_cik(cik) if cik.isdigit() else cik,
                date_filed=date_filed,
                file_name=file_name,
                accession_number=accession_number,
            )
        )
    return entries


def fetch_quarterly_form_index(
    year: int, quarter: int, form_types: set[str] | None = None, client: HttpClient | None = None
) -> list[FormIndexEntry]:
    """Fetch and parse one quarter's full-index form.idx, optionally filtered to `form_types`."""
    cfg = _load_config()
    client = client or _client()
    url = f"{cfg['base_www']}/Archives/edgar/full-index/{year}/QTR{quarter}/form.idx"
    response = client.get(url)
    raw_path("sec_full_index", timestamped_filename(f"form_{year}QTR{quarter}", "idx")).write_text(response.text)

    entries = parse_form_index(response.text)
    if form_types:
        entries = [e for e in entries if e.form_type in form_types]
    return entries


def fetch_filing_directory(cik: int | str, accession_number: str, client: HttpClient | None = None) -> list[str]:
    """List every document filename within one filing's accession folder via its index.json."""
    cfg = _load_config()
    client = client or _client()
    accession_nodash = accession_number.replace("-", "")
    url = f"{cfg['base_www']}/Archives/edgar/data/{int(cik)}/{accession_nodash}/index.json"
    response = client.get(url)
    payload = response.json()
    return [item["name"] for item in payload.get("directory", {}).get("item", [])]
