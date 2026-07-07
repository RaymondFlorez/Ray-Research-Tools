"""Tests for the RAG subsystem and the retrieve→pin agent flow."""

from geoglobe_api.agent.executor import ToolExecutor
from geoglobe_api.agent.llm import AssistantTurn, ScriptedLLMClient, ToolCall
from geoglobe_api.agent.orchestrator import Orchestrator
from geoglobe_api.rag import build_seeded_service
from geoglobe_api.rag.embed import HashingEmbedder
from geoglobe_api.repository import InMemoryRepository


def test_embedder_is_deterministic_and_normalized():
    emb = HashingEmbedder(dim=64)
    v1 = emb.embed("pacific ring of fire")
    v2 = emb.embed("pacific ring of fire")
    assert v1 == v2
    norm = sum(x * x for x in v1) ** 0.5
    assert abs(norm - 1.0) < 1e-9


def test_search_retrieves_relevant_document():
    svc = build_seeded_service()
    assert svc.count() >= 5
    hits = svc.search("subduction earthquakes around the pacific ocean rim", k=1)
    assert hits[0].doc_id == "ring-of-fire"
    # Hits carry coordinates so they can be pinned to the globe.
    assert hits[0].longitude == 160.0


def test_search_respects_geo_bbox():
    svc = build_seeded_service()
    # A bbox over California should surface the San Andreas doc, not Tokyo.
    hits = svc.search("earthquakes", bbox=(-130, 30, -110, 42), k=5)
    assert hits
    assert all(-130 <= h.longitude <= -110 for h in hits)
    assert any(h.doc_id == "san-andreas" for h in hits)


def test_agent_retrieves_then_pins_annotations():
    rag = build_seeded_service()
    hits = rag.search("pacific ring of fire", k=1)
    top = hits[0]

    turns = [
        AssistantTurn(
            text="Let me look that up.",
            tool_calls=[ToolCall(id="t1", name="rag_search", input={"query": "pacific ring of fire", "k": 1})],
            assistant_content=[],
            stop_reason="tool_use",
        ),
        AssistantTurn(
            text="Here's what I found.",
            tool_calls=[
                ToolCall(
                    id="t2",
                    name="add_annotations",
                    input={
                        "annotations": [
                            {"longitude": top.longitude, "latitude": top.latitude, "text": top.title}
                        ]
                    },
                )
            ],
            assistant_content=[],
            stop_reason="tool_use",
        ),
        AssistantTurn(text="Pinned.", tool_calls=[], assistant_content=[], stop_reason="end_turn"),
    ]

    orch = Orchestrator(
        llm=ScriptedLLMClient(turns=turns),
        executor=ToolExecutor(InMemoryRepository(), rag=rag),
        planner_model="p",
        fast_model="f",
        max_turns=6,
    )
    events = list(orch.run("what do you know about the Pacific Ring of Fire?"))

    # An annotations patch was emitted at the retrieved coordinates.
    patch_events = [e for e in events if e.type == "patch"]
    ann_ops = [op for e in patch_events for op in e.data["ops"] if op["path"] == "/annotations"]
    assert len(ann_ops) == 1
    pinned = ann_ops[0]["value"]
    assert pinned[0]["longitude"] == 160.0
    assert "Ring of Fire" in pinned[0]["text"]
    assert events[-1].type == "done"
