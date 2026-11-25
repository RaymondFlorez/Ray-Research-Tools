"""Validate the GRIT prompt catalog and render manifests, prompt files and the DAG diagram.

Usage (from grit-engineering/):
    python3 tools/build.py            # validate and write outputs
    python3 tools/build.py --check    # validate and fail if outputs on disk are stale

Standard library only.
"""

from __future__ import annotations

import argparse
import importlib
import json
import pkgutil
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

from catalog.model import COMPLEXITY, GROUPS, REGISTRY, REVIEW_KINDS, Prompt  # noqa: E402

GROUP_CONSTRAINTS: dict[str, list[str]] = {
    "core": [
        "Functional core (ADR-0003): pure functions, no I/O, no logging, no global state, no clocks.",
        "Stochastic functions take `rng: numpy.random.Generator`; never call global seeding functions.",
        "SI units internally; pint only at boundaries (ADR-0010). Document units in every docstring.",
        "float64 unless documented otherwise. Raise `GritError` subclasses; never return a silent NaN.",
        "Results are frozen dataclasses with read-only arrays and a `to_dict()` method.",
        "Each public function: NumPy-style docstring with formula, units, `Concept: GRIT-C-####`, citation, doctest; registry entry in the package's block; a test marked `@pytest.mark.traces`.",
        "Respect `architecture/layers.toml`; `make layers` must pass.",
    ],
    "lab": [
        "Shell code is allowed here (storage, processes), but keep decision logic (state transitions, authorization, budget checks) in pure functions tested exhaustively.",
        "All writes are atomic; all persisted records carry provenance fields.",
        "`grit_lab` may import only public types from `grit_verify` (protocols, types, signing).",
        "Every state-changing operation writes an audit event.",
    ],
    "verify": [
        "`grit_verify` imports only `grit_core`, the standard library, numpy, scipy and `cryptography` (ADR-0008).",
        "Never import or call code from `grit_lab`, `alphalytica`, `grit_data` or any L2 package.",
        "Evaluation logic must not be configurable by the evaluated model or its training process.",
    ],
    "model": [
        "PyTorch reference implementation (ADR-0009). Plain `nn.Module`s; no inheritance hierarchies; variants selected by config enums.",
        "Weights saved with safetensors; any `torch.load` uses `weights_only=True`; never `trust_remote_code`.",
        "Model definition, data pipeline, training loop and evaluation stay in separate modules.",
        "Configs are immutable TOML files loaded into frozen dataclasses and hashed.",
        "Tests use tiny configs (≤ 100k params) on CPU and finish in seconds.",
    ],
    "data": [
        "No torch dependency outside the optional `grit_data.torch_iter` adapter.",
        "Every source is checksummed; every processed artifact is content-addressed; every dataset version is hashed.",
        "License gate is mandatory and can't be bypassed by configuration.",
    ],
    "frontend": [
        "React + TypeScript strict + Vite (ADR-0014). The client renders; all science is computed by the API.",
        "No `dangerouslySetInnerHTML`; model output is rendered as text only.",
        "Every chart axis requires a unit; every result panel shows provenance and SYNTHETIC/EMPIRICAL status.",
        "Keyboard accessible, WCAG AA contrast in both themes, `prefers-reduced-motion` respected.",
    ],
    "api": [
        "FastAPI with pydantic models; problem+json errors (RFC 9457); versioned under `/api/v1`.",
        "Validate all input at the boundary with explicit size limits; never pass user strings to `eval`, `sympify` or shells.",
        "Authorization checked per endpoint, deny by default; every state change audited.",
    ],
    "infra": [
        "Simplest viable setup (ADR-0011): no component adopted before its trigger.",
        "No secrets in the repository; images run as non-root with pinned base digests.",
        "Every script is idempotent and has a dry-run mode where it touches paid resources.",
    ],
    "foundation": [
        "Standard library only unless the prompt names a dependency.",
        "Keep scripts small and tested; they are infrastructure every later prompt depends on.",
    ],
}

GROUP_KIND = {
    "A": "foundation", "B": "core", "C": "core", "D": "core", "E": "core", "F": "core", "G": "core",
    "H": "core", "I": "core", "J": "core", "K": "lab", "L": "verify", "M": "model", "N": "data",
    "O": "model", "P": "model", "Q": "verify", "R": "frontend", "S": "frontend", "T": "api",
    "U": "infra", "V": "infra", "W": "infra", "X": "infra", "Y": "foundation", "Z": "foundation",
}

