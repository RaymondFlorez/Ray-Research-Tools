"""Pure XYZ tile math (Web Mercator), used by the MVT tile endpoint."""

from __future__ import annotations

import math


class InvalidTile(ValueError):
    pass


def validate_tile(z: int, x: int, y: int) -> None:
    if z < 0 or z > 24:
        raise InvalidTile(f"zoom {z} out of range [0, 24]")
    n = 1 << z
    if not (0 <= x < n and 0 <= y < n):
        raise InvalidTile(f"tile x/y out of range for zoom {z}")


def tile_to_bbox(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    """Return (west, south, east, north) in degrees for an XYZ tile."""
    validate_tile(z, x, y)
    n = 1 << z

    def lng(xt: int) -> float:
        return xt / n * 360.0 - 180.0

    def lat(yt: int) -> float:
        return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * yt / n))))

    west, east = lng(x), lng(x + 1)
    north, south = lat(y), lat(y + 1)
    return (west, south, east, north)
