#!/usr/bin/env bash
# Wrapper used by cron/systemd to run a platform job with the right environment.
#
#   Usage: run_job.sh <daily-refresh|quarterly-refresh|backfill> [extra args...]
#
# Keeps scheduler entries trivial (they just name a job) and puts the
# environment handling -- venv activation, .env loading, log capture with
# timestamps -- in one place instead of duplicated across crontab lines.
set -euo pipefail

PLATFORM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PLATFORM_DIR"

if [[ $# -lt 1 ]]; then
    echo "usage: $0 <daily-refresh|quarterly-refresh|backfill> [extra args...]" >&2
    exit 2
fi
JOB="$1"
shift

# Load environment (SEC_USER_AGENT, DATABASE_URL, ...) if a .env is present.
if [[ -f "$PLATFORM_DIR/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "$PLATFORM_DIR/.env"
    set +a
fi

# Prefer a project-local virtualenv when one exists.
if [[ -f "$PLATFORM_DIR/.venv/bin/activate" ]]; then
    # shellcheck disable=SC1091
    source "$PLATFORM_DIR/.venv/bin/activate"
fi

LOG_DIR="$PLATFORM_DIR/data/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/${JOB}_$(date -u +%Y%m%dT%H%M%SZ).log"

echo "[$(date -u '+%Y-%m-%d %H:%M:%SZ')] starting $JOB $*" | tee -a "$LOG_FILE"
if python -m src.main "$JOB" "$@" >>"$LOG_FILE" 2>&1; then
    echo "[$(date -u '+%Y-%m-%d %H:%M:%SZ')] $JOB finished OK" | tee -a "$LOG_FILE"
else
    status=$?
    echo "[$(date -u '+%Y-%m-%d %H:%M:%SZ')] $JOB FAILED (exit $status) -- see $LOG_FILE" | tee -a "$LOG_FILE" >&2
    exit "$status"
fi
