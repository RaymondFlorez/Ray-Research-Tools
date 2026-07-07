"""Parsing tests for the trickier free-text/XML ingestion formats: Nasdaq's pipe-delimited
symbol directory, SEC Form 4 ownership XML, SEC 13F information-table XML, and SEC's
quarterly full-index form.idx.
"""
import datetime as dt

from src.common.sec_index import parse_form_index
from src.ingestion.nasdaq_symbols import parse_nasdaq_listed, parse_other_listed
from src.ingestion.sec_13f import parse_information_table_xml
from src.ingestion.sec_forms import parse_form4_xml

NASDAQ_LISTED_SAMPLE = (
    "Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares\n"
    "AAPL|Apple Inc. - Common Stock|Q|N|N|100|N|N\n"
    "SPY|SPDR S&P 500 ETF Trust|Q|N|N|100|Y|N\n"
    "ZTEST|Test Issue Common Stock|Q|Y|N|100|N|N\n"
    "File Creation Time: 0101202500:00|||||||\n"
)

OTHER_LISTED_SAMPLE = (
    "ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol\n"
    "BRK.A|Berkshire Hathaway Inc.|N|BRK.A|N|100|N|BRK.A\n"
    "File Creation Time: 0101202500:00|||||||\n"
)

FORM4_XML_SAMPLE = b"""<?xml version="1.0"?>
<ownershipDocument>
  <issuer>
    <issuerCik>0000320193</issuerCik>
    <issuerTradingSymbol>AAPL</issuerTradingSymbol>
  </issuer>
  <reportingOwner>
    <reportingOwnerId>
      <rptOwnerCik>0001214156</rptOwnerCik>
      <rptOwnerName>COOK TIMOTHY D</rptOwnerName>
    </reportingOwnerId>
    <reportingOwnerRelationship>
      <isDirector>1</isDirector>
      <isOfficer>1</isOfficer>
      <isTenPercentOwner>0</isTenPercentOwner>
      <officerTitle>Chief Executive Officer</officerTitle>
    </reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>2024-03-01</value></transactionDate>
      <transactionCoding><transactionCode>S</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>50000</value></transactionShares>
        <transactionPricePerShare><value>180.25</value></transactionPricePerShare>
      </transactionAmounts>
      <postTransactionAmounts>
        <sharesOwnedFollowingTransaction><value>3200000</value></sharesOwnedFollowingTransaction>
      </postTransactionAmounts>
      <ownershipNature>
        <directOrIndirectOwnership><value>D</value></directOrIndirectOwnership>
      </ownershipNature>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>
"""

INFO_TABLE_XML_SAMPLE = b"""<?xml version="1.0"?>
<informationTable xmlns="http://www.sec.gov/edgar/document/thirteenf/informationtable">
  <infoTable>
    <nameOfIssuer>APPLE INC</nameOfIssuer>
    <cusip>037833100</cusip>
    <value>1500000</value>
    <shrsOrPrnAmt>
      <sshPrnamt>8000</sshPrnamt>
      <sshPrnamtType>SH</sshPrnamtType>
    </shrsOrPrnAmt>
    <investmentDiscretion>SOLE</investmentDiscretion>
    <votingAuthority><Sole>8000</Sole><Shared>0</Shared><None>0</None></votingAuthority>
  </infoTable>
</informationTable>
"""

FORM_IDX_SAMPLE = (
    "Description:           Form Type   Company Name  CIK  Date Filed  File Name\n"
    "Last Data Received:    March 31, 2024\n"
    "Comments:              webmaster@sec.gov\n"
    "\n"
    "Form Type   Company Name                                                  CIK         Date Filed  File Name\n"
    "-----------  ------------------------------------------------------------  ----------  ----------  ----------------------------------------------\n"
    "4            COOK TIMOTHY D                                                1214156     2024-03-04  edgar/data/1214156/000121415624000012.txt\n"
    "13F-HR       EXAMPLE CAPITAL LLC                                           1234567     2024-02-14  edgar/data/1234567/000123456724000099.txt\n"
)


def test_parse_nasdaq_listed_maps_etf_and_test_issue_flags():
    records = parse_nasdaq_listed(NASDAQ_LISTED_SAMPLE)
    assert len(records) == 3
    by_symbol = {r.symbol: r for r in records}
    assert by_symbol["AAPL"].is_etf is False
    assert by_symbol["SPY"].is_etf is True
    assert by_symbol["ZTEST"].is_test_issue is True
    assert all(r.exchange == "Nasdaq" for r in records)


def test_parse_other_listed_maps_exchange_code():
    records = parse_other_listed(OTHER_LISTED_SAMPLE)
    assert len(records) == 1
    assert records[0].symbol == "BRK.A"
    assert records[0].exchange == "NYSE"


def test_parse_form4_xml_extracts_non_derivative_transaction():
    records = parse_form4_xml("0000320193-24-000012", FORM4_XML_SAMPLE)
    assert len(records) == 1
    txn = records[0]
    assert txn.issuer_cik == "0000320193"
    assert txn.reporting_owner_name == "COOK TIMOTHY D"
    assert txn.is_officer is True
    assert txn.transaction_code == "S"
    assert txn.shares == 50000
    assert txn.price_per_share == 180.25
    assert txn.transaction_date == dt.date(2024, 3, 1)


def test_parse_form4_xml_handles_no_transactions():
    xml = b"""<ownershipDocument>
        <issuer><issuerCik>320193</issuerCik></issuer>
        <reportingOwner><reportingOwnerId><rptOwnerCik>1</rptOwnerCik></reportingOwnerId></reportingOwner>
    </ownershipDocument>"""
    assert parse_form4_xml("0000320193-24-000001", xml) == []


def test_parse_information_table_xml_strips_namespace_and_extracts_holding():
    holdings = parse_information_table_xml("0001234567-24-000099", 1234567, "Example Capital LLC", INFO_TABLE_XML_SAMPLE)
    assert len(holdings) == 1
    h = holdings[0]
    assert h.cusip == "037833100"
    assert h.issuer_name == "APPLE INC"
    assert h.value_usd_thousands == 1500000
    assert h.shares_or_principal == 8000
    assert h.voting_authority_sole == 8000
    assert h.filer_cik == "0001234567"


def test_parse_form_index_extracts_entries_and_builds_accession_numbers():
    entries = parse_form_index(FORM_IDX_SAMPLE)
    assert len(entries) == 2
    assert entries[0].form_type == "4"
    assert entries[0].cik == "0001214156"
    assert entries[0].accession_number == "0001214156-24-000012"
    assert entries[1].form_type == "13F-HR"
    assert entries[1].accession_number == "0001234567-24-000099"


def test_parse_form_index_filters_by_form_type_via_caller():
    entries = [e for e in parse_form_index(FORM_IDX_SAMPLE) if e.form_type == "13F-HR"]
    assert len(entries) == 1
    assert entries[0].company_name == "EXAMPLE CAPITAL LLC"
