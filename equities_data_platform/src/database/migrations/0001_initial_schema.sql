-- Canonical DDL reference for the U.S. equities securities master schema.
-- This mirrors src/database/models.py. In normal operation the app creates
-- tables via SQLAlchemy (`init_db()`); this file exists so the schema can be
-- inspected, reviewed, or applied by hand with sqlite3/psql, and is also
-- replayed verbatim as migrations/0001_initial_schema.sql.
--
-- Compatible with SQLite and PostgreSQL (avoid engine-specific extensions).

CREATE TABLE IF NOT EXISTS securities (
    security_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    permanent_id    VARCHAR(36) NOT NULL UNIQUE,
    cik             VARCHAR(10),
    company_name    VARCHAR(512) NOT NULL,
    security_type   VARCHAR(32) NOT NULL DEFAULT 'other',
    exchange        VARCHAR(32),
    listing_status  VARCHAR(16) NOT NULL DEFAULT 'unknown',
    sic_code        VARCHAR(8),
    sic_description VARCHAR(256),
    sector          VARCHAR(128),
    industry        VARCHAR(128),
    is_etf          BOOLEAN NOT NULL DEFAULT 0,
    is_test_issue   BOOLEAN NOT NULL DEFAULT 0,
    first_seen_date DATE,
    last_seen_date  DATE,
    source          VARCHAR(64) NOT NULL DEFAULT 'sec_tickers',
    created_at      TIMESTAMP,
    updated_at      TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ix_securities_cik ON securities (cik);
CREATE INDEX IF NOT EXISTS ix_securities_permanent_id ON securities (permanent_id);
CREATE INDEX IF NOT EXISTS ix_securities_cik_name ON securities (cik, company_name);

CREATE TABLE IF NOT EXISTS tickers (
    ticker_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    security_id   INTEGER NOT NULL REFERENCES securities (security_id),
    ticker        VARCHAR(16) NOT NULL,
    exchange      VARCHAR(32),
    start_date    DATE NOT NULL,
    end_date      DATE,
    is_primary    BOOLEAN NOT NULL DEFAULT 1,
    source        VARCHAR(64) NOT NULL DEFAULT 'sec_tickers',
    created_at    TIMESTAMP,
    UNIQUE (security_id, ticker, start_date)
);
CREATE INDEX IF NOT EXISTS ix_tickers_ticker ON tickers (ticker);
CREATE INDEX IF NOT EXISTS ix_tickers_ticker_active ON tickers (ticker, end_date);
CREATE INDEX IF NOT EXISTS ix_tickers_security_id ON tickers (security_id);

CREATE TABLE IF NOT EXISTS security_identifiers (
    identifier_id INTEGER PRIMARY KEY AUTOINCREMENT,
    security_id   INTEGER NOT NULL REFERENCES securities (security_id),
    id_type       VARCHAR(16) NOT NULL,
    id_value      VARCHAR(64) NOT NULL,
    start_date    DATE,
    end_date      DATE,
    is_primary    BOOLEAN NOT NULL DEFAULT 1,
    source        VARCHAR(64) NOT NULL DEFAULT 'sec',
    created_at    TIMESTAMP,
    UNIQUE (id_type, id_value, security_id)
);
CREATE INDEX IF NOT EXISTS ix_identifiers_value ON security_identifiers (id_value);
CREATE INDEX IF NOT EXISTS ix_identifiers_security_id ON security_identifiers (security_id);

CREATE TABLE IF NOT EXISTS prices (
    price_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    security_id  INTEGER NOT NULL REFERENCES securities (security_id),
    trade_date   DATE NOT NULL,
    open         NUMERIC(18, 6),
    high         NUMERIC(18, 6),
    low          NUMERIC(18, 6),
    close        NUMERIC(18, 6),
    adj_close    NUMERIC(18, 6),
    volume       INTEGER,
    source       VARCHAR(32) NOT NULL DEFAULT 'stooq',
    created_at   TIMESTAMP,
    UNIQUE (security_id, trade_date, source)
);
CREATE INDEX IF NOT EXISTS ix_prices_security_date ON prices (security_id, trade_date);

CREATE TABLE IF NOT EXISTS corporate_actions (
    action_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    security_id    INTEGER NOT NULL REFERENCES securities (security_id),
    action_type    VARCHAR(32) NOT NULL,
    effective_date DATE NOT NULL,
    details        TEXT,
    source         VARCHAR(64) NOT NULL DEFAULT 'sec_submissions',
    created_at     TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ix_corp_actions_security_date ON corporate_actions (security_id, effective_date);

CREATE TABLE IF NOT EXISTS fundamentals (
    fundamental_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    security_id      INTEGER NOT NULL REFERENCES securities (security_id),
    taxonomy         VARCHAR(16) NOT NULL,
    tag              VARCHAR(128) NOT NULL,
    unit             VARCHAR(32) NOT NULL,
    fiscal_year      INTEGER,
    fiscal_period    VARCHAR(4),
    form             VARCHAR(16),
    period_start     DATE,
    period_end       DATE NOT NULL,
    filed_date       DATE,
    value            NUMERIC(28, 4) NOT NULL,
    accession_number VARCHAR(32),
    source           VARCHAR(64) NOT NULL DEFAULT 'sec_company_facts',
    created_at       TIMESTAMP,
    UNIQUE (security_id, taxonomy, tag, unit, period_end, fiscal_period, accession_number)
);
CREATE INDEX IF NOT EXISTS ix_fundamentals_security_tag ON fundamentals (security_id, tag);

CREATE TABLE IF NOT EXISTS filings (
    accession_number VARCHAR(32) PRIMARY KEY,
    cik              VARCHAR(10) NOT NULL,
    security_id      INTEGER REFERENCES securities (security_id),
    form_type        VARCHAR(16) NOT NULL,
    filing_date      DATE NOT NULL,
    period_of_report DATE,
    primary_doc_url  VARCHAR(512),
    raw_path         VARCHAR(512),
    source           VARCHAR(64) NOT NULL DEFAULT 'sec_forms',
    created_at       TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ix_filings_cik_form ON filings (cik, form_type);

CREATE TABLE IF NOT EXISTS insider_transactions (
    transaction_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    accession_number     VARCHAR(32) REFERENCES filings (accession_number),
    security_id          INTEGER REFERENCES securities (security_id),
    reporting_owner_cik  VARCHAR(10),
    reporting_owner_name VARCHAR(256),
    is_officer           BOOLEAN NOT NULL DEFAULT 0,
    is_director          BOOLEAN NOT NULL DEFAULT 0,
    is_ten_percent_owner BOOLEAN NOT NULL DEFAULT 0,
    officer_title        VARCHAR(128),
    transaction_date     DATE,
    transaction_code     VARCHAR(4),
    shares               NUMERIC(20, 4),
    price_per_share      NUMERIC(18, 4),
    shares_owned_after   NUMERIC(20, 4),
    direct_or_indirect   VARCHAR(1),
    security_title       VARCHAR(128),
    source               VARCHAR(64) NOT NULL DEFAULT 'sec_forms',
    created_at           TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ix_insider_txn_security_date ON insider_transactions (security_id, transaction_date);

CREATE TABLE IF NOT EXISTS institutional_holdings (
    holding_id            INTEGER PRIMARY KEY AUTOINCREMENT,
    accession_number      VARCHAR(32) REFERENCES filings (accession_number),
    filer_cik             VARCHAR(10) NOT NULL,
    filer_name            VARCHAR(256),
    period_of_report      DATE,
    security_id           INTEGER REFERENCES securities (security_id),
    cusip                 VARCHAR(9),
    issuer_name           VARCHAR(256),
    value_usd_thousands   NUMERIC(20, 2),
    shares_or_principal   NUMERIC(20, 2),
    share_type            VARCHAR(8),
    investment_discretion VARCHAR(8),
    voting_authority_sole NUMERIC(20, 2),
    source                VARCHAR(64) NOT NULL DEFAULT 'sec_13f',
    created_at            TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ix_holdings_security ON institutional_holdings (security_id);
CREATE INDEX IF NOT EXISTS ix_holdings_cusip ON institutional_holdings (cusip);

CREATE TABLE IF NOT EXISTS ingestion_runs (
    run_id             INTEGER PRIMARY KEY AUTOINCREMENT,
    job_name           VARCHAR(64) NOT NULL,
    source             VARCHAR(64) NOT NULL,
    started_at         TIMESTAMP,
    finished_at        TIMESTAMP,
    status             VARCHAR(16) NOT NULL DEFAULT 'running',
    records_processed  INTEGER NOT NULL DEFAULT 0,
    records_inserted   INTEGER NOT NULL DEFAULT 0,
    records_updated    INTEGER NOT NULL DEFAULT 0,
    error_count        INTEGER NOT NULL DEFAULT 0,
    notes              TEXT
);

CREATE TABLE IF NOT EXISTS error_log (
    error_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id     INTEGER REFERENCES ingestion_runs (run_id),
    source     VARCHAR(64) NOT NULL,
    entity_ref VARCHAR(256),
    severity   VARCHAR(16) NOT NULL DEFAULT 'error',
    message    TEXT NOT NULL,
    raised_at  TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ix_error_log_run ON error_log (run_id);

CREATE TABLE IF NOT EXISTS schema_migrations (
    version    VARCHAR(64) PRIMARY KEY,
    applied_at TIMESTAMP
);
