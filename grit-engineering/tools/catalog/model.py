"""Data model for the GRIT implementation prompt catalog.

Each prompt is declared once with `prompt(...)`. `tools/build.py` validates the catalog
and renders manifests, prompt files and diagrams from it. Nothing else is hand-maintained.
"""

from __future__ import annotations

from dataclasses import dataclass, field

GROUPS: dict[str, tuple[str, str]] = {
    # group letter: (name, folder)
    "A": ("Architecture and repository foundations", "00-foundations"),
    "B": ("Scientific types and mathematical primitives", "01-core"),
    "C": ("Information theory and statistics", "01-core"),
    "D": ("Algebra and formal mathematical representations", "02-mathematics"),
    "E": ("Dynamical systems and control", "02-mathematics"),
    "F": ("Biological and evolutionary simulations", "03-biology"),
    "G": ("Computational neuroscience", "03-biology"),
    "H": ("Cognition and intelligence measurement", "04-cognition"),
    "I": ("Computational physics and resource accounting", "04-cognition"),
    "J": ("Scientific discovery and metascience", "04-cognition"),
    "K": ("Experimental infrastructure", "05-experiments"),
    "L": ("Independent verification", "05-experiments"),
    "M": ("Baseline model architecture and model research", "06-models"),
    "N": ("Dataset and tokenizer infrastructure", "06-models"),
    "O": ("Model training", "07-training"),
    "P": ("Model inference", "08-inference"),
    "Q": ("Model evaluation", "09-evaluation"),
    "R": ("Research Studio frontend", "10-observatory"),
    "S": ("Scientific visualization", "10-observatory"),
    "T": ("API and application integration", "10-observatory"),
    "U": ("Local deployment", "11-deployment"),
    "V": ("GPU research deployment", "11-deployment"),
    "W": ("Production deployment", "11-deployment"),
    "X": ("Security and reliability", "12-security"),
    "Y": ("Documentation and publication", "13-integration"),
    "Z": ("End-to-end integration and acceptance testing", "13-integration"),
}

REVIEW_KINDS = {"none", "scientific", "security", "human-approval", "budget"}
COMPLEXITY = {"S", "M", "L", "XL"}  # S < 2h agent time, M half day, L 1 to 2 days, XL multi-day / long run


@dataclass(frozen=True)
class Prompt:
    id: str
    title: str
    group: str
    phase: int
    objective: str
    context: str
    deps: tuple[str, ...]
    inspect: tuple[str, ...]
    scope: tuple[str, ...]
    out_of_scope: tuple[str, ...]
    constraints: tuple[str, ...]
    create: dict[str, str]
    modify: dict[str, str]
    interfaces: str
    requirements: tuple[str, ...]
    tests: tuple[str, ...]
    verify: tuple[str, ...]
    acceptance: tuple[str, ...]
    complexity: str
    resources: str
    review: tuple[str, ...]
    failure: tuple[str, ...] = ()
    conditional: str | None = None
    concepts: tuple[str, ...] = field(default=())

    @property
    def folder(self) -> str:
        return GROUPS[self.group][1]

    @property
    def number(self) -> int:
        return int(self.id.split("P")[-1])

    @property
    def slug(self) -> str:
        keep = "".join(c.lower() if c.isalnum() else "-" for c in self.title)
        while "--" in keep:
            keep = keep.replace("--", "-")
        return keep.strip("-")[:60].rstrip("-")


REGISTRY: list[Prompt] = []


def prompt(
    num: int,
    title: str,
    group: str,
    phase: int,
    *,
    objective: str,
    context: str,
    deps: list[int] | tuple[int, ...] = (),
    inspect: list[str] | tuple[str, ...] = (),
    scope: list[str] | tuple[str, ...],
    out: list[str] | tuple[str, ...],
    constraints: list[str] | tuple[str, ...] = (),
    create: dict[str, str] | None = None,
    modify: dict[str, str] | None = None,
    interfaces: str = "",
    requirements: list[str] | tuple[str, ...] = (),
    tests: list[str] | tuple[str, ...],
    verify: list[str] | tuple[str, ...] = (),
    acceptance: list[str] | tuple[str, ...],
    complexity: str = "M",
    resources: str = "CPU, laptop",
    review: list[str] | tuple[str, ...] = ("none",),
    failure: list[str] | tuple[str, ...] = (),
    conditional: str | None = None,
) -> Prompt:
    p = Prompt(
        id=f"GRIT-P{num:03d}",
        title=title,
        group=group,
        phase=phase,
        objective=objective.strip(),
        context=context.strip(),
        deps=tuple(f"GRIT-P{d:03d}" for d in deps),
        inspect=tuple(inspect),
        scope=tuple(scope),
        out_of_scope=tuple(out),
        constraints=tuple(constraints),
        create=dict(create or {}),
        modify=dict(modify or {}),
        interfaces=interfaces.strip("\n"),
        requirements=tuple(requirements),
        tests=tuple(tests),
        verify=tuple(verify),
        acceptance=tuple(acceptance),
        complexity=complexity,
        resources=resources,
        review=tuple(review),
        failure=tuple(failure),
        conditional=conditional,
    )
    REGISTRY.append(p)
    return p