STANDARD_CONSTRAINTS = [
    "Follow AGENTS.md. Add no dependency the prompt doesn't name.",
    "No `eval`, `exec`, `pickle.load`, unsafe YAML, `shell=True`, or unnormalized user paths.",
]

STANDARD_FAILURE = [
    "A prerequisite isn't `done` in `prompts/status.json`, or a file listed under Prerequisites is missing: stop, set this prompt to `blocked`, report what's missing.",
    "A test fails for a reason inside this prompt's scope: fix the code, not the test. Never delete, skip or weaken a test to get green.",
    "A test fails for a reason outside this scope (another package's bug, environment issue): record it under Unresolved issues with the failing output; don't patch other packages.",
    "A scientific assumption, constant or reference value in this prompt looks wrong: don't change it silently. Implement as specified, flag it in the report, and propose the correction.",
    "The work needs a dependency, file or permission not listed here: stop and ask, with the reason.",
    "Verification commands can't run in your environment: say so explicitly; never report them as passed.",
]

PROTOCOL = [
    "Read `AGENTS.md`, this prompt, and every file under Existing repository context.",
    "Confirm prerequisites are `done` with `uv run python scripts/prompt_status.py check` (from P006 onward) and set this prompt `in_progress`.",
    "Inspect existing code and tests in the area you'll touch.",
    "Identify the smallest correct implementation that meets the acceptance criteria.",
    "State a concise plan (files, interfaces, tests) before editing.",
    "Make targeted changes only to the files listed (plus their tests and docs).",
    "Don't refactor unrelated code.",
    "Add or update tests with the code.",
    "Run every verification command and read the output.",
    "Fix failures within scope; record anything out of scope as a blocker.",
    "Update the documentation and registry entries named in this prompt.",
    "Stop when every acceptance criterion is met. Write the completion report and set the status.",
]


def load_catalog() -> list[Prompt]:
    import catalog

    for mod in sorted(m.name for m in pkgutil.iter_modules(catalog.__path__)):
        if mod != "model":
            importlib.import_module(f"catalog.{mod}")
    return sorted(REGISTRY, key=lambda p: p.number)


class CatalogError(Exception):
    pass


def validate(prompts: list[Prompt]) -> list[str]:
    errors: list[str] = []
    ids = [p.id for p in prompts]
    by_id = {p.id: p for p in prompts}
    if len(ids) != len(set(ids)):
        dup = sorted({i for i in ids if ids.count(i) > 1})
        errors.append(f"duplicate prompt ids: {dup}")
    expected = [f"GRIT-P{n:03d}" for n in range(1, len(prompts) + 1)]
    if ids != expected:
        missing = sorted(set(expected) - set(ids))
        errors.append(f"prompt ids must be contiguous from P001; missing {missing}")
    for p in prompts:
        if p.group not in GROUPS:
            errors.append(f"{p.id}: unknown group {p.group}")
        if p.complexity not in COMPLEXITY:
            errors.append(f"{p.id}: bad complexity {p.complexity}")
        bad = set(p.review) - REVIEW_KINDS
        if bad:
            errors.append(f"{p.id}: bad review kinds {bad}")
        for f in ("objective", "context", "scope", "out_of_scope", "tests", "acceptance"):
            if not getattr(p, f):
                errors.append(f"{p.id}: empty {f}")
        if not p.create and not p.modify:
            errors.append(f"{p.id}: creates and modifies nothing")
        for d in p.deps:
            if d not in by_id:
                errors.append(f"{p.id}: unknown dependency {d}")
            elif by_id[d].number >= p.number:
                errors.append(f"{p.id}: depends on later or same prompt {d} (prompts must be in dependency order)")
        for text in [p.title, p.objective, p.context, *p.scope, *p.out_of_scope, *p.requirements, *p.tests, *p.acceptance, p.interfaces]:
            if "\u2014" in text:
                errors.append(f"{p.id}: contains an em dash")
                break
    # file ownership
    creators: dict[str, str] = {}
    for p in prompts:
        for path in p.create:
            if path in creators and not path.endswith("/"):
                errors.append(f"{path}: created by both {creators[path]} and {p.id}")
            creators.setdefault(path, p.id)
    ancestors = transitive_deps(prompts)
    for p in prompts:
        for path in p.modify:
            owner = creators.get(path)
            if owner is None:
                errors.append(f"{p.id}: modifies {path}, which no prompt creates")
            elif owner != p.id and owner not in ancestors[p.id]:
                errors.append(f"{p.id}: modifies {path} (created by {owner}) without depending on {owner}")
    return errors


