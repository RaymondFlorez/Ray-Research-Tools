FROM python:3.11-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1

# System deps for psycopg + geo libs.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libpq5 \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml ./
COPY geoglobe_api ./geoglobe_api
RUN pip install --no-cache-dir .

EXPOSE 8000
CMD ["uvicorn", "geoglobe_api.main:app", "--host", "0.0.0.0", "--port", "8000"]
