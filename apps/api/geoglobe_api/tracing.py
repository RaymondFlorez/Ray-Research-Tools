"""Observability (ARCHITECTURE §8, Step 10): replayable traces + span tree + token/cost.

Every NL query records a `Trace`: the ordered tool calls (name, category, error), the
scene patches emitted, flat spans spanning request → agent turns → tools, and
accumulated token usage with a cost estimate. Traces live in a bounded in-memory ring
(swap for a durable store in production) and are exposed via GET /traces. An
OpenTelemetry exporter can be attached to `Span` without changing callers.
"""

from __future__ import annotations

import time
import uuid
from collections import deque
from dataclasses import asdict, dataclass, field
from typing import Any

# Per-model USD price per 1M tokens (input, output). Source: model catalog.
_PRICES: dict[str, tuple[float, float]] = {
    "claude-opus-4-8": (5.0, 25.0),
    "claude-sonnet-4-6": (3.0, 15.0),
    "claude-haiku-4-5": (1.0, 5.0),
}


def estimate_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    inp, out = _PRICES.get(model, (0.0, 0.0))
    return (input_tokens / 1e6) * inp + (output_tokens / 1e6) * out


@dataclass
class Span:
    name: str
    start: float
    end: float | None = None
    attributes: dict[str, Any] = field(default_factory=dict)


@dataclass
class ToolCallRecord:
    name: str
    category: str
    input: dict[str, Any]
    is_error: bool


@dataclass
class Trace:
    id: str
    query: str
    started_at: float
    tool_calls: list[ToolCallRecord] = field(default_factory=list)
    patches: list[dict[str, Any]] = field(default_factory=list)
    spans: list[Span] = field(default_factory=list)
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0
    finished_at: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            **asdict(self),
            "duration_ms": None
            if self.finished_at is None
            else (self.finished_at - self.started_at) * 1000,
        }


class TraceRecorder:
    """Accumulates one Trace as the agent runs."""

    def __init__(self, query: str) -> None:
        self.trace = Trace(id=uuid.uuid4().hex[:12], query=query, started_at=time.time())

    def span(self, name: str, **attributes: Any) -> Span:
        s = Span(name=name, start=time.time(), attributes=dict(attributes))
        self.trace.spans.append(s)
        return s

    @staticmethod
    def end(span: Span) -> None:
        span.end = time.time()

    def record_tool(self, name: str, category: str, args: dict[str, Any], is_error: bool) -> None:
        self.trace.tool_calls.append(ToolCallRecord(name, category, args, is_error))

    def record_patch(self, ops: list[dict[str, Any]]) -> None:
        self.trace.patches.extend(ops)

    def record_usage(self, model: str, input_tokens: int, output_tokens: int) -> None:
        self.trace.input_tokens += input_tokens
        self.trace.output_tokens += output_tokens
        self.trace.cost_usd += estimate_cost(model, input_tokens, output_tokens)

    def finish(self) -> Trace:
        self.trace.finished_at = time.time()
        return self.trace


class TraceStore:
    """Bounded in-memory ring of recent traces."""

    def __init__(self, capacity: int = 200) -> None:
        self._traces: deque[Trace] = deque(maxlen=capacity)

    def add(self, trace: Trace) -> None:
        self._traces.append(trace)

    def list(self) -> list[Trace]:
        return list(reversed(self._traces))

    def get(self, trace_id: str) -> Trace | None:
        return next((t for t in self._traces if t.id == trace_id), None)
