"""Request/response models for the Data Service API (ARCHITECTURE §4)."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

FilterOp = Literal["eq", "gt", "gte", "lt", "lte"]


class AttributeFilter(BaseModel):
    """A single attribute predicate, e.g. {"op": "gte", "value": 4.5}."""

    op: FilterOp
    value: float


class GeoQueryRequest(BaseModel):
    dataset: str
    # Spatial predicate: an optional bbox [west, south, east, north] ...
    bbox: tuple[float, float, float, float] | None = None
    # ... or a center + radius (km).
    center: tuple[float, float] | None = None  # [lng, lat]
    radius_km: float | None = None
    # Attribute predicates keyed by field name.
    filters: dict[str, AttributeFilter] = Field(default_factory=dict)
    limit: int = 5000


class GeoQueryResponse(BaseModel):
    dataset: str
    count: int
    # Flat records ({id, lng, lat, ...properties}) — ready for a deck.gl json source.
    features: list[dict[str, Any]]
    # True when the row cap truncated the result.
    truncated: bool = False


class SqlQueryRequest(BaseModel):
    sql: str
    limit: int = 5000


class SqlQueryResponse(BaseModel):
    columns: list[str]
    rows: list[dict[str, Any]]
    truncated: bool = False


class CatalogEntry(BaseModel):
    id: str
    title: str
    geometry_type: str
    fields: dict[str, str]  # field name -> type
    count: int | None = None


class Catalog(BaseModel):
    datasets: list[CatalogEntry]
