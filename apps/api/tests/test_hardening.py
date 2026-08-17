"""Step 10 hardening tests: JWT auth, patch guard, tracing/token metrics, guardrails."""

import time

import pytest
from fastapi.testclient import TestClient

from geoglobe_api.agent.gateway import build_gateway
from geoglobe_api.agent.llm import AssistantTurn, ScriptedLLMClient, ToolCall, Usage
from geoglobe_api.agent.orchestrator import Orchestrator
from geoglobe_api.agent.patch_guard import PatchInvalid, validate_patch_ops
from geoglobe_api.config import get_settings
from geoglobe_api.main import create_app
from geoglobe_api.repository import InMemoryRepository
from geoglobe_api.security import JwtError, scopes_from_claims, sign_jwt, verify_jwt
from geoglobe_api.tracing import TraceRecorder, TraceStore, estimate_cost

SECRET = "test-secret"


# ---- JWT ----------------------------------------------------------------------------


def test_jwt_roundtrip_and_scopes():
    token = sign_jwt({"sub": "alice", "scope": "scene data", "exp": time.time() + 60}, SECRET)
    claims = verify_jwt(token, SECRET)
    assert claims["sub"] == "alice"
    assert scopes_from_claims(claims) == {"scene", "data"}


def test_jwt_rejects_bad_signature_and_expiry():
    token = sign_jwt({"sub": "alice", "exp": time.time() + 60}, SECRET)
    with pytest.raises(JwtError):
        verify_jwt(token, "wrong-secret")
    expired = sign_jwt({"sub": "alice", "exp": time.time() - 10}, SECRET)
    with pytest.raises(JwtError):
        verify_jwt(expired, SECRET)


