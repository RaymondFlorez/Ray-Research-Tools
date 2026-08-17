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

from ..tracing import TraceRecorder
from .gateway import ToolGateway
from .llm import AssistantTurn, LLMClient
from .patch_guard import PatchInvalid, validate_patch_ops

SYSTEM_PROMPT = """You are GeoGlobe's map agent. You help users explore geospatial data \
on a 3-D globe by calling tools.

- Use get_catalog / geo_query to discover and inspect datasets before visualizing them.
- Use rag_search for background knowledge and add_annotations to pin passages in place.
- Use geocode to turn a place name into coordinates, then fly_to it.
- Use add_layer to put data on the globe, set_time / update_layer to refine it.
- After acting, briefly tell the user what you did. Keep replies short."""


@dataclass
class AgentEvent:
    type: Literal["text", "tool_use", "patch", "tool_result", "usage", "done", "error"]
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

    def run(self, query: str, recorder: TraceRecorder | None = None) -> Iterator[AgentEvent]:
        messages: list[dict[str, Any]] = [{"role": "user", "content": query}]
        request_span = recorder.span("agent.request", query=query) if recorder else None

        for turn in range(self._max_turns):
            model = self._planner_model if turn == 0 else self._fast_model
            turn_span = recorder.span("agent.turn", turn=turn, model=model) if recorder else None
            assistant: AssistantTurn = self._llm.create(
                model=model, system=self._system, messages=messages, tools=self._tools
            )
            if recorder:
                recorder.record_usage(
                    model, assistant.usage.input_tokens, assistant.usage.output_tokens
                )

            if assistant.text:
                yield AgentEvent("text", {"text": assistant.text})

            messages.append({"role": "assistant", "content": assistant.assistant_content})

            if not assistant.tool_calls:
                if recorder and turn_span:
                    recorder.end(turn_span)
                break  # end_turn — the agent is done

            tool_results: list[dict[str, Any]] = []
            for call in assistant.tool_calls:
                yield AgentEvent("tool_use", {"name": call.name, "input": call.input})
                tool_span = recorder.span("tool", tool=call.name) if recorder else None
                result = self._gateway.invoke(call.name, call.input)
                outcome = result.outcome
                if recorder:
                    recorder.record_tool(call.name, result.category, call.input, outcome.is_error)
                    if tool_span:
                        recorder.end(tool_span)

                if outcome.patches:
                    try:
                        # Reject malformed patches server-side (defense in depth; the
                        # client re-validates against the full Scene State schema).
                        validate_patch_ops(outcome.patches)
                        if recorder:
                            recorder.record_patch(outcome.patches)
                        yield AgentEvent("patch", {"ops": outcome.patches})
                    except PatchInvalid as exc:
                        outcome.result = f"{outcome.result} (patch rejected: {exc})"
                        outcome.is_error = True

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
            if recorder and turn_span:
                recorder.end(turn_span)

        if recorder:
            if request_span:
                recorder.end(request_span)
            t = recorder.trace
            yield AgentEvent(
                "usage",
                {
                    "input_tokens": t.input_tokens,
                    "output_tokens": t.output_tokens,
                    "cost_usd": round(t.cost_usd, 6),
                    "trace_id": t.id,
                },
            )
        yield AgentEvent("done", {})
