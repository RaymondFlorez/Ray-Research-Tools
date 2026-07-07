import pytest

from geoglobe_api.tiles import InvalidTile, tile_to_bbox, validate_tile


def test_tile_zero_covers_world() -> None:
    west, south, east, north = tile_to_bbox(0, 0, 0)
    assert west == pytest.approx(-180)
    assert east == pytest.approx(180)
    assert north == pytest.approx(85.0511, abs=1e-3)
    assert south == pytest.approx(-85.0511, abs=1e-3)


def test_tile_quadrant() -> None:
    # z=1, x=0, y=0 is the north-west quadrant.
    west, south, east, north = tile_to_bbox(1, 0, 0)
    assert west == pytest.approx(-180)
    assert east == pytest.approx(0)
    assert north == pytest.approx(85.0511, abs=1e-3)
    assert south == pytest.approx(0, abs=1e-6)


def test_invalid_tiles() -> None:
    with pytest.raises(InvalidTile):
        validate_tile(1, 2, 0)
    with pytest.raises(InvalidTile):
        validate_tile(30, 0, 0)
