"""Ingest SEC Forms 3/4/5 (insider ownership and transaction reports).

Each Form 3/4/5 filing is an XML document ("primary_doc.xml" for filings made
under the modern EDGAR full-text system) listing the reporting owner and one
row per non-derivative (and derivative) transaction. We fetch the filing's
index to find the XML document, then parse it into structured transactions.
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from xml.etree import ElementTree as ET

import yaml

from src.common.http import HttpClient, sec_user_agent
from src.common.paths import PROJECT_ROOT, raw_path, timestamped_filename
from src.normalization.identifiers import normalize_cik

_SOURCE = "sec_forms"


def _load_config() -> dict:
    with open(PROJECT_ROOT / "config" / "sources.yaml") as fh:
        return yaml.safe_load(fh)["sec"]


def _client() -> HttpClient:
    cfg = _load_config()
    return HttpClient(user_agent=sec_user_agent(), requests_per_sec=cfg.get("rate_limit_per_sec", 5))


@dataclass
class InsiderTransactionRecord:
    accession_number: str
    issuer_cik: str
    issuer_ticker: str | None
    reporting_owner_cik: str | None
    reporting_owner_name: str | None
    is_officer: bool
    is_director: bool
    is_ten_percent_owner: bool
    officer_title: str | None
    transaction_date: dt.date | None
    transaction_code: str | None
    shares: float | None
    price_per_share: float | None
    shares_owned_after: float | None
    direct_or_indirect: str | None
    security_title: str | None


def _text(el: ET.Element | None) -> str | None:
    if el is None or el.text is None:
        return None
    return el.text.strip() or None


def _float(el: ET.Element | None) -> float | None:
    val = _text(el)
    try:
        return float(val) if val is not None else None
    except ValueError:
        return None


def _date(el: ET.Element | None) -> dt.date | None:
    val = _text(el)
    if not val:
        return None
    try:
        return dt.date.fromisoformat(val)
    except ValueError:
        return None


def parse_form4_xml(accession_number: str, xml_bytes: bytes) -> list[InsiderTransactionRecord]:
    """Parse a Form 3/4/5 `primary_doc.xml` (ownershipDocument schema) into transaction rows.

    Handles both non-derivative and derivative transaction tables; Form 3
    filings (initial statements of ownership) typically have zero
    transactions and only holdings, which are skipped here by design --
    holdings-only rows carry no transaction_code/date and are out of scope
    for the insider_transactions table.
    """
    root = ET.fromstring(xml_bytes)

    issuer_cik = normalize_cik(_text(root.find("./issuer/issuerCik")) or "0")
    issuer_ticker = _text(root.find("./issuer/issuerTradingSymbol"))

    owner_cik = _text(root.find("./reportingOwner/reportingOwnerId/rptOwnerCik"))
    owner_name = _text(root.find("./reportingOwner/reportingOwnerId/rptOwnerName"))

    relationship = root.find("./reportingOwner/reportingOwnerRelationship")
    is_officer = (_text(relationship.find("isOfficer")) if relationship is not None else None) == "1"
    is_director = (_text(relationship.find("isDirector")) if relationship is not None else None) == "1"
    is_ten_pct = (_text(relationship.find("isTenPercentOwner")) if relationship is not None else None) == "1"
    officer_title = _text(relationship.find("officerTitle")) if relationship is not None else None

    records: list[InsiderTransactionRecord] = []
    for table_tag, txn_tag in (("nonDerivativeTable", "nonDerivativeTransaction"), ("derivativeTable", "derivativeTransaction")):
        table = root.find(f"./{table_tag}")
        if table is None:
            continue
        for txn in table.findall(txn_tag):
            security_title = _text(txn.find("securityTitle/value"))
            amounts = txn.find("transactionAmounts")
            coding = txn.find("transactionCoding")
            post = txn.find("postTransactionAmounts/sharesOwnedFollowingTransaction/value")
            ownership_nature = txn.find("ownershipNature/directOrIndirectOwnership/value")

            records.append(
                InsiderTransactionRecord(
                    accession_number=accession_number,
                    issuer_cik=issuer_cik,
                    issuer_ticker=issuer_ticker.upper() if issuer_ticker else None,
                    reporting_owner_cik=normalize_cik(owner_cik) if owner_cik else None,
                    reporting_owner_name=owner_name,
                    is_officer=is_officer,
                    is_director=is_director,
                    is_ten_percent_owner=is_ten_pct,
                    officer_title=officer_title,
                    transaction_date=_date(txn.find("transactionDate/value")),
                    transaction_code=_text(coding.find("transactionCode")) if coding is not None else None,
                    shares=_float(amounts.find("transactionShares/value")) if amounts is not None else None,
                    price_per_share=_float(amounts.find("transactionPricePerShare/value"))
                    if amounts is not None
                    else None,
                    shares_owned_after=_float(post),
                    direct_or_indirect=_text(ownership_nature),
                    security_title=security_title,
                )
            )
    return records


def fetch_form4(cik: int | str, accession_number: str, primary_doc: str = "primary_doc.xml",
                 client: HttpClient | None = None) -> list[InsiderTransactionRecord]:
    """Fetch and parse one Form 3/4/5 filing given its issuer CIK, accession number, and doc name.

    Accession numbers and primary document names come from sec_submissions.fetch_submissions()
    (`recent_filings`), which callers should pass through job orchestration.
    """
    cfg = _load_config()
    client = client or _client()
    accession_nodash = accession_number.replace("-", "")
    url = cfg["submission_archive_template"].format(
        cik=str(int(cik)), accession_nodash=accession_nodash, doc=primary_doc
    )
    response = client.get(url)
    raw_path(_SOURCE, timestamped_filename(accession_number, "xml")).write_bytes(response.content)
    return parse_form4_xml(accession_number, response.content)
