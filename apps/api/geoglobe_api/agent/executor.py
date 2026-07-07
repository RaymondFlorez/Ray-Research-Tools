"""Executes tool calls: SCENE tools → JSON Patches; DATA tools → repository reads.

Every SCENE tool returns RFC 6902 operations that the client applies to its Scene State
through the same validated `applyScenePatch` chokepoint the UI uses — so the agent can
only produce well-formed scene mutations, never arbitrary client code (ARCHITECTURE §6.4).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..models import AttributeFilter, GeoQueryRequest
from ..repository import DataRepository, UnsupportedOperation
from .tools import DATA_TOOL_NAMES, SCENE_TOOL_NAMES


@dataclass
class ToolOutcome:
    """Result of executing one tool call."""

    # Text summary fed back to the model as the tool_result.
    result: str
    # RFC 6902 patch operations to apply to the client's Scene State (SCENE tools).
    patches: list[dict[str, Any]] = field(default_factory=list)
    is_error: bool = False


class ToolExecutor:
    def __init__(self, repo: DataRepository) -> None:
        self._repo = repo

    def execute(self, name: str, args: dict[str, Any]) -> ToolOutcome:
        try:
            if name in SCENE_TOOL_NAMES:
                return self._scene(name, args)
            if name in DATA_TOOL_NAMES:
                return self._data(name, args)
            return ToolOutcome(result=f"Unknown tool '{name}'", is_error=True)
        except Exception as exc:  # surface tool errors to the model, don't crash the loop
            return ToolOutcome(result=f"Tool '{name}' failed: {exc}", is_error=True)

    # ---- SCENE tools -----------------------------------------------------------------

    def _scene(self, name: str, args: dict[str, Any]) -> ToolOutcome:
        if name == "fly_to":
            vp: dict[str, Any] = {
                "longitude": args["longitude"],
                "latitude": args["latitude"],
                "zoom": args.get("zoom", 3),
                "pitch": 0,
                "bearing": 0,
            }
            return ToolOutcome(
                result=f"Camera moved to {vp['longitude']:.1f}, {vp['latitude']:.1f}.",
                patches=[{"op": "replace", "path": "/viewport", "value": vp}],
            )

        if name == "add_layer":
            layer = self._build_layer(args)
            return ToolOutcome(
                result=f"Added layer '{layer['id']}' from dataset '{args['dataset']}'.",
                patches=[{"op": "add", "path": "/layers/-", "value": layer}],
            )

        if name == "update_layer":
            # Per-field replace ops (the client resolves `~id` → array index). Whole-layer
            # replacement would drop required fields, so patch fields individually.
            ops = [
                {"op": "replace", "path": f"/layers/~{args['id']}/{key}", "value": value}
                for key, value in args.items()
                if key != "id"
            ]
            return ToolOutcome(result=f"Updated layer '{args['id']}'.", patches=ops)

        if name == "remove_layer":
            return ToolOutcome(
                result=f"Removed layer '{args['id']}'.",
                patches=[{"op": "remove", "path": f"/layers/~{args['id']}"}],
            )

        if name == "set_time":
            time_val = {"current": args.get("current"), "range": args.get("range")}
            return ToolOutcome(
                result="Time window updated.",
                patches=[{"op": "replace", "path": "/time", "value": time_val}],
            )

        if name == "select_features":
            sel = None if not args["feature_ids"] else {
                "layerId": args["layer_id"],
                "featureIds": args["feature_ids"],
            }
            return ToolOutcome(
                result=f"Selected {len(args['feature_ids'])} feature(s).",
                patches=[{"op": "replace", "path": "/selection", "value": sel}],
            )

        return ToolOutcome(result=f"Unhandled scene tool '{name}'", is_error=True)

    @staticmethod
    def _build_layer(args: dict[str, Any]) -> dict[str, Any]:
        encoding: dict[str, Any] = {"position": ["lng", "lat"]}
        if args.get("color_field"):
            encoding["color"] = {
                "field": args["color_field"],
                "scale": args.get("color_scale", "viridis"),
            }
        if args.get("radius_field"):
            encoding["radius"] = args["radius_field"]
            encoding["radiusScale"] = 1.6
            encoding["radiusMinPixels"] = 2
            encoding["radiusMaxPixels"] = 16
        return {
            "id": args["id"],
            "type": args["type"],
            "source": {"kind": "geo-query", "dataset": args["dataset"], "filter": args.get("filter", {})},
            "encoding": encoding,
            "visible": True,
            "opacity": 0.9,
        }

    # ---- DATA tools ------------------------------------------------------------------

    def _data(self, name: str, args: dict[str, Any]) -> ToolOutcome:
        if name == "get_catalog":
            entries = self._repo.catalog()
            lines = [
                f"- {e.id}: {e.title} ({e.geometry_type}); fields: {', '.join(e.fields)}"
                for e in entries
            ]
            return ToolOutcome(result="Datasets:\n" + "\n".join(lines))

        if name == "geo_query":
            req = self._to_geo_request(args)
            try:
                resp = self._repo.query_geo(req)
            except KeyError as exc:
                return ToolOutcome(result=str(exc), is_error=True)
            sample = resp.features[:3]
            return ToolOutcome(
                result=f"{resp.count} features in '{req.dataset}'"
                + (" (truncated)" if resp.truncated else "")
                + f". Sample: {sample}"
            )

        return ToolOutcome(result=f"Unhandled data tool '{name}'", is_error=True)

    @staticmethod
    def _to_geo_request(args: dict[str, Any]) -> GeoQueryRequest:
        filters: dict[str, AttributeFilter] = {}
        for field_name, pred in (args.get("filters") or {}).items():
            if isinstance(pred, dict):
                op, value = next(iter(pred.items()))
                filters[field_name] = AttributeFilter(op=op, value=float(value))
        return GeoQueryRequest(
            dataset=args["dataset"],
            bbox=tuple(args["bbox"]) if args.get("bbox") else None,
            center=tuple(args["center"]) if args.get("center") else None,
            radius_km=args.get("radius_km"),
            filters=filters,
            limit=args.get("limit", 5000),
        )
