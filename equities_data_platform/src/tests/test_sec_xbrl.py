from src.database.models import Fundamental, ListingStatus, Security
from src.ingestion.sec_company_facts import parse_company_facts_payload
from src.normalization.fundamentals import upsert_fundamentals

SAMPLE_PAYLOAD = {
    "cik": 320193,
    "entityName": "Apple Inc.",
    "facts": {
        "us-gaap": {
            "Assets": {
                "label": "Assets",
                "units": {
                    "USD": [
                        {
                            "end": "2023-09-30",
                            "val": 352583000000,
                            "fy": 2023,
                            "fp": "FY",
                            "form": "10-K",
                            "filed": "2023-11-03",
                            "accn": "0000320193-23-000106",
                        },
                        {
                            "end": "2022-09-24",
                            "val": 352755000000,
                            "fy": 2023,
                            "fp": "FY",
                            "form": "10-K",
                            "filed": "2023-11-03",
                            "accn": "0000320193-23-000106",
                        },
                    ]
                },
            }
        }
    },
}


def test_parse_company_facts_payload_extracts_all_observations():
    facts = parse_company_facts_payload(SAMPLE_PAYLOAD)
    assert len(facts) == 2
    assert facts[0].cik == "0000320193"
    assert facts[0].taxonomy == "us-gaap"
    assert facts[0].tag == "Assets"
    assert facts[0].unit == "USD"
    assert facts[0].value == 352583000000
    assert facts[1].period_end == "2022-09-24"


def test_upsert_fundamentals_inserts_and_dedupes(db_session):
    security = Security(cik="0000320193", company_name="Apple Inc.", listing_status=ListingStatus.ACTIVE)
    db_session.add(security)
    db_session.flush()

    facts = parse_company_facts_payload(SAMPLE_PAYLOAD)
    inserted, updated = upsert_fundamentals(db_session, security.security_id, facts)
    db_session.commit()
    assert inserted == 2
    assert updated == 0

    rows = db_session.query(Fundamental).filter_by(security_id=security.security_id).all()
    assert len(rows) == 2

    # Re-ingesting the same facts should update in place, not duplicate.
    inserted, updated = upsert_fundamentals(db_session, security.security_id, facts)
    db_session.commit()
    assert inserted == 0
    assert updated == 2
    rows = db_session.query(Fundamental).filter_by(security_id=security.security_id).all()
    assert len(rows) == 2


def test_upsert_fundamentals_skips_facts_without_period_end(db_session):
    security = Security(cik="0000320193", company_name="Apple Inc.", listing_status=ListingStatus.ACTIVE)
    db_session.add(security)
    db_session.flush()

    from src.ingestion.sec_company_facts import XbrlFact

    bad_fact = XbrlFact(
        cik="0000320193", taxonomy="us-gaap", tag="Assets", unit="USD", value=1.0,
        fiscal_year=2023, fiscal_period="FY", form="10-K", period_start=None,
        period_end="", filed_date=None, accession_number=None,
    )
    inserted, updated = upsert_fundamentals(db_session, security.security_id, [bad_fact])
    assert (inserted, updated) == (0, 0)