def transitive_deps(prompts: list[Prompt]) -> dict[str, set[str]]:
    by_id = {p.id: p for p in prompts}
    memo: dict[str, set[str]] = {}

    def visit(pid: str) -> set[str]:
        if pid not in memo:
            acc: set[str] = set()
            for d in by_id[pid].deps:
                acc.add(d)
                acc |= visit(d)
            memo[pid] = acc
        return memo[pid]

    for p in prompts:
        visit(p.id)
    return memo


def waves(prompts: list[Prompt]) -> dict[str, int]:
    level: dict[str, int] = {}
    for p in prompts:  # already topologically ordered (validated)
        level[p.id] = 1 + max((level[d] for d in p.deps), default=0)
    return level


def critical_path(prompts: list[Prompt]) -> list[str]:
    by_id = {p.id: p for p in prompts}
    best: dict[str, tuple[int, list[str]]] = {}
    for p in prompts:
        prev = max((best[d] for d in p.deps), default=(0, []), key=lambda t: t[0])
        best[p.id] = (prev[0] + 1, [*prev[1], p.id])
    _, path = max(best.values(), key=lambda t: t[0])
    return [f"{pid} {by_id[pid].title}" for pid in path]


def touched(p: Prompt) -> set[str]:
    return {f for f in [*p.create, *p.modify] if not f.endswith("/")}


def file_conflicts(prompts: list[Prompt], level: dict[str, int]) -> list[tuple[int, str, list[str]]]:
    out = []
    by_wave: dict[int, list[Prompt]] = defaultdict(list)
    for p in prompts:
        by_wave[level[p.id]].append(p)
    for w, ps in sorted(by_wave.items()):
        users: dict[str, list[str]] = defaultdict(list)
        for p in ps:
            for f in touched(p):
                users[f].append(p.id)
        for f, who in sorted(users.items()):
            if len(who) > 1:
                out.append((w, f, who))
    return out


# ---------- rendering ----------

def md_list(items: tuple[str, ...] | list[str], bullet: str = "-") -> str:
    return "\n".join(f"{bullet} {i}" for i in items) if items else "- None."


def md_numbered(items: list[str]) -> str:
    return "\n".join(f"{n}. {i}" for n, i in enumerate(items, 1))


