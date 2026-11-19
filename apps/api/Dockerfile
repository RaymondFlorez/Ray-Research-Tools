# GeoGlobe API (Data Service + agent). Build from the REPO ROOT so the SQL migrations in
# infra/db/init ship inside the image:
#   docker build -f apps/api/Dockerfile -t geoglobe/api .
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# libpq for psycopg; nothing else is needed at runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libpq5 \
    && rm -rf /var/lib/apt/lists/*

# Dependencies first (cached across code-only changes), then the package itself.
COPY apps/api/pyproject.toml ./
COPY apps/api/geoglobe_api ./geoglobe_api
RUN pip install ".[agent,cache]"

# Forward-only migrations applied by `python -m geoglobe_api.migrate`.
COPY infra/db/init ./migrations

RUN useradd --system --uid 10001 --no-create-home geoglobe
USER 10001

EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2)"

# One worker per container by default: scale with replicas, not workers, so in-process
# state (trace buffer, in-memory cache fallback) stays per-pod and predictable.
CMD ["sh", "-c", "exec uvicorn geoglobe_api.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips='*' --workers ${WEB_CONCURRENCY:-1}"]
