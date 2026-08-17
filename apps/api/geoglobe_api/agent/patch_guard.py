"""Server-side JSON Patch validation (defense in depth, ARCHITECTURE §6.4).

The client re-validates every patch against the Scene State schema before applying it;
this guard rejects structurally malformed ops server-side so the agent can never even
emit a bad patch onto the wire.
"""

from __future__ import annotations

from typing import Any

_VALID_OPS = {"add", "remove", "replace", "move", "copy", "test"}


class PatchInvalid(ValueError):
    pass


def validate_patch_ops(ops: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not isinstance(ops, list):
        raise PatchInvalid("patch must be a list of operations")
    for op in ops:
        if not isinstance(op, dict):
            raise PatchInvalid("each operation must be an object")
        name = op.get("op")
        if name not in _VALID_OPS:
            raise PatchInvalid(f"invalid op '{name}'")
        path = op.get("path")
        if not isinstance(path, str) or not path.startswith("/"):
            raise PatchInvalid("op is missing a valid JSON Pointer path")
        if name in ("add", "replace", "test") and "value" not in op:
            raise PatchInvalid(f"op '{name}' requires a value")
        if name in ("move", "copy") and "from" not in op:
            raise PatchInvalid(f"op '{name}' requires a 'from'")
    return ops