def render_prompt(p: Prompt, by_id: dict[str, Prompt], level: dict[str, int]) -> str:
    kind = GROUP_KIND[p.group]
    constraints = [*GROUP_CONSTRAINTS[kind], *p.constraints, *STANDARD_CONSTRAINTS]
    deps = "\n".join(f"- `{d}` {by_id[d].title} (must be `done`)" for d in p.deps) or "- None. This prompt can start on an empty repository."
    dep_files = sorted({f for d in p.deps for f in by_id[d].create if f in set(p.modify) | set(p.inspect)})
    inspect = ["`AGENTS.md`", "`prompts/status.json` (once GRIT-P006 is done)", *[f"`{i}`" if " " not in i and "/" in i and not i.startswith("`") else i for i in p.inspect]]
    create = "\n".join(f"| `{k}` | {v} |" for k, v in p.create.items())
    modify = "\n".join(f"| `{k}` | {v} |" for k, v in p.modify.items())
    review = ", ".join(p.review)
    verify = [*p.verify] if p.verify else []
    if "make check" not in verify:
        verify.append("make check")
    lines = [
        f"# {p.id}: {p.title}",
        "",
        "| Group | Phase | Wave | Complexity | Resources | Review |",
        "|---|---|---|---|---|---|",
        f"| {p.group}. {GROUPS[p.group][0]} | {p.phase} | {level[p.id]} | {p.complexity} | {p.resources} | {review} |",
        "",
    ]
    if p.conditional:
        lines += [f"> **Conditional prompt.** Run only if: {p.conditional} Otherwise mark it `skipped` with the evidence.", ""]
    if "human-approval" in p.review or "budget" in p.review:
        lines += ["> **Human gate.** This prompt includes a step that needs written human approval (see Scope). Don't perform that step without it.", ""]
    lines += [
        "## Prompt identifier", "", f"`{p.id}`", "",
        "## Objective", "", p.objective, "",
        "## Scientific context", "", p.context, "",
        "## Prerequisites", "", deps, "",
    ]
    if dep_files:
        lines += ["Files from prerequisites that must exist:", "", *[f"- `{f}`" for f in dep_files], ""]
    lines += [
        "## Existing repository context", "", "Read before changing anything:", "", md_list(inspect), "",
        "## Scope", "", md_list(p.scope), "",
        "## Out of scope", "", md_list(p.out_of_scope), "",
        "## Architecture constraints", "", md_list(constraints), "",
        "## Files to create", "",
    ]
    lines += (["| Path | Purpose |", "|---|---|", create] if create else ["None."]) + [""]
    lines += ["## Files to modify", ""]
    lines += (["| Path | Change |", "|---|---|", modify] if modify else ["None."]) + [""]
    lines += ["## Public interfaces", ""]
    lines += (["```python", p.interfaces, "```"] if p.interfaces else ["No new public interfaces beyond the files above."]) + [""]
    lines += [
        "## Implementation requirements", "", md_list(p.requirements or ("Implement exactly the scope above, nothing more.",)), "",
        "## Testing requirements", "", md_list(p.tests), "",
        "## Verification commands", "", "Run from the repository root and paste the summary lines into the completion report.", "",
        "```bash", *verify, "```", "",
        "## Acceptance criteria", "", md_list(p.acceptance, "- [ ]"), "",
        "## Failure handling", "", md_list([*p.failure, *STANDARD_FAILURE]), "",
        "## Completion report", "",
        f"Save to `prompts/reports/{p.id}.md` and paste in your final message:", "",
        "```", f"Prompt: {p.id}  Title: {p.title}", "Status: done | partial | blocked",
        "Files created:", "Files modified:", "Commands run and results:",
        "Acceptance criteria (each: met / not met, with evidence):",
        "Scientific assumptions introduced or changed:", "Limitations:", "Unresolved issues / blockers:", "```", "",
        f"Then: `uv run python scripts/prompt_status.py set {p.id} done` (or `partial` / `blocked`).", "",
        "## Operating protocol", "", md_numbered(PROTOCOL), "",
    ]
    return "\n".join(lines)


def prompt_path(p: Prompt) -> str:
    return f"prompts/{p.folder}/{p.id}-{p.slug}.md"


def render_outputs(prompts: list[Prompt]) -> dict[str, str]:
    by_id = {p.id: p for p in prompts}
    level = waves(prompts)
    out: dict[str, str] = {}
    for p in prompts:
        out[prompt_path(p)] = render_prompt(p, by_id, level)

    index = [
        {
            "id": p.id, "title": p.title, "group": p.group, "group_name": GROUPS[p.group][0],
            "folder": p.folder, "path": prompt_path(p), "phase": p.phase, "wave": level[p.id],
            "dependencies": list(p.deps), "status": "pending",
            "expected_files": sorted([*p.create]), "modified_files": sorted(p.modify),
            "test_commands": list(p.verify) or ["make check"], "acceptance_criteria": list(p.acceptance),
            "complexity": p.complexity, "resources": p.resources, "review": list(p.review),
            "conditional": p.conditional,
        }
        for p in prompts
    ]
    out["manifests/prompts.json"] = json.dumps({"version": 1, "prompts": index}, indent=2) + "\n"

    dep = {
        "version": 1,
        "nodes": [{"id": p.id, "title": p.title, "group": p.group, "wave": level[p.id]} for p in prompts],
        "edges": [{"from": d, "to": p.id} for p in prompts for d in p.deps],
        "waves": {str(w): [p.id for p in prompts if level[p.id] == w] for w in sorted(set(level.values()))},
        "critical_path": [s.split(" ")[0] for s in critical_path(prompts)],
    }
    out["manifests/dependencies.json"] = json.dumps(dep, indent=2) + "\n"

    files: dict[str, dict[str, object]] = {}
    for p in prompts:
        for f, purpose in p.create.items():
            files.setdefault(f, {"purpose": purpose, "created_by": p.id, "modified_by": [], "tests": []})
    for p in prompts:
        for f in p.modify:
            files[f]["modified_by"].append(p.id)  # type: ignore[union-attr]
        tests = [f for f in p.create if "/tests/" in f or f.startswith("tests/") or f.endswith(".spec.ts") or f.endswith(".test.ts") or f.endswith(".test.tsx")]
        for f in p.create:
            if f not in tests:
                files[f]["tests"] = tests
    out["manifests/files.json"] = json.dumps({"version": 1, "files": dict(sorted(files.items()))}, indent=2) + "\n"

    out["manifests/acceptance.json"] = json.dumps(
        {"version": 1, "acceptance": {p.id: {"title": p.title, "criteria": list(p.acceptance), "review": list(p.review)} for p in prompts}},
        indent=2,
    ) + "\n"

    out["architecture/repository-manifest.md"] = render_repo_manifest(files)
    out["manifests/PROMPT_INDEX.md"] = render_index(prompts, level)
    out["manifests/EXECUTION_PLAN.md"] = render_plan(prompts, level)
    out["diagrams/prompt-dag.mmd"] = render_dag(prompts)
    return out


