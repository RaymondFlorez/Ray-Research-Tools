import pytest

from geoglobe_api.sql_guard import SqlNotAllowed, validate_read_only_sql


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT id, mag FROM earthquakes WHERE mag > 5",
        "  select * from earthquakes  ",
        "WITH recent AS (SELECT * FROM earthquakes) SELECT * FROM recent",
        "SELECT id FROM earthquakes;",  # trailing semicolon is stripped
    ],
)
def test_allows_read_only_selects(sql: str) -> None:
    assert validate_read_only_sql(sql)


@pytest.mark.parametrize(
    "sql",
    [
        "DELETE FROM earthquakes",
        "UPDATE earthquakes SET mag = 0",
        "DROP TABLE earthquakes",
        "SELECT 1; DROP TABLE earthquakes",
        "SELECT 1 -- comment",
        "SELECT 1 /* block */",
        "INSERT INTO earthquakes VALUES (1)",
        "",
    ],
)
def test_rejects_unsafe_sql(sql: str) -> None:
    with pytest.raises(SqlNotAllowed):
        validate_read_only_sql(sql)
