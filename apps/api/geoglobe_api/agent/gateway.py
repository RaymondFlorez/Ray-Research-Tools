"""Unified Tool Gateway (ARCHITECTURE §6.3).

Every tool category — scene, data, rag, action, mcp — is registered here and presented
to the model as one uniform list. The gateway enforces per-tool auth scopes and rate
limits, applies output transformers (truncation), and namespaces MCP tools, so the
orchestrator treats an internal tool and a remote MCP tool identically.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from functools import partial
from typing import Any

from ..rag import RagService
from ..repository import DataRepository
from .action import ACTION_TOOLS, ActionConfig, ActionNotAllowed, geocode, web_fetch
from .executor import ToolExecutor, ToolOutcome
from .mcp import MCPConnection, namespaced
from .tools import DATA_TOOLS, RAG_TOOLS, SCENE_TOOLS

MAX_RESULT_CHARS = 6000

Category = str  # 'scene' | 'data' | 'rag' | 'action' | 'mcp'


@dataclass
class RegisteredTool:
    name: str
    definition: dict[str, Any]
    category: Category
    scopes: set[str]
    handler: Callable[[dict[str, Any]], ToolOutcome]
    rate_limit: int | None = None


@dataclass
class InvokeResult:
    outcome: ToolOutcome
    category: Category


class ToolGateway:
    def __init__(self, granted_scopes: set[str] | None = None) -> None:
        # None → unrestricted (dev). Step 10 passes a real scope set from the JWT.
        self._granted = granted_scopes
        self._tools: dict[str, RegisteredTool] = {}
        self._calls: dict[str, int] = {}

    def register(self, tool: RegisteredTool) -> None:
        self._tools[tool.name] = tool

    def definitions(self) -> list[dict[str, Any]]:
        return [t.definition for t in self._tools.values()]

    def category_of(self, name: str) -> Category:
        tool = self._tools.get(name)
        return tool.category if tool else "unknown"

    def invoke(self, name: str, args: dict[str, Any]) -> InvokeResult:
        tool = self._tools.get(name)
        if tool is None:
            return InvokeResult(ToolOutcome(result=f"Unknown tool '{name}'", is_error=True), "unknown")

        if self._granted is not None and not tool.scopes.issubset(self._granted):
            missing = tool.scopes - self._granted
            return InvokeResult(
                ToolOutcome(result=f"Not authorized (missing scope: {', '.join(missing)})", is_error=True),
                tool.category,
            )

        self._calls[name] = self._calls.get(name, 0) + 1
        if tool.rate_limit is not None and self._calls[name] > tool.rate_limit:
            return InvokeResult(
                ToolOutcome(result=f"Rate limit exceeded for '{name}'", is_error=True), tool.category
            )

        outcome = tool.handler(args)
        outcome = _transform(outcome)
        return InvokeResult(outcome, tool.category)


def _transform(outcome: ToolOutcome) -> ToolOutcome:
    """Output transformer: truncate oversized tool results before they hit the context."""
    if len(outcome.result) > MAX_RESULT_CHARS:
        outcome.result = outcome.result[:MAX_RESULT_CHARS] + "\n…(truncated)"
    return outcome


def _action_handler(name: str, config: ActionConfig) -> Callable[[dict[str, Any]], ToolOutcome]:
    def handler(args: dict[str, Any]) -> ToolOutcome:
        try:
            if name == "geocode":
                lng, lat = geocode(args["place"])
                return ToolOutcome(result=f"{args['place']} → [{lng}, {lat}]")
            if name == "web_fetch":
                text = web_fetch(args["url"], config)
                return ToolOutcome(result=text)
        except ActionNotAllowed as exc:
            return ToolOutcome(result=str(exc), is_error=True)
        except Exception as exc:  # network/other failure
            return ToolOutcome(result=f"web_fetch failed: {exc}", is_error=True)
        return ToolOutcome(result=f"Unknown action '{name}'", is_error=True)

    return handler


def build_gateway(
    repo: DataRepository,
    rag: RagService | None = None,
    mcp_connections: list[MCPConnection] | None = None,
    action_config: ActionConfig | None = None,
    granted_scopes: set[str] | None = None,
) -> ToolGateway:
    executor = ToolExecutor(repo, rag)
    config = action_config or ActionConfig()
    gateway = ToolGateway(granted_scopes)

    for defn in SCENE_TOOLS:
        gateway.register(
            RegisteredTool(defn["name"], defn, "scene", {"scene"}, partial(executor.execute, defn["name"]))
        )
    for defn in DATA_TOOLS:
        gateway.register(
            RegisteredTool(defn["name"], defn, "data", {"data"}, partial(executor.execute, defn["name"]))
        )
    if rag is not None:
        for defn in RAG_TOOLS:
            gateway.register(
                RegisteredTool(defn["name"], defn, "rag", {"rag"}, partial(executor.execute, defn["name"]))
            )
    for defn in ACTION_TOOLS:
        gateway.register(
            RegisteredTool(
                defn["name"], defn, "action", {"action"}, _action_handler(defn["name"], config), rate_limit=20
            )
        )

    for conn in mcp_connections or []:
        for tool_def in conn.list_tools():
            full = namespaced(conn.name, tool_def["name"])
            definition = {
                "name": full,
                "description": tool_def.get("description", f"{conn.name} tool"),
                "input_schema": tool_def.get("input_schema") or tool_def.get("inputSchema") or {"type": "object"},
            }
            gateway.register(
                RegisteredTool(
                    full,
                    definition,
                    "mcp",
                    {"mcp", f"mcp:{conn.name}"},
                    _mcp_handler(conn, tool_def["name"]),
                    rate_limit=30,
                )
            )

    return gateway


def _mcp_handler(conn: MCPConnection, tool: str) -> Callable[[dict[str, Any]], ToolOutcome]:
    def handler(args: dict[str, Any]) -> ToolOutcome:
        try:
            return ToolOutcome(result=conn.call_tool(tool, args))
        except Exception as exc:
            return ToolOutcome(result=f"MCP tool '{tool}' failed: {exc}", is_error=True)

    return handler