def render_repo_manifest(files: dict[str, dict[str, object]]) -> str:
    lines = [
        "# Repository File Manifest", "",
        f"{len(files)} planned files and directories in the GRIT repository, grouped by top-level directory. "
        "Generated by `tools/build.py` from the prompt catalog; the machine-readable form is `manifests/files.json`.", "",
        "Ownership rule: the creating prompt owns a file. Later prompts may modify it only if they depend on the owner. "
        "Runtime state (`.grit/`, `artifacts/`, `.env`) is never committed.", "",
    ]
    groups: dict[str, list[str]] = defaultdict(list)
    for path in files:
        top = path.split("/")[0] if "/" in path else "(root)"
        if top in ("packages", "models", "services", "apps") and path.count("/") >= 1:
            top = "/".join(path.split("/")[:2])
        groups[top].append(path)
    for top in sorted(groups):
        lines += ["", f"## `{top}`", "", "| Path | Purpose | Created by | Modified by | Tests added by the creating prompt |", "|---|---|---|---|---|"]
        for path in sorted(groups[top]):
            f = files[path]
            mod = ", ".join(m.replace("GRIT-", "") for m in f["modified_by"]) or ""  # type: ignore[union-attr]
            tests = "<br>".join(f"`{t.split('/')[-1]}`" for t in f["tests"]) if f["tests"] else ""  # type: ignore[union-attr]
            lines.append(f"| `{path}` | {f['purpose']} | {str(f['created_by']).replace('GRIT-', '')} | {mod} | {tests} |")
    return "\n".join(lines) + "\n"


def render_index(prompts: list[Prompt], level: dict[str, int]) -> str:
    lines = [
        "# Implementation Prompt Index", "",
        f"{len(prompts)} prompts in dependency order. Generated by `tools/build.py` from `tools/catalog/`; don't edit by hand.", "",
        "Review codes: `scientific` (domain reviewer checks math and references), `security` (security reviewer), "
        "`human-approval` (a step needs written owner approval), `budget` (spends compute or money; approver sets budget).", "",
    ]
    current = None
    for p in prompts:
        if p.group != current:
            current = p.group
            lines += ["", f"## {p.group}. {GROUPS[p.group][0]}", "", "| ID | Title | Phase | Wave | Depends on | Size | Review |", "|---|---|---|---|---|---|---|"]
        deps = ", ".join(d.replace("GRIT-", "") for d in p.deps) or "none"
        cond = " (conditional)" if p.conditional else ""
        lines.append(f"| [{p.id}](../{prompt_path(p)}) | {p.title}{cond} | {p.phase} | {level[p.id]} | {deps} | {p.complexity} | {', '.join(p.review)} |")
    return "\n".join(lines) + "\n"