def test_endpoints_require_token_when_auth_enabled(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "auth_required", True)
    monkeypatch.setattr(settings, "jwt_secret", SECRET)
    client = TestClient(create_app(repository=InMemoryRepository()))

    # No token → 401.
    assert client.post("/query/geo", json={"dataset": "earthquakes"}).status_code == 401
    # Garbage token → 401.
    assert (
        client.post(
            "/query/geo",
            json={"dataset": "earthquakes"},
            headers={"Authorization": "Bearer nope"},
        ).status_code
        == 401
    )
    # Valid token → 200.
    token = sign_jwt({"sub": "alice", "scope": "data", "exp": time.time() + 60}, SECRET)
    ok = client.post(
        "/query/geo",
        json={"dataset": "earthquakes", "limit": 1},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert ok.status_code == 200


# ---- Patch guard --------------------------------------------------------------------


def test_patch_guard_accepts_valid_ops():
    ops = [
        {"op": "replace", "path": "/viewport", "value": {}},
        {"op": "add", "path": "/layers/-", "value": {"id": "x"}},
        {"op": "remove", "path": "/layers/0"},
    ]
    assert validate_patch_ops(ops) == ops


@pytest.mark.parametrize(
    "bad",
    [
        [{"op": "exec", "path": "/x", "value": 1}],  # unknown op
        [{"op": "replace", "path": "no-slash", "value": 1}],  # bad pointer
        [{"op": "replace", "path": "/x"}],  # missing value
        [{"op": "move", "path": "/x"}],  # missing from
        [{"path": "/x", "value": 1}],  # missing op
    ],
)
def test_patch_guard_rejects_malformed(bad):
    with pytest.raises(PatchInvalid):
        validate_patch_ops(bad)


# ---- Tracing + token/cost metrics ---------------------------------------------------


def test_trace_records_tools_patches_usage_and_cost():
    turns = [
        AssistantTurn(
            text="",
            tool_calls=[ToolCall(id="t1", name="fly_to", input={"longitude": 10, "latitude": 20})],
            assistant_content=[],
            stop_reason="tool_use",
            usage=Usage(input_tokens=1000, output_tokens=100),
        ),
        AssistantTurn(
            text="done",
            tool_calls=[],
            assistant_content=[],
            stop_reason="end_turn",
            usage=Usage(input_tokens=2000, output_tokens=50),
        ),
    ]
    orch = Orchestrator(
        llm=ScriptedLLMClient(turns=turns),
        gateway=build_gateway(InMemoryRepository()),
        planner_model="claude-opus-4-8",
        fast_model="claude-sonnet-4-6",
        max_turns=4,
    )
    recorder = TraceRecorder("fly somewhere")
    events = list(orch.run("fly somewhere", recorder=recorder))
    trace = recorder.finish()

    # Replayable log: the tool call and its patch are recorded in order.
    assert [t.name for t in trace.tool_calls] == ["fly_to"]
    assert trace.patches and trace.patches[0]["path"] == "/viewport"
    # Spans cover request → turns → tool.
    span_names = [s.name for s in trace.spans]
    assert "agent.request" in span_names and "tool" in span_names
    # Token + cost accounting (opus turn + sonnet turn).
    assert trace.input_tokens == 3000 and trace.output_tokens == 150
    expected = estimate_cost("claude-opus-4-8", 1000, 100) + estimate_cost(
        "claude-sonnet-4-6", 2000, 50
    )
    assert trace.cost_usd == pytest.approx(expected)
    # The stream surfaced a usage event before done.
    kinds = [e.type for e in events]
    assert kinds[-2:] == ["usage", "done"]
    usage_event = events[-2].data
    assert usage_event["input_tokens"] == 3000
    assert usage_event["trace_id"] == trace.id


def test_orchestrator_blocks_malformed_patch(monkeypatch):
    # Force a scene tool to emit a malformed patch; the orchestrator must reject it
    # rather than forwarding it to the client.
    from geoglobe_api.agent import executor as executor_mod
    from geoglobe_api.agent.executor import ToolOutcome

    def evil_scene(self, name, args):
        return ToolOutcome(result="evil", patches=[{"op": "exec", "path": "/x", "value": 1}])

    monkeypatch.setattr(executor_mod.ToolExecutor, "_scene", evil_scene)

    turns = [
        AssistantTurn(
            text="",
            tool_calls=[ToolCall(id="t1", name="fly_to", input={"longitude": 0, "latitude": 0})],
            assistant_content=[],
            stop_reason="tool_use",
        ),
        AssistantTurn(text="ok", tool_calls=[], assistant_content=[], stop_reason="end_turn"),
    ]
    orch = Orchestrator(
        llm=ScriptedLLMClient(turns=turns),
        gateway=build_gateway(InMemoryRepository()),
        planner_model="p",
        fast_model="f",
        max_turns=4,
    )
    events = list(orch.run("x"))
    assert not [e for e in events if e.type == "patch"]  # nothing forwarded
    errors = [e for e in events if e.type == "tool_result" and "patch rejected" in e.data["result"]]
    assert errors


def test_trace_store_is_bounded_and_queryable():
    store = TraceStore(capacity=2)
    ids = []
    for i in range(3):
        rec = TraceRecorder(f"q{i}")
        ids.append(rec.trace.id)
        store.add(rec.finish())
    listed = store.list()
    assert len(listed) == 2  # oldest evicted
    assert store.get(ids[0]) is None
    assert store.get(ids[2]) is not None


def test_traces_endpoint_serves_traces():
    client = TestClient(create_app(repository=InMemoryRepository()))
    from geoglobe_api.main import get_trace_store

    rec = TraceRecorder("test query")
    rec.record_tool("fly_to", "scene", {"longitude": 1}, False)
    get_trace_store().add(rec.finish())

    body = client.get("/traces").json()
    assert any(t["query"] == "test query" for t in body)
    tid = rec.trace.id
    one = client.get(f"/traces/{tid}")
    assert one.status_code == 200
    assert one.json()["tool_calls"][0]["name"] == "fly_to"
    assert client.get("/traces/doesnotexist").status_code == 404
