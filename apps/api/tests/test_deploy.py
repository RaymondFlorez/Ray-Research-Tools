"""Step 12: typed production config, migrations bookkeeping, readiness, demo agent."""

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from geoglobe_api.config import Settings, get_settings
from geoglobe_api.main import create_app
from geoglobe_api.migrate import Migration, MigrationError, load_migrations, migrations_dir, pending
from geoglobe_api.repository import InMemoryRepository


def test_production_requires_database_and_strong_secret():
    with pytest.raises(ValidationError, match="DATABASE_URL"):
        Settings(environment="production")
    with pytest.raises(ValidationError, match="at least 32"):
        Settings(environment="production", database_url="postgresql://x", jwt_secret="short")
    ok = Settings(environment="production", database_url="postgresql://x", jwt_secret="s" * 32)
    assert ok.environment == "production"


def test_auth_required_needs_a_secret_in_any_environment():
    with pytest.raises(ValidationError, match="JWT_SECRET"):
        Settings(auth_required=True)


def test_repo_migrations_are_found_and_ordered():
    migrations = load_migrations(migrations_dir())
    names = [m.name for m in migrations]
    assert names[:2] == ["001_init.sql", "002_rag.sql"]
    assert names == sorted(names)


def test_pending_skips_applied_and_refuses_edited_history():
    a, b = Migration("001_a.sql", "SELECT 1;"), Migration("002_b.sql", "SELECT 2;")
    assert pending([a, b], {}) == [a, b]
    assert pending([a, b], {"001_a.sql": a.checksum}) == [b]
    with pytest.raises(MigrationError, match="modified"):
        pending([a, b], {"001_a.sql": "stale-checksum"})


def test_health_and_ready():
    client = TestClient(create_app(repository=InMemoryRepository()))
    assert client.get("/health").json()["version"] == "0.1.0"
    assert client.get("/ready").json() == {"status": "ready"}


def test_demo_llm_runs_an_nl_query_end_to_end(monkeypatch):
    monkeypatch.setenv("GEOGLOBE_AGENT_LLM", "demo")
    get_settings.cache_clear()
    try:
        client = TestClient(create_app(repository=InMemoryRepository()))
        with client.websocket_connect("/ws/agent") as ws:
            for _ in range(2):  # the demo client is stateless: a second query works too
                ws.send_json({"query": "anything"})
                types = []
                while True:
                    event = ws.receive_json()
                    types.append(event["type"])
                    assert event["type"] != "error", event
                    if event["type"] == "done":
                        break
                assert "patch" in types
    finally:
        get_settings.cache_clear()


def test_blank_env_values_are_unset(monkeypatch):
    monkeypatch.setenv("GEOGLOBE_JWT_SECRET", "")
    monkeypatch.setenv("GEOGLOBE_REDIS_URL", "  ")
    s = Settings()
    assert s.jwt_secret is None and s.redis_url is None


def test_issued_token_is_accepted(monkeypatch):
    from geoglobe_api.issue_token import issue
    from geoglobe_api.security import scopes_from_claims, verify_jwt

    secret = "k" * 32
    monkeypatch.setenv("GEOGLOBE_JWT_SECRET", secret)
    get_settings.cache_clear()
    try:
        claims = verify_jwt(issue("alice", ["scene", "data"], 60), secret)
        assert claims["sub"] == "alice"
        assert scopes_from_claims(claims) == {"scene", "data"}
        with pytest.raises(SystemExit, match="unknown scopes"):
            issue("bob", ["root"], 60)
    finally:
        get_settings.cache_clear()