def render_plan(prompts: list[Prompt], level: dict[str, int]) -> str:
    by_wave: dict[int, list[Prompt]] = defaultdict(list)
    for p in prompts:
        by_wave[level[p.id]].append(p)
    conflicts = file_conflicts(prompts, level)
    lines = [
        "# Prompt Execution Plan", "",
        "Generated by `tools/build.py`. A wave is the set of prompts whose dependencies all sit in earlier waves. "
        "Prompts in the same wave can run in parallel unless listed under file coordination.", "",
        f"- Prompts: {len(prompts)}",
        f"- Waves: {len(by_wave)}",
        f"- Conditional prompts: {sum(1 for p in prompts if p.conditional)}",
        f"- Prompts with a human gate (human-approval or budget): {sum(1 for p in prompts if {'human-approval', 'budget'} & set(p.review))}",
        "",
        "## Critical path", "",
        "The longest dependency chain. Delays here delay everything.", "",
        md_numbered(critical_path(prompts)), "",
        "## Waves (parallel sets)", "",
    ]
    for w, ps in sorted(by_wave.items()):
        lines.append(f"**Wave {w}:** " + ", ".join(f"{p.id} {p.title}" for p in ps))
        lines.append("")
    lines += ["## File coordination within a wave", "",
              "These prompts share a wave and touch the same file. Run them sequentially in ID order, or have one agent coordinate the shared file.", ""]
    if conflicts:
        lines += ["| Wave | File | Prompts |", "|---|---|---|"]
        lines += [f"| {w} | `{f}` | {', '.join(who)} |" for w, f, who in conflicts]
    else:
        lines.append("None.")
    lines += ["", "## Must run sequentially", "",
              "Any prompt and its dependencies run in order (that's the DAG). In addition, these chains share mutable state and must never overlap:", "",
              "- Anything that edits `Makefile` or root `pyproject.toml` within one wave (see table above).",
              "- Training and evaluation runs on the same hardware (P081, P100, P101, P104): one at a time, so measurements aren't contaminated by contention.",
              "- Database migrations (P048, P050, P093, P095, P106): one migration prompt at a time; migration numbers are assigned in ID order.", ""]
    lines += ["## Human review required", "", "| ID | Title | Review |", "|---|---|---|"]
    lines += [f"| {p.id} | {p.title} | {', '.join(p.review)} |" for p in prompts if set(p.review) != {"none"}]
    lines += ["", "## Conditional prompts", "", "| ID | Title | Run only if |", "|---|---|---|"]
    lines += [f"| {p.id} | {p.title} | {p.conditional} |" for p in prompts if p.conditional]
    lines += ["", "## Resource requirements", "", "| ID | Title | Resources |", "|---|---|---|"]
    lines += [f"| {p.id} | {p.title} | {p.resources} |" for p in prompts if p.resources != "CPU, laptop"]
    return "\n".join(lines) + "\n"


def render_dag(prompts: list[Prompt]) -> str:
    lines = ["%% Generated by tools/build.py. Prompt dependency DAG, clustered by group.", "flowchart LR"]
    current = None
    for p in prompts:
        if p.group != current:
            if current is not None:
                lines.append("  end")
            current = p.group
            lines.append(f'  subgraph G{p.group}["{p.group}. {GROUPS[p.group][0]}"]')
        short = p.id.replace("GRIT-", "")
        lines.append(f'    {short}["{short} {p.title[:38]}"]')
    lines.append("  end")
    for p in prompts:
        for d in p.deps:
            lines.append(f"  {d.replace('GRIT-', '')} --> {p.id.replace('GRIT-', '')}")
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="fail if generated files are stale")
    args = ap.parse_args(argv)
    prompts = load_catalog()
    errors = validate(prompts)
    if errors:
        print("catalog errors:", *errors, sep="\n  ")
        return 1
    outputs = render_outputs(prompts)
    stale = []
    for rel, text in outputs.items():
        path = ROOT / rel
        if args.check:
            if not path.exists() or path.read_text() != text:
                stale.append(rel)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
    if not args.check:
        # remove prompt files no longer in the catalog
        expected = {ROOT / r for r in outputs if r.startswith("prompts/")}
        for f in (ROOT / "prompts").rglob("GRIT-P*.md"):
            if f not in expected:
                f.unlink()
    if stale:
        print("stale generated files (run python3 tools/build.py):", *stale, sep="\n  ")
        return 1
    level = waves(prompts)
    print(f"ok: {len(prompts)} prompts, {max(level.values())} waves, {len(outputs)} files {'checked' if args.check else 'written'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
