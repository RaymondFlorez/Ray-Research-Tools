# PostGIS + pgvector in one image, so the Data Service (geo) and RAG (vectors) share
# a single Postgres instance in dev. init/*.sql runs on first boot.
FROM postgis/postgis:16-3.4

RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-16-pgvector \
    && rm -rf /var/lib/apt/lists/*
