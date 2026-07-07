"""The plan → act → observe agent loop (ARCHITECTURE §6.1).

Given a natural-language query, the agent calls DATA tools to look things up and SCENE
tools to mutate the globe, looping until it has no more tool calls. It yields a stream
of typed events (assistant text, tool calls, scene patches, done) that the WebSocket
endpoint forwards to the client — and that a golden-trace test asserts on.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any, Literal

from .executor import ToolExecutor
from .llm import AssistantTurn, LLMClient
from .tools import SCENE_TOOL_NAMES, all_tools

SYSTEM_PROMPT = """You are GeoGlobe's map agent. You help users explore geospatial data \
on a 3-D globe by calling tools.

- Use get_catalog / geo_query to discover and inspect datasets before visualizing them.
- Use add_layer to put data on the globe, set_time / update_layer to refine it, and \
fly_to to move the camera to the region of interest.
- Prefer a single add_layer with an appropriate filter over fetching raw rows yourself.
- After acting, briefly tell the user what you did. Keep replies short."""


@dataclass
class AgentEvent:
    type: Literal["text", "tool_use", "patch", "tool_result", "done", "error"]
    # text: {text}; tool_use: {name, input}; patch: {ops}; tool_result: {name, result};
    # done: {}; error: {message}
    data: dict[str, Any]


class Orchestrator:
    def __init__(
        self,
        llm: LLMClient,
        executor: ToolExecutor,
        planner_model: str,
        fast_model: str,
        max_turns: int = 12,
    ) -> None:
        self._llm = llm
        self._executor = executor
        self._planner_model = planner_model
        self._fast_model = fast_model
        self._max_turns = max_turns
        self._tools = all_tools()
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
                outcome = self._executor.execute(call.name, call.input)

                if outcome.patches:
                    yield AgentEvent("patch", {"ops": outcome.patches})
                if call.name in SCENE_TOOL_NAMES or outcome.is_error:
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
