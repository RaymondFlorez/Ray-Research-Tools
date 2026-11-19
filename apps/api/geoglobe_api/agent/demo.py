"""Deterministic, key-free LLM for smoke tests and offline demos (GEOGLOBE_AGENT_LLM=demo).

It ignores the query and always plays the canonical script — look up the catalog, add a
filtered earthquake layer, fly to the Pacific, summarize — so a deployed stack can be
exercised end to end (WebSocket → orchestrator → tool gateway → repository → patches)
without an Anthropic API key. It is stateless: the turn is chosen from how many
assistant turns the conversation already has, so one instance serves any number of
queries and connections.
"""

from __future__ import annotations

from typing import Any

from .llm import AssistantTurn, ToolCall, Usage

_TOOL_TURN = AssistantTurn(
    text="Pulling up earthquakes of magnitude 5+ around the Pacific.",
    tool_calls=[
        ToolCall(id="demo-1", name="get_catalog", input={}),
        ToolCall(
            id="demo-2",
            name="add_layer",
            input={
                "id": "demo-quakes",
                "type": "scatterplot",
                "dataset": "earthquakes",
                "filter": {"mag": {"gte": 5}},
                "color_field": "depth",
                "color_scale": "magma",
                "radius_field": "mag",
            },
        ),
        ToolCall(id="demo-3", name="fly_to", input={"longitude": 160, "latitude": 0, "zoom": 1.6}),
    ],
    assistant_content=[{"type": "text", "text": "Pulling up earthquakes."}],
    stop_reason="tool_use",
    usage=Usage(input_tokens=0, output_tokens=0),
)

_FINAL_TURN = AssistantTurn(
    text="Done — magnitude 5+ earthquakes are on the globe, centred on the Pacific. (demo LLM)",
    tool_calls=[],
    assistant_content=[{"type": "text", "text": "Done."}],
    stop_reason="end_turn",
    usage=Usage(input_tokens=0, output_tokens=0),
)


class DemoLLMClient:
    def create(
        self,
        model: str,
        system: list[dict[str, Any]],
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
    ) -> AssistantTurn:
        # Count assistant turns since the most recent plain-text user query.
        turns_so_far = 0
        for msg in reversed(messages):
            if msg.get("role") == "user" and isinstance(msg.get("content"), str):
                break
            if msg.get("role") == "assistant":
                turns_so_far += 1
        return _TOOL_TURN if turns_so_far == 0 else _FINAL_TURN
