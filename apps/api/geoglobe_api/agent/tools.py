"""Tool definitions for the agent (ARCHITECTURE §6.2).

Two categories the model sees as one uniform list:
  - SCENE tools  → emit validated RFC 6902 patches to the client's Scene State.
  - DATA tools   → read the Data Service (catalog / geo query / SQL).

The JSON schemas here are the single source of truth for both the Anthropic tool
definitions and the golden-trace tests. RAG / action / MCP tools are appended by later
steps through the same registry.
"""

from __future__ import annotations

from typing import Any

SCENE_TOOLS: list[dict[str, Any]] = [
    {
        "name": "fly_to",
        "description": "Move the globe camera to a location. Use after adding/filtering "
        "layers so the user sees the relevant region.",
        "input_schema": {
            "type": "object",
            "properties": {
                "longitude": {"type": "number", "minimum": -180, "maximum": 180},
                "latitude": {"type": "number", "minimum": -90, "maximum": 90},
                "zoom": {"type": "number", "minimum": -2, "maximum": 24},
            },
            "required": ["longitude", "latitude"],
            "additionalProperties": False,
        },
    },
    {
        "name": "add_layer",
        "description": "Add a data layer to the globe backed by a Data Service dataset. "
        "The layer renders once its geo query resolves.",
        "input_schema": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "type": {"type": "string", "enum": ["scatterplot", "heatmap", "column", "geojson"]},
                "dataset": {"type": "string", "description": "A dataset id from get_catalog."},
                "filter": {
                    "type": "object",
                    "description": "Attribute predicates, e.g. {\"mag\": {\"gte\": 5}}.",
                },
                "color_field": {"type": "string"},
                "color_scale": {"type": "string", "enum": ["viridis", "plasma", "magma", "blues", "warm"]},
                "radius_field": {"type": "string"},
            },
            "required": ["id", "type", "dataset"],
            "additionalProperties": False,
        },
    },
    {
        "name": "update_layer",
        "description": "Change a layer's visibility or opacity.",
        "input_schema": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "visible": {"type": "boolean"},
                "opacity": {"type": "number", "minimum": 0, "maximum": 1},
            },
            "required": ["id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "remove_layer",
        "description": "Remove a layer from the globe by id.",
        "input_schema": {
            "type": "object",
            "properties": {"id": {"type": "string"}},
            "required": ["id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "set_time",
        "description": "Set the time cursor (ISO-8601) or window to filter time-aware layers.",
        "input_schema": {
            "type": "object",
            "properties": {
                "current": {"type": ["string", "null"]},
                "range": {"type": ["array", "null"], "items": {"type": "string"}},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "select_features",
        "description": "Select features on a layer by id (or clear selection with an empty list).",
        "input_schema": {
            "type": "object",
            "properties": {
                "layer_id": {"type": "string"},
                "feature_ids": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["layer_id", "feature_ids"],
            "additionalProperties": False,
        },
    },
]

DATA_TOOLS: list[dict[str, Any]] = [
    {
        "name": "get_catalog",
        "description": "List available datasets, their geometry type, and queryable fields.",
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "geo_query",
        "description": "Query a dataset by spatial predicate (bbox or center+radius) and "
        "attribute filters. Returns matching feature count and a sample.",
        "input_schema": {
            "type": "object",
            "properties": {
                "dataset": {"type": "string"},
                "bbox": {"type": "array", "items": {"type": "number"}, "minItems": 4, "maxItems": 4},
                "center": {"type": "array", "items": {"type": "number"}, "minItems": 2, "maxItems": 2},
                "radius_km": {"type": "number"},
                "filters": {"type": "object"},
                "limit": {"type": "integer"},
            },
            "required": ["dataset"],
            "additionalProperties": False,
        },
    },
]


def all_tools() -> list[dict[str, Any]]:
    return [*SCENE_TOOLS, *DATA_TOOLS]


SCENE_TOOL_NAMES = {t["name"] for t in SCENE_TOOLS}
DATA_TOOL_NAMES = {t["name"] for t in DATA_TOOLS}
