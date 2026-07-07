"""MCP client: connect to external MCP servers, discover their tools, and expose them
through the unified Tool Gateway with a namespace prefix (ARCHITECTURE §6.3).

`MCPConnection` is the boundary. `StaticMCPConnection` is a dependency-free test double.
`build_sdk_connection` documents the production path over the `mcp` SDK (lazy import;
not exercised offline).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol


class MCPConnection(Protocol):
    """A live connection to one MCP server."""

    name: str

    def list_tools(self) -> list[dict[str, Any]]: ...
    def call_tool(self, tool: str, args: dict[str, Any]) -> str: ...


@dataclass
class StaticMCPConnection:
    """Test/dev double: a fixed tool list and handlers, no transport."""

    name: str
    tools: list[dict[str, Any]]
    handlers: dict[str, Any]  # tool name -> callable(args) -> str

    def list_tools(self) -> list[dict[str, Any]]:
        return self.tools

    def call_tool(self, tool: str, args: dict[str, Any]) -> str:
        handler = self.handlers.get(tool)
        if handler is None:
            raise KeyError(f"MCP server '{self.name}' has no tool '{tool}'")
        return handler(args)


NAMESPACE_SEP = "__"


def namespaced(server: str, tool: str) -> str:
    return f"{server}{NAMESPACE_SEP}{tool}"


def split_namespaced(name: str) -> tuple[str, str] | None:
    if NAMESPACE_SEP not in name:
        return None
    server, tool = name.split(NAMESPACE_SEP, 1)
    return server, tool


def build_sdk_connection(name: str, url: str) -> MCPConnection:  # pragma: no cover
    """Production connection over the `mcp` SDK (Streamable HTTP). Lazy-imported so the
    offline test suite doesn't need the package or a running server."""
    from mcp.client.session import ClientSession  # type: ignore  # noqa: F401

    raise NotImplementedError(
        "Wire an mcp.ClientSession over the configured transport here, then adapt its "
        "list_tools()/call_tool() to the MCPConnection protocol."
    )
