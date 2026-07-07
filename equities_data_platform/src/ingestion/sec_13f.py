"""Ingest SEC Form 13F-HR institutional ownership filings.

A 13F-HR filing's economic content lives in its "information table" XML,
listing one row per position (issuer name, CUSIP, value, shares, voting
authority). We parse that table directly; matching each CUSIP back to a
`security_id` is left to normalization/fundamentals-adjacent code since it
requires a CUSIP -> security lookup against the securities master.
"""
from __future__ import annotations

from dataclasses import dataclass
from xml.etree import ElementTree as ET

import yaml

from src.common.http import HttpClient, sec_user_agent
from src.common.paths import PROJECT_ROOT, raw_path, timestamped_filename
from src.common.sec_index import fetch_filing_directory
from src.normalization.identifiers import normalize_cik

_SOURCE = "sec_13f"

# The information table schema uses a namespace that varies by filer software;
# we strip namespaces rather than hardcode one, since 13F XML is auto-generated
# by many different vendor tools with inconsistent namespace URIs.


def _strip_namespaces(root: ET.Element) -> ET.Element:
    for el in root.iter():
        if "}" in el.tag:
            el.tag = el.tag.split("}", 1)[1]
    return root


def _load_config() -> dict:
    with open(PROJECT_ROOT / "config" / "sources.yaml") as fh:
        return yaml.safe_load(fh)["sec"]


def _client() -> HttpClient:
    cfg = _load_config()
    return HttpClient(user_agent=sec_user_agent(), requests_per_sec=cfg.get("rate_limit_per_sec", 5))


@dataclass
class Holding13F:
    accession_number: str
    filer_cik: str
    filer_name: str | None
    issuer_name: str | None
    cusip: str | None
    value_usd_thousands: float | None
    shares_or_principal: float | None
    share_type: str | None
    investment_discretion: str | None
    voting_authority_sole: float | None


def _text(el: ET.Element | None) -> str | None:
    if el is None or el.text is None:
        return None
    return el.text.strip() or None


def _float(el: ET.Element | None) -> float | None:
    val = _text(el)
    if val is None:
        return None
    try:
        return float(val.replace(",", ""))
    except ValueError:
        return None


def parse_information_table_xml(
    accession_number: str, filer_cik: int | str, filer_name: str | None, xml_bytes: bytes
) -> list[Holding13F]:
    root = _strip_namespaces(ET.fromstring(xml_bytes))
    cik10 = normalize_cik(filer_cik)

    holdings: list[Holding13F] = []
    for entry in root.findall(".//infoTable"):
        voting = entry.find("votingAuthority/Sole")
        holdings.append(
            Holding13F(
                accession_number=accession_number,
                filer_cik=cik10,
                filer_name=filer_name,
                issuer_name=_text(entry.find("nameOfIssuer")),
                cusip=_text(entry.find("cusip")),
                value_usd_thousands=_float(entry.find("value")),
                shares_or_principal=_float(entry.find("shrsOrPrnAmt/sshPrnamt")),
                share_type=_text(entry.find("shrsOrPrnAmt/sshPrnamtType")),
                investment_discretion=_text(entry.find("investmentDiscretion")),
                voting_authority_sole=_float(voting),
            )
        )
    return holdings


def guess_information_table_document(
    filer_cik: int | str, accession_number: str, client: HttpClient | None = None
) -> str | None:
    """Find the information-table XML within a 13F-HR filing's directory.

    The submissions API's `primaryDocument` field points at the Form 13F
    cover page (typically `primary_doc.xml`), not the information table,
    which is a separate, filer-chosen XML file. We list the filing's
    directory and pick the first XML document that isn't the cover page.
    """
    filenames = fetch_filing_directory(filer_cik, accession_number, client)
    candidates = [f for f in filenames if f.lower().endswith(".xml") and f.lower() != "primary_doc.xml"]
    return candidates[0] if candidates else None


def fetch_information_table(
    filer_cik: int | str, accession_number: str, doc: str, filer_name: str | None = None,
    client: HttpClient | None = None,
) -> list[Holding13F]:
    """Fetch and parse the information-table XML for one 13F-HR filing.

    `doc` is the information table's filename within the filing's accession
    folder (commonly `infotable.xml` or a filer-chosen name), discoverable via
    the filing's index page or the accession's recent-filings metadata.
    """
    cfg = _load_config()
    client = client or _client()
    accession_nodash = accession_number.replace("-", "")
    url = cfg["submission_archive_template"].format(
        cik=str(int(filer_cik)), accession_nodash=accession_nodash, doc=doc
    )
    response = client.get(url)
    raw_path(_SOURCE, timestamped_filename(accession_number, "xml")).write_bytes(response.content)
    return parse_information_table_xml(accession_number, filer_cik, filer_name, response.content)
