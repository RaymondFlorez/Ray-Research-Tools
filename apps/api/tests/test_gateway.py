"""Tests for the unified Tool Gateway: uniform tool list, MCP namespacing, scopes,
rate limits, and action-tool guardrails."""

import pytest

from geoglobe_api.agent.action import ActionConfig, ActionNotAllowed, check_url_allowed, geocode
from geoglobe_api.agent.gateway import build_gateway
from geoglobe_api.agent.mcp import StaticMCPConnection
from geoglobe_api.rag import build_seeded_service
from geoglobe_api.repository import InMemoryRepository


def _weather_server():
    return StaticMCPConnection(
        name="weather",
        tools=[
            {
                "name": "get_forecast",
                "description": "Get a forecast",
                "input_schema": {"type": "object", "properties": {"city": {"type": "string"}}},
            }
        ],
        handlers={"get_forecast": lambda args: f"Sunny in {args['city']}"},
    )


def test_all_categories_in_one_list():
    gw = build_gateway(InMemoryRepository(), rag=build_seeded_service(), mcp_connections=[_weather_server()])
    names = {d["name"] for d in gw.definitions()}
    # scene, data, rag, action, and the namespaced MCP tool all appear together.
    assert {"add_layer", "geo_query", "rag_search", "web_fetch", "geocode"} <= names
    assert "weather__get_forecast" in names


def test_mcp_tool_is_namespaced_and_invokable():
    gw = build_gateway(InMemoryRepository(), mcp_connections=[_weather_server()])
    result = gw.invoke("weather__get_forecast", {"city": "Tokyo"})
    assert not result.outcome.is_error
    assert result.outcome.result == "Sunny in Tokyo"
    assert result.category == "mcp"


def test_scope_enforcement():
    # Grant only 'data' — an action tool must be rejected, a data tool allowed.
    gw = build_gateway(InMemoryRepository(), granted_scopes={"data"})
    denied = gw.invoke("geocode", {"place": "tokyo"})
    assert denied.outcome.is_error
    assert "scope" in denied.outcome.result
    allowed = gw.invoke("geo_query", {"dataset": "earthquakes", "limit": 1})
    assert not allowed.outcome.is_error


def test_rate_limit():
    gw = build_gateway(InMemoryRepository())
    # geocode has a rate limit of 20; the 21st call is rejected.
    for _ in range(20):
        assert not gw.invoke("geocode", {"place": "tokyo"}).outcome.is_error
    assert gw.invoke("geocode", {"place": "tokyo"}).outcome.is_error


def test_geocode_resolves_and_flies():
    gw = build_gateway(InMemoryRepository())
    result = gw.invoke("geocode", {"place": "Tokyo"})
    assert not result.outcome.is_error
    assert "139.69" in result.outcome.result


def test_web_fetch_domain_allow_list():
    config = ActionConfig(allowed_domains=["example.com"])
    assert check_url_allowed("https://example.com/data.json", config) == "example.com"
    assert check_url_allowed("https://sub.example.com/x", config) == "sub.example.com"
    with pytest.raises(ActionNotAllowed):
        check_url_allowed("https://evil.test/x", config)
    with pytest.raises(ActionNotAllowed):
        check_url_allowed("file:///etc/passwd", config)


def test_web_fetch_blocked_via_gateway():
    gw = build_gateway(InMemoryRepository())
    result = gw.invoke("web_fetch", {"url": "https://not-allowed.test/x"})
    assert result.outcome.is_error
    assert "allow-list" in result.outcome.result


def test_geocode_unknown_place():
    with pytest.raises(ActionNotAllowed):
        geocode("atlantis")
