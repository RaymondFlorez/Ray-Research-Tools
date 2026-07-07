"""The plan → act → observe agent loop (ARCHITECTURE §6.1).

Given a natural-language query, the agent calls tools (scene / data / rag / action / mcp)
through the unified Tool Gateway, looping until it has no more tool calls. It yields a
stream of typed events (assistant text, tool calls, scene patches, done) that the
WebSocket endpoint forwards to the client — and that golden-trace tests assert on.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any, Literal

from .gateway import ToolGateway
from .llm import AssistantTurn, LLMClient

SYSTEM_PROMPT = """You are GeoGlobe's map agent. You help users explore geospatial data \
on a 3-D globe by calling tools.

- Use get_catalog / geo_query to discover and inspect datasets before visualizing them.
- Use rag_search for background knowledge and add_annotations to pin passages in place.
- Use geocode to turn a place name into coordinates, then fly_to it.
- Use add_layer to put data on the globe, set_time / update_layer to refine it.
- After acting, briefly tell the user what you did. Keep replies short."""


@dataclass
class AgentEvent:
    type: Literal["text", "tool_use", "patch", "tool_result", "done", "error"]
    data: dict[str, Any]


class Orchestrator:
    def __init__(
        self,
        llm: LLMClient,
        gateway: ToolGateway,
        planner_model: str,
        fast_model: str,
        max_turns: int = 12,
    ) -> None:
        self._llm = llm
        self._gateway = gateway
        self._planner_model = planner_model
        self._fast_model = fast_model
        self._max_turns = max_turns
        self._tools = gateway.definitions()
        self._system = [{"type": "text", "text": SYSTEM_PROMPT}]

    def run(self, query: str) -> Iterator[AgentEvent]:
        messages: list[dict[str, Any]] = [{"role": "user", "content": query}]

        for turn in range(self._max_turns):
            model = self._planner_model if turn == 0 else self._fast_model
            assistant: AssistantTurn = self._llm.create(
                model=model, system=self._system, messages=messages, tools=self._tools
            )

            if assistant.text:
                yield AgentEvent("text", {"text": assistant.text})

            messages.append({"role": "assistant", "content": assistant.assistant_content})

            if not assistant.tool_calls:
                break  # end_turn — the agent is done

            tool_results: list[dict[str, Any]] = []
            for call in assistant.tool_calls:
                yield AgentEvent("tool_use", {"name": call.name, "input": call.input})
                result = self._gateway.invoke(call.name, call.input)
                outcome = result.outcome

                if outcome.patches:
                    yield AgentEvent("patch", {"ops": outcome.patches})
                if result.category == "scene" or outcome.is_error:
                    yield AgentEvent("tool_result", {"name": call.name, "result": outcome.result})

                tool_results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": call.id,
                        "content": outcome.result,
                        "is_error": outcome.is_error,
                    }
                )

            messages.append({"role": "user", "content": tool_results})

        yield AgentEvent("done", {})
