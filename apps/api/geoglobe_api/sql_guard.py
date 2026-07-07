"""Read-only SQL guard for POST /query/sql.

A defense-in-depth check that runs *before* the query reaches the database (which is
itself connected via a read-only role with a statement timeout). Pure and unit-tested.
"""

from __future__ import annotations

import re

_FORBIDDEN = re.compile(
    r"\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|merge|"
    r"vacuum|call|do|comment|reindex|refresh|listen|notify)\b",
    re.IGNORECASE,
)


class SqlNotAllowed(ValueError):
    """Raised when a SQL string is not a safe, read-only single statement."""


def validate_read_only_sql(sql: str) -> str:
    """Return a normalized query if it is a single read-only statement, else raise.

    Rules: exactly one statement (no stray semicolons), must begin with SELECT or WITH,
    no DML/DDL keywords, no comment markers (which can smuggle payloads past parsers).
    """
    stripped = sql.strip().rstrip(";").strip()
    if not stripped:
        raise SqlNotAllowed("empty query")
    if ";" in stripped:
        raise SqlNotAllowed("multiple statements are not allowed")
    if "--" in stripped or "/*" in stripped:
        raise SqlNotAllowed("comments are not allowed")

    head = stripped.split(None, 1)[0].lower()
    if head not in ("select", "with"):
        raise SqlNotAllowed("only SELECT/WITH queries are allowed")
    if _FORBIDDEN.search(stripped):
        raise SqlNotAllowed("statement contains a forbidden keyword")
    return stripped
