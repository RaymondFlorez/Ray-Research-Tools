"""Golden-trace test for the agent loop.

Scripts the LLM to reproduce the canonical query
  "show me earthquakes over magnitude 5 in the Pacific and fly there"
and asserts the orchestrator emits the right DATA lookups, scene patches, and finishes —
all deterministically, with no Anthropic API key or network.
"""

from geoglobe_api.agent.executor import ToolExecutor
from geoglobe_api.agent.llm import AssistantTurn, ScriptedLLMClient, ToolCall
from geoglobe_api.agent.orchestrator import Orchestrator
from geoglobe_api.repository import InMemoryRepository


def _run(turns):
    orch = Orchestrator(
        llm=ScriptedLLMClient(turns=turns),
        executor=ToolExecutor(InMemoryRepository()),
        planner_model="planner",
        fast_model="fast",
        max_turns=6,
    )
    return list(orch.run("show me earthquakes over magnitude 5 in the Pacific and fly there"))


def test_golden_trace_earthquakes_pacific():
    turns = [
        # Turn 1: look up the dataset, add a filtered layer, and fly to the Pacific.
        AssistantTurn(
            text="Let me pull up earthquakes over magnitude 5 in the Pacific.",
            tool_calls=[
                ToolCall(id="t1", name="get_catalog", input={}),
                ToolCall(
                    id="t2",
                    name="add_layer",
                    input={
                        "id": "quakes",
                        "type": "scatterplot",
                        "dataset": "earthquakes",
                        "filter": {"mag": {"gte": 5}},
                        "color_field": "depth",
                        "color_scale": "magma",
                        "radius_field": "mag",
                    },
                ),
                ToolCall(id="t3", name="fly_to", input={"longitude": 160, "latitude": 0, "zoom": 2}),
            ],
            assistant_content=[{"type": "text", "text": "..."}],
            stop_reason="tool_use",
        ),
        # Turn 2: wrap up.
        AssistantTurn(
            text="Done — earthquakes above magnitude 5 are shown over the Pacific.",
            tool_calls=[],
            assistant_content=[{"type": "text", "text": "Done"}],
            stop_reason="end_turn",
        ),
    ]

    events = _run(turns)
    kinds = [e.type for e in events]

    # The loop ran two turns and finished.
    assert kinds[0] == "text"
    assert kinds[-1] == "done"

    # It emitted an add_layer patch adding the earthquakes layer via a geo-query source.
    patch_events = [e for e in events if e.type == "patch"]
    add_ops = [op for e in patch_events for op in e.data["ops"] if op["path"] == "/layers/-"]
    assert len(add_ops) == 1
    layer = add_ops[0]["value"]
    assert layer["id"] == "quakes"
    assert layer["source"] == {
        "kind": "geo-query",
        "dataset": "earthquakes",
        "filter": {"mag": {"gte": 5}},
    }
    assert layer["encoding"]["color"] == {"field": "depth", "scale": "magma"}

    # And a fly_to patch replacing the viewport toward the Pacific.
    viewport_ops = [op for e in patch_events for op in e.data["ops"] if op["path"] == "/viewport"]
    assert len(viewport_ops) == 1
    assert viewport_ops[0]["value"]["longitude"] == 160

    # The planner model handled turn 1; the fast model handled turn 2.
    assert orchestrator_models(turns) == ["planner", "fast"]


def orchestrator_models(turns):
    client = ScriptedLLMClient(turns=turns)
    orch = Orchestrator(
        llm=client,
        executor=ToolExecutor(InMemoryRepository()),
        planner_model="planner",
        fast_model="fast",
        max_turns=6,
    )
    list(orch.run("q"))
    return [c["model"] for c in client.calls]


def test_data_tool_result_fed_back():
    # A single get_catalog call then finish — the catalog text must reach the model.
    turns = [
        AssistantTurn(
            text="",
            tool_calls=[ToolCall(id="t1", name="get_catalog", input={})],
            assistant_content=[],
            stop_reason="tool_use",
        ),
        AssistantTurn(text="ok", tool_calls=[], assistant_content=[], stop_reason="end_turn"),
    ]
    client = ScriptedLLMClient(turns=turns)
    orch = Orchestrator(
        llm=client,
        executor=ToolExecutor(InMemoryRepository()),
        planner_model="p",
        fast_model="f",
        max_turns=4,
    )
    list(orch.run("what data do you have?"))
    # Second call's messages must include the tool_result carrying the catalog.
    second_turn_messages = client.calls[1]["messages"]
    tool_results = [
        c
        for m in second_turn_messages
        if isinstance(m["content"], list)
        for c in m["content"]
        if isinstance(c, dict) and c.get("type") == "tool_result"
    ]
    assert any("earthquakes" in tr["content"] for tr in tool_results)
