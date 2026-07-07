-- GeoGlobe schema — initial migration.
-- Applied automatically by the postgis container (mounted into /docker-entrypoint-initdb.d).

CREATE EXTENSION IF NOT EXISTS postgis;
-- pgvector (CREATE EXTENSION vector) is added in Step 8 with a pgvector-enabled image.

CREATE TABLE IF NOT EXISTS earthquakes (
  id     TEXT PRIMARY KEY,
  geom   geometry(Point, 4326) NOT NULL,
  mag    DOUBLE PRECISION,
  depth  DOUBLE PRECISION,
  place  TEXT,
  time   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS earthquakes_geom_gix ON earthquakes USING GIST (geom);
CREATE INDEX IF NOT EXISTS earthquakes_time_ix ON earthquakes (time);
CREATE INDEX IF NOT EXISTS earthquakes_mag_ix ON earthquakes (mag);

-- Read-only role used by the Data Service query endpoints (defense in depth, Step 10).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'geoglobe_ro') THEN
    CREATE ROLE geoglobe_ro NOLOGIN;
  END IF;
END
$$;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO geoglobe_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO geoglobe_ro;
