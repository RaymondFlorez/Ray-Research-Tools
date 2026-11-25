# grit-engineering

The engineering specification and prompt factory for the **GRIT Computational Science Platform** (General Recursive Intelligence Theory), the research infrastructure of the Alphalytica Research Institute.

Nothing here is the platform itself. This folder is what you hand to coding agents, one prompt at a time, to build it.

## Start here

| If you want | Read |
|---|---|
| The whole design in one document | [MASTER_ARCHITECTURE.md](MASTER_ARCHITECTURE.md) |
| The order of work, phases and milestones | [MASTER_BUILD_PLAN.md](MASTER_BUILD_PLAN.md) |
| The rules every coding agent follows | [AGENTS.md](AGENTS.md) |
| All 117 prompts in one table | [manifests/PROMPT_INDEX.md](manifests/PROMPT_INDEX.md) |
| What can run in parallel, human gates, critical path | [manifests/EXECUTION_PLAN.md](manifests/EXECUTION_PLAN.md) |
| The first prompt to run | [prompts/00-foundations/GRIT-P001-repository-skeleton-workspace-and-toolchain.md](prompts/00-foundations/GRIT-P001-repository-skeleton-workspace-and-toolchain.md) |

## Layout

```
grit-engineering/
  MASTER_ARCHITECTURE.md     deliverables 1-3, 8-12 summary; links to everything else
  MASTER_BUILD_PLAN.md       phases 0-10, milestones, human decisions
  AGENTS.md                  coding-agent operating protocol (copied into the GRIT repo by P001)
  architecture/
    layers.toml              allowed import edges, enforced by scripts/check_layers.py (P003)
    repository-manifest.md   every planned file: purpose, owner prompt, modifiers (generated)
  specifications/            scientific modules, model research, training, inference, evaluation,
                             data, security, deployment, observatory UI, testing, compute cost, docs standards
  decisions/                 ADR-0001 to ADR-0016
  manifests/                 prompts.json, dependencies.json, files.json, acceptance.json,
                             PROMPT_INDEX.md, EXECUTION_PLAN.md (all generated)
  prompts/                   117 prompt files in 14 folders (generated)
  diagrams/                  Mermaid sources, including the generated prompt DAG
  templates/                 prompt, ADR, model card, dataset card, experiment report
  checklists/                prompt, scientific, security, release, GPU run reviews
  tools/
    catalog/                 the single source of truth for prompts (Python data)
    build.py                 validates the catalog and renders everything under manifests/ and prompts/
```

## The catalog is the source of truth

Prompts, manifests, the DAG, the file map and the execution plan are all generated from `tools/catalog/*.py`. Edit the catalog, then:

```bash
python3 tools/build.py
```

`build.py` refuses to write anything if the catalog is inconsistent. It checks that IDs are contiguous, every dependency exists and has a lower number (so prompt order is a topological order), no file is created by two prompts, every modified file is created by an ancestor prompt, review and complexity values are valid, and no prompt text contains an em dash. CI or a reviewer can run the read-only form:

```bash
python3 tools/build.py --check
```

## Prompt folders

| Folder | Groups |
|---|---|
| `00-foundations` | A. Architecture and repository foundations |
| `01-core` | B. Scientific types and primitives; C. Information theory and statistics |
| `02-mathematics` | D. Algebra and formal representations; E. Dynamical systems and control |
| `03-biology` | F. Biological and evolutionary simulations; G. Computational neuroscience |
| `04-cognition` | H. Cognition and intelligence measurement; I. Physics and resource accounting; J. Discovery and metascience |
| `05-experiments` | K. Experimental infrastructure; L. Independent verification |
| `06-models` | M. Model architecture and the model research program; N. Datasets and tokenizers |
| `07-training` | O. Model training |
| `08-inference` | P. Model inference |
| `09-evaluation` | Q. Model evaluation |
| `10-observatory` | R. Research Studio; S. Visualization; T. API and integration |
| `11-deployment` | U. Local; V. GPU research; W. Production |
| `12-security` | X. Security and reliability |
| `13-integration` | Y. Documentation and publication; Z. End-to-end acceptance |

## Open questions for the owner

1. **Repository location** (ADR-0001): dedicated `grit` repository (recommended) or a `grit/` folder in this one.
2. **Treatise definitions**: capability metrics, the capability taxonomy and the discovery classification scheme are provisional stand-ins until checked against the treatise.
3. **Training corpus for G0**: candidates in [specifications/data.md](specifications/data.md); the license must be verified by you before P081.
4. **GPU provider**: any SSH-reachable NVIDIA box works; P099 needs your choice and a ≤ 1 GPU-hour approved dry-run budget.
