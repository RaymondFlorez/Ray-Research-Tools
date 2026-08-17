from src.normalization.sic_codes import sic_to_industry, sic_to_sector


def test_known_codes_map_to_division_and_major_group():
    # 3571 = Electronic Computers (Apple's SIC)
    assert sic_to_sector("3571") == "Manufacturing"
    assert sic_to_industry("3571") == "Industrial and Commercial Machinery and Computer Equipment"
    # 6022 = State commercial banks
    assert sic_to_sector("6022") == "Finance, Insurance, and Real Estate"
    assert sic_to_industry("6022") == "Depository Institutions"
    # 7372 = Prepackaged software
    assert sic_to_sector("7372") == "Services"
    assert sic_to_industry("7372") == "Business Services"


def test_accepts_int_and_short_codes():
    assert sic_to_sector(3571) == "Manufacturing"
    # SEC data sometimes carries codes without leading zeros; 800 -> major group 08.
    assert sic_to_sector("800") == "Agriculture, Forestry, and Fishing"
    assert sic_to_industry("800") == "Forestry"


def test_invalid_inputs_return_none():
    assert sic_to_sector(None) is None
    assert sic_to_sector("") is None
    assert sic_to_sector("ABCD") is None
    assert sic_to_sector("123456") is None
    assert sic_to_industry(None) is None
    # Major group 11 was never assigned in the SIC taxonomy.
    assert sic_to_industry("1100") is None


def test_submissions_enrichment_populates_sector_industry(db_session):
    import datetime as dt

    from src.database.models import ListingStatus, Security
    from src.ingestion.sec_submissions import SubmissionsRecord
    from src.normalization.security_master import apply_submissions_enrichment

    security = Security(
        company_name="Apple Inc.",
        cik="0000320193",
        listing_status=ListingStatus.ACTIVE,
        first_seen_date=dt.date(2024, 1, 1),
    )
    db_session.add(security)
    db_session.flush()

    record = SubmissionsRecord(
        cik="0000320193",
        company_name="Apple Inc.",
        sic_code="3571",
        sic_description="Electronic Computers",
        tickers=["AAPL"],
        exchanges=["Nasdaq"],
        former_names=[],
    )
    apply_submissions_enrichment(db_session, security, record)
    db_session.commit()

    assert security.sector == "Manufacturing"
    assert security.industry == "Industrial and Commercial Machinery and Computer Equipment"
