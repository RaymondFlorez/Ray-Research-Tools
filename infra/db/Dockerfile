# PostGIS + pgvector in one image, so the Data Service (geo) and RAG (vectors) share a
# single Postgres. pgvector is copied from the official pgvector image rather than
# installed with apt: the build needs no package mirrors and both versions are pinned.
# vector.so only depends on glibc >= 2.14 and Postgres extensions are ABI-stable within
# a major version, so a pg16 build from the pgvector image runs on the PostGIS pg16 base.
# init/*.sql runs on first boot (dev); production uses `python -m geoglobe_api.migrate`.
FROM pgvector/pgvector:0.8.0-pg16 AS pgvector

FROM postgis/postgis:16-3.5
COPY --from=pgvector /usr/lib/postgresql/16/lib/vector.so /usr/lib/postgresql/16/lib/
COPY --from=pgvector /usr/lib/postgresql/16/lib/bitcode/vector /usr/lib/postgresql/16/lib/bitcode/vector
COPY --from=pgvector /usr/lib/postgresql/16/lib/bitcode/vector.index.bc /usr/lib/postgresql/16/lib/bitcode/
COPY --from=pgvector /usr/share/postgresql/16/extension/vector* /usr/share/postgresql/16/extension/
