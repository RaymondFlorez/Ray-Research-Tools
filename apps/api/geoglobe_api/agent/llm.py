"""LLM client boundary.

The orchestrator depends on the `LLMClient` protocol, never on the Anthropic SDK
directly, so the plan-act-observe loop is testable with a scripted client (no API key,
no network). `AnthropicLLMClient` is the production implementation.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass
class ToolCall:
    id: str
    name: str
    input: dict[str, Any]


@dataclass
class AssistantTurn:
    """One assistant response: text, any tool calls, and the raw content blocks to
    append to the running message history for the next turn."""

    text: str
    tool_calls: list[ToolCall]
    assistant_content: list[dict[str, Any]]
    stop_reason: str = "end_turn"


class LLMClient(Protocol):
    def create(
        self,
        model: str,
        system: list[dict[str, Any]],
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
    ) -> AssistantTurn: ...


class AnthropicLLMClient:
    """Production client. Uses adaptive thinking and prompt-caches the stable prefix
    (system + tool definitions) per ARCHITECTURE §6.1. Constructed lazily so importing
    this module never requires the anthropic package (tests inject a fake client)."""

    def __init__(self, api_key: str | None = None, max_tokens: int = 4096) -> None:
        from anthropic import Anthropic  # imported here so tests don't need the SDK

        self._client = Anthropic(api_key=api_key) if api_key else Anthropic()
        self._max_tokens = max_tokens

    def create(
        self,
        model: str,
        system: list[dict[str, Any]],
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
    ) -> AssistantTurn:
        # Cache the (stable) tool list and system prompt so multi-turn loops are cheap.
        cached_tools = [dict(t) for t in tools]
        if cached_tools:
            cached_tools[-1] = {**cached_tools[-1], "cache_control": {"type": "ephemeral"}}
        cached_system = [dict(b) for b in system]
        if cached_system:
            cached_system[-1] = {**cached_system[-1], "cache_control": {"type": "ephemeral"}}

        response = self._client.messages.create(
            model=model,
            max_tokens=self._max_tokens,
            thinking={"type": "adaptive"},
            system=cached_system,
            tools=cached_tools,
            messages=messages,
        )

        text_parts: list[str] = []
        tool_calls: list[ToolCall] = []
        assistant_content: list[dict[str, Any]] = []
        for block in response.content:
            data = block.model_dump()
            assistant_content.append(data)
            if block.type == "text":
                text_parts.append(block.text)
            elif block.type == "tool_use":
                tool_calls.append(ToolCall(id=block.id, name=block.name, input=dict(block.input)))

        return AssistantTurn(
            text="".join(text_parts),
            tool_calls=tool_calls,
            assistant_content=assistant_content,
            stop_reason=response.stop_reason or "end_turn",
        )


@dataclass
class ScriptedLLMClient:
    """Test double: returns a preset sequence of AssistantTurns, ignoring inputs."""

    turns: list[AssistantTurn]
    calls: list[dict[str, Any]] = field(default_factory=list)

    def create(
        self,
        model: str,
        system: list[dict[str, Any]],
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
    ) -> AssistantTurn:
        self.calls.append({"model": model, "messages": messages})
        return self.turns[len(self.calls) - 1]
