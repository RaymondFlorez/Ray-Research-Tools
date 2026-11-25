"""Groups M, N, O, P, Q: models, data, training, inference, evaluation (Phase 6)."""

from .model import prompt

A = "models/alphalytica/src/alphalytica"
AT = "models/alphalytica/tests"
G = "packages/grit_data/src/grit_data"
GT = "packages/grit_data/tests"
V = "packages/grit_verify/src/grit_verify"
VT = "packages/grit_verify/tests"
MRP = "grit-engineering/specifications/model-research-plan.md"
TR = "grit-engineering/specifications/training.md"
INF = "grit-engineering/specifications/inference.md"
EV = "grit-engineering/specifications/evaluation.md"
DATA = "grit-engineering/specifications/data.md"

# ---------------- M: model architecture ----------------
prompt(
    59, "Alphalytica package, ModelConfig and exact parameter counting", "M", 6,
    objective="Create the `alphalytica` package skeleton with a frozen, validated, hashed `ModelConfig` loaded from TOML, reference configs for G0 to G3, and a test that the analytical parameter count from `grit_physics` equals the PyTorch count exactly.",
    context="Every architecture comparison depends on exact parameter counts (parameter-matched arms within 2%). The config is the single description of an architecture; variants are enum fields, not subclasses.",
    deps=[42, 46],
    inspect=[MRP, "grit-engineering/specifications/compute-cost.md", "grit-engineering/decisions/ADR-0009-pytorch-safetensors.md"],
    scope=["`models/alphalytica` package (deps: grit-core, grit-physics, grit-verify (protocols only), torch).", "`arch/config.py`: `ModelConfig` (n_layer, d_model, n_head, n_kv_head, d_ff, vocab_size, ctx_len, attention, position, norm, norm_placement, ffn, bias, tied_embeddings, dropout, init_std) with validation; `to_shape() -> grit_physics.TransformerShape`.", "`configs/architecture/{g0-base-v1, g1-base-v1, g2-ref-v1, g3-ref-v1}.toml`.", "Torch install note in README: CPU wheels on Linux CI, default wheels on macOS."],
    out=["The model itself (P060)."],
    constraints=["torch is a dependency of alphalytica only."],
    create={"models/alphalytica/pyproject.toml": "package metadata", "models/alphalytica/README.md": "package overview and install notes", f"{A}/__init__.py": "package root", f"{A}/py.typed": "marker", f"{A}/arch/__init__.py": "architecture subpackage", f"{A}/arch/config.py": "ModelConfig", "configs/architecture/g0-base-v1.toml": "G0 config", "configs/architecture/g1-base-v1.toml": "G1 baseline config", "configs/architecture/g2-ref-v1.toml": "G2 reference config", "configs/architecture/g3-ref-v1.toml": "G3 reference config", f"{AT}/test_config.py": "tests", "docs/registry/concepts/alphalytica.toml": "model registry entries (block 2300 to 2499)"},
    tests=["Invalid configs rejected (d_model % n_head, n_head % n_kv_head).", "Config hash stable (golden)."],
    verify=["uv sync --all-packages", "uv run pytest models/alphalytica -q", "make check"],
    acceptance=["Four reference configs load and validate.", "Layer check passes (alphalytica imports only allowed packages)."],
    complexity="S",
)

prompt(
    60, "Generation 0 reference decoder-only Transformer", "M", 6,
    objective="Implement the G0 reference model: token embedding, learned positions, pre-LayerNorm blocks with causal multi-head attention via `F.scaled_dot_product_attention`, GELU MLP, tied output head, GPT-2 initialization; plus shape, causality, gradient and overfit tests.",
    context="The baseline everything else is compared against, so it must be boring, readable and correct.",
    deps=[59],
    inspect=[MRP + " (Generation 0)", "Vaswani et al. (2017); Radford et al. (2019) GPT-2 initialization"],
    scope=["`arch/layers.py`: `Attention`, `Mlp`, `Block`; `arch/model.py`: `Transformer(cfg)`, `forward(tokens) -> logits`, `build_model(cfg, generator)`, `count_parameters`.", "Init: N(0, init_std); residual output projections scaled by 1/sqrt(2·n_layer); deterministic under a torch.Generator.", "Parameter count equals `grit_physics.transformer_params(cfg.to_shape())` exactly for all reference configs (instantiate G2/G3 on the `meta` device)."],
    out=["Variants (P061).", "KV cache (P072)."],
    create={f"{A}/arch/layers.py": "attention, MLP, block", f"{A}/arch/model.py": "Transformer", f"{AT}/test_model.py": "shape, causality, gradient and overfit tests", f"{AT}/test_param_count.py": "analytical vs actual parameter counts"},
    modify={f"{A}/arch/__init__.py": "export"},
    interfaces="""
class Transformer(nn.Module):
    def __init__(self, cfg: ModelConfig) -> None: ...
    def forward(self, tokens: torch.LongTensor) -> torch.Tensor: ...  # (B, T) -> (B, T, V)
def build_model(cfg: ModelConfig, *, generator: torch.Generator, device: torch.device | str = "cpu") -> Transformer: ...
""",
    tests=["Shape (B, T) → (B, T, V).", "Causality: changing token t+1..T leaves logits at ≤ t unchanged (exact).", "gradcheck on a tiny float64 attention block.", "Overfit one batch of 64 tokens to loss < 0.05 within 300 steps on CPU.", "Same generator seed → identical initial weights."],
    verify=["uv run pytest models/alphalytica -q", "make check"],
    acceptance=["Parameter counts exact for G0 to G3.", "Tests run in < 30 s on CPU."],
    complexity="M",
    review=["scientific"],
)

prompt(
    61, "Generation 1 component variants: attention, position, normalization, feedforward", "M", 6,
    objective="Add the controlled-study component variants as config enums: MHA/GQA/MQA attention, learned/RoPE/ALiBi/none positions, LayerNorm/RMSNorm with pre/post placement, GELU MLP/SwiGLU; and a parameter-matching helper.",
    context="Generation 1 compares one component at a time against the baseline at matched parameters and matched compute. Each variant is tested against its defining mathematical property.",
    deps=[60],
    inspect=[MRP + " (Generation 1 studies S1 to S4)", "Su et al. (2021) RoPE; Press et al. (2022) ALiBi; Zhang & Sennrich (2019) RMSNorm; Shazeer (2020) GLU variants; Ainslie et al. (2023) GQA"],
    scope=["Variants in `arch/layers.py` selected by `cfg` enums; no subclasses.", "`arch/matching.py`: `match_parameters(base_cfg, variant_cfg, tolerance=0.02) -> ModelConfig` adjusting d_ff; `match_compute(...)` adjusting training tokens.", "Analytical counts in grit_physics already cover these (verify; if a formula is missing, record a blocker rather than editing grit_physics)."],
    out=["MoE, SSM, recurrent architectures (P102)."],
    create={f"{A}/arch/matching.py": "parameter and compute matching", f"{AT}/test_variants.py": "variant property tests"},
    modify={f"{A}/arch/layers.py": "variant implementations", f"{A}/arch/model.py": "wire variants", f"{AT}/test_param_count.py": "add variant configs"},
    tests=["RoPE: q·k depends only on relative position (property over random offsets).", "ALiBi bias matrix matches paper's slopes for n_head = 8.", "GQA with n_kv_head = n_head equals MHA numerically given shared weights.", "SwiGLU with hidden 8/3·d matches GELU-MLP parameter count within 2%.", "Post-LN and pre-LN produce different outputs; both causal."],
    verify=["uv run pytest models/alphalytica -q", "make check"],
    acceptance=["Every variant has a defining-property test.", "Parameter counts still exact for every variant."],
    complexity="L",
    review=["scientific"],
)

# ---------------- N: data and tokenizers ----------------
prompt(
    62, "grit_data: dataset manifests, checksummed ingestion and the license gate", "N", 6,
    objective="Create the `grit_data` package with dataset manifests, checksummed ingestion from local files or HTTPS, and a license gate that blocks any source without an allowlisted SPDX id and a human verification record.",
    context="Data provenance and licensing are requirements, not paperwork. The gate is the only path to training data.",
    deps=[14, 49],
    inspect=[DATA + " (datasets, license gate, candidate corpora)"],
    scope=["Package skeleton (deps: grit-core, pyarrow, httpx).", "`manifests.py`: `DatasetManifest` schema and loader (TOML in `datasets/manifests/`).", "`ingest.py`: download with streaming sha256, size limit, retries; local file ingest; raw files stored in the artifact store by hash (store root passed in).", "`license_gate.py`: `datasets/license-policy.toml` allowlist (owner-maintained); `check_license(manifest) -> GateDecision`; unknown or unverified → blocked.", "`datasets/schemas/manifest.schema.md` documenting fields.", "A tiny synthetic fixture dataset manifest (CC0, generated text) for tests."],
    out=["Cleaning and dedup (P063).", "Choosing the real G0 corpus (P081, human)."],
    constraints=["grit_data must not import grit_lab; it takes an artifact store object implementing the protocol (duck-typed `put_file`, `get`).", "Add httpx and pyarrow only."],
    create={"packages/grit_data/pyproject.toml": "package metadata", f"{G}/__init__.py": "package root", f"{G}/py.typed": "marker", f"{G}/manifests.py": "manifest schema", f"{G}/ingest.py": "checksummed ingestion", f"{G}/license_gate.py": "license gate", "datasets/license-policy.toml": "SPDX allowlist (owner maintained)", "datasets/schemas/manifest.schema.md": "manifest field documentation", "datasets/manifests/fixture-synthetic-v1.toml": "test fixture manifest", f"{GT}/test_ingest.py": "tests", f"{GT}/test_license_gate.py": "tests", "docs/registry/concepts/grit_data.toml": "data registry entries (block 2500 to 2699)"},
    tests=["Checksum mismatch aborts ingestion and stores nothing.", "Unverified license blocked; allowlisted + verified passes; non-allowlisted blocked even if verified.", "Size limit enforced."],
    verify=["uv sync --all-packages", "uv run pytest packages/grit_data -q", "make check"],
    acceptance=["No code path trains on data that hasn't passed the gate (gate decision hash required by later pipeline stages).", "License policy file requires owner review (listed in human review checklist)."],
    complexity="M",
    review=["security", "human-approval"],
    failure=["Don't add SPDX ids to the allowlist yourself; the owner does."],
)

prompt(
    63, "Text normalization, filtering and deduplication", "N", 6,
    objective="Add normalization (NFC, whitespace, boilerplate stripping), filters, exact deduplication and MinHash LSH near-duplicate clustering with a dedup report.",
    context="Duplicates inflate apparent performance and leak across splits. Near-duplicate clustering feeds cluster-level split assignment (P064).",
    deps=[62],
    inspect=[DATA + " (processing pipeline)", "Broder (1997) MinHash; Lee et al. (2022) Deduplicating training data"],
    scope=["`clean.py`: normalization and filters (length, replacement-character ratio).", "`dedup.py`: exact dedup by sha256 of normalized text; MinHash (128 permutations, 5-gram word shingles, numpy implementation with seeded hash params), LSH 16×8, union-find clustering, Jaccard verification ≥ 0.8; `DedupReport`.", "Streaming over Parquet record batches; memory bounded."],
    out=["Language identification models.", "Quality classifiers."],
    create={f"{G}/clean.py": "normalization and filters", f"{G}/dedup.py": "exact and near dedup", f"{GT}/test_dedup.py": "tests", f"{GT}/fixtures/planted_duplicates.py": "fixture generator with planted exact and near duplicates"},
    tests=["All planted exact duplicates removed; ≥ 95% of planted near-duplicates (Jaccard ≥ 0.85) clustered; < 1% false merges on distinct docs.", "Deterministic under seed.", "Memory stays under a fixed bound on 100k docs (tracemalloc)."],
    verify=["uv run pytest packages/grit_data -q", "make check"],
    acceptance=["Dedup report includes counts, thresholds and parameters.", "Recall and false-merge rates printed in the completion report."],
    complexity="M",
    review=["scientific"],
)

prompt(
    64, "Leakage-safe splits and dataset versioning", "N", 6,
    objective="Add cluster-level deterministic hash splitting, Parquet shard writing, dataset version hashing, and a leakage test that must pass for every dataset version.",
    context="Splitting after near-dup clustering keeps near-duplicates in one split. Version hash covers manifest, processing config and pipeline code commit.",
    deps=[63],
    inspect=[DATA + " (leakage prevention, versioning)"],
    scope=["`splits.py`: `assign_split(cluster_rep_id, fractions, seed)` via sha256 mod 10,000.", "`versioning.py`: `dataset_version_hash`, `write_processed(dataset, out_store) -> ProcessedDataset` (per-split Parquet shards + manifest).", "`leakage.py`: `check_leakage(processed) -> LeakageReport` (exact and near duplicate pairs across splits must be zero).", "`grit-data process MANIFEST` CLI running ingest → clean → dedup → split → write, refusing without gate pass."],
    out=["Tokenization (P065)."],
    create={f"{G}/splits.py": "split assignment", f"{G}/versioning.py": "processed dataset writer and version hash", f"{G}/leakage.py": "leakage check", f"{G}/cli.py": "grit-data CLI", f"{GT}/test_splits_leakage.py": "tests"},
    modify={"packages/grit_data/pyproject.toml": "console script grit-data"},
    tests=["Zero cross-split duplicates on the planted fixture.", "Changing any config value changes the version hash.", "Split fractions within ±1% on 100k docs."],
    verify=["uv run pytest packages/grit_data -q", "uv run grit-data process datasets/manifests/fixture-synthetic-v1.toml --dry-run", "make check"],
    acceptance=["Processing refuses data that failed the gate.", "Leakage check runs automatically at the end of processing and fails the command on any leak."],
    complexity="M",
    review=["scientific"],
)

prompt(
    65, "Tokenizers: byte-level reference and byte-level BPE", "N", 6,
    objective="Add a byte-level reference tokenizer and byte-level BPE trained with Hugging Face `tokenizers` on the train split only, versioned by hash, with round-trip guarantees and byte accounting for bits per byte.",
    context="ADR-0013. Bits per byte is the cross-tokenizer metric, so every tokenized sequence must know its byte length.",
    deps=[64],
    inspect=["grit-engineering/decisions/ADR-0013-tokenization-and-bpb.md"],
    scope=["`tokenizers/byte_level.py`: vocab 256 + specials (BOS, EOS, PAD).", "`tokenizers/bpe.py`: `train_bpe(processed_dataset, vocab_size, seed) -> TokenizerArtifact` (train split only, asserted), save/load JSON, hash.", "Both implement `grit_verify.protocols.TokenizerLike`.", "`configs/tokenization/{byte-v1, bpe4k-v1, bpe16k-v1, bpe32k-v1}.toml`."],
    out=["SentencePiece, unigram LM tokenizers."],
    constraints=["Add `tokenizers` to grit_data only."],
    create={f"{G}/tokenizers/__init__.py": "tokenizer API", f"{G}/tokenizers/byte_level.py": "byte tokenizer", f"{G}/tokenizers/bpe.py": "BPE training and loading", "configs/tokenization/byte-v1.toml": "config", "configs/tokenization/bpe4k-v1.toml": "config", "configs/tokenization/bpe16k-v1.toml": "config", "configs/tokenization/bpe32k-v1.toml": "config", f"{GT}/test_tokenizers.py": "tests"},
    modify={"packages/grit_data/pyproject.toml": "add tokenizers"},
    tests=["Property: decode(encode(s)) == s for arbitrary Unicode (Hypothesis text incl. emoji, CJK, control chars).", "Training on val/test split refused.", "Same data + seed → same tokenizer hash.", "Byte counts correct for multi-byte characters."],
    verify=["uv run pytest packages/grit_data/tests/test_tokenizers.py -q", "make check"],
    acceptance=["Round-trip property passes under `thorough` profile.", "Tokenizer artifacts content-addressed."],
    complexity="M",
)

prompt(
    66, "Tokenized shards, sequence packing and resumable batching", "N", 6,
    objective="Add pre-tokenization to memory-mapped uint16/uint32 shards with document boundaries, sequence packing, and a deterministic, resumable batch iterator (plus the optional torch adapter).",
    context="Resuming training bit-identically requires the data order to be a pure function of (seed, position).",
    deps=[65],
    inspect=[TR + " (checkpointing: data_state.json)"],
    scope=["`shards.py`: `tokenize_to_shards(processed, tokenizer, out) -> ShardSet` (.bin + index JSON with doc offsets and byte counts).", "`batching.py`: `ResumableBatchIterator(shards, seq_len, batch_size, seed)` with `state() -> dict` and `from_state`; packing with EOS separators; epoch shuffling via seeded permutation of sequence starts.", "`torch_iter.py` (optional extra `torch`): yields LongTensors."],
    out=["Multi-worker data loading (add after profiling shows stalls)."],
    create={f"{G}/shards.py": "token shards", f"{G}/batching.py": "resumable batch iterator", f"{G}/torch_iter.py": "optional torch adapter", f"{GT}/test_batching.py": "tests", "docs/milestones/data-pipeline.md": "data pipeline walkthrough"},
    modify={"packages/grit_data/pyproject.toml": "optional torch extra"},
    tests=["Iterating N batches, saving state, resuming yields the same next batches as uninterrupted iteration (exact).", "Each epoch covers every sequence exactly once.", "Byte counts per batch available for bpb."],
    verify=["uv run pytest packages/grit_data -q", "make check"],
    acceptance=["Resume identity test passes.", "Throughput ≥ 1M tokens/s from mmap on the laptop (bench in report)."],
    complexity="M",
)

# ---------------- O: training ----------------
prompt(
    67, "Training configuration and run record integration", "O", 6,
    objective="Add `TrainingConfig` (immutable TOML, hashed), the config immutability check, and the bridge that builds a complete `RunRecord` for every training run.",
    context="Every run records architecture, parameter count, dataset id/version, tokenizer version, code commit, seeds, hyperparameters, hardware, duration, compute, energy, metrics, evaluation refs, checkpoint ids and known limitations.",
    deps=[61, 66, 53],
    inspect=[TR + " (configs, run record)"],
    scope=["`train/config.py`: `TrainingConfig` (optimizer, schedule, loop, precision, seeds, intervals).", "`configs/training/g0-base-v1.toml`, `configs/training/tiny-test-v1.toml`.", "`train/run_record.py`: `RunRecordDraft` matching the documented RunRecord schema field for field (alphalytica can't import grit_lab); the lab executor validates and persists it; a compatibility test lives in tests/integration.", "`scripts/check_config_immutability.py`: fail if a config referenced by any run record in `experiments/` changed."],
    out=["The loop (P068)."],
    create={f"{A}/train/__init__.py": "training subpackage", f"{A}/train/config.py": "TrainingConfig", f"{A}/train/run_record.py": "run record draft builder", "configs/training/g0-base-v1.toml": "G0 training config", "configs/training/tiny-test-v1.toml": "tiny config for tests", "scripts/check_config_immutability.py": "config immutability check", "tests/integration/test_run_record_schema.py": "alphalytica draft ↔ grit_lab RunRecord compatibility"},
    modify={"Makefile": "add config immutability check to `check`"},
    tests=["Unknown key rejected.", "Draft → lab RunRecord validates with every required field.", "Changing a referenced config fails the immutability check."],
    verify=["uv run pytest models/alphalytica tests/integration/test_run_record_schema.py -q", "make check"],
    acceptance=["Every required run record field populated or explicitly null with reason."],
    complexity="S",
)

prompt(
    68, "Training loop: optimizer, schedule, accumulation, clipping, precision, determinism", "O", 6,
    objective="Implement the training loop with AdamW (correct weight decay groups), warmup-cosine schedule, gradient accumulation, global-norm clipping, mixed precision by device, device selection, determinism settings and signal handling.",
    context="Requirements and tests are listed in specifications/training.md. The loop knows nothing about how data was produced or how evaluation works.",
    deps=[67],
    inspect=[TR + " (training loop contract)"],
    scope=["`train/optim.py`: param groups (no decay on biases, norms, embeddings), AdamW, schedule function.", "`train/device.py`: `select_device`, autocast context per device and precision, GradScaler for fp16.", "`train/loop.py`: `train(model, batches, cfg, run_ctx, hooks) -> TrainResult`; validation loss every `eval_interval` (monitoring only); SIGINT/SIGTERM handling at step boundaries.", "Determinism: `torch.use_deterministic_algorithms(True)` on CPU; documented best effort on MPS/CUDA."],
    out=["Checkpointing (P069).", "Metrics persistence and budget watchdog (P070)."],
    create={f"{A}/train/optim.py": "optimizer and schedule", f"{A}/train/device.py": "device and precision", f"{A}/train/loop.py": "training loop", f"{AT}/test_training_loop.py": "tests"},
    modify={f"{A}/train/__init__.py": "export"},
    tests=["Grad accum 4 × 8 ≡ 1 × 32 within 1e-6 (CPU fp32).", "Clipped norm ≤ threshold.", "Schedule values at step 0, end of warmup, max_steps.", "Weight decay groups inspected.", "Two CPU runs → identical final params.", "Tiny model loss decreases monotonically in expectation (smoothed) over 200 steps."],
    verify=["uv run pytest models/alphalytica/tests/test_training_loop.py -q", "make check"],
    acceptance=["All loop requirements in training.md have a passing test."],
    complexity="L",
    review=["scientific"],
)

prompt(
    69, "Checkpointing and bit-identical resume", "O", 6,
    objective="Add checkpoints (safetensors weights, optimizer/scheduler state, all RNG states, data iterator state, metadata, sha256 manifest) and resume that reproduces uninterrupted training bit for bit on CPU.",
    context="Resume correctness is a G0 exit criterion and the basis of GPU failure recovery.",
    deps=[68],
    inspect=[TR + " (checkpointing and resume)", "grit-engineering/specifications/security.md (checkpoint integrity)"],
    scope=["`train/checkpoint.py`: `save_checkpoint(state, store) -> CheckpointRef`, `load_checkpoint(ref, store, *, verify=True)`; `weights_only=True`; manifest verification; config hash check on resume.", "Checkpoint by step interval and wall-clock interval; keep-last-k policy local; all checkpoints in artifact store."],
    out=["Object storage sync (P098)."],
    create={f"{A}/train/checkpoint.py": "checkpointing", f"{AT}/test_checkpoint_resume.py": "resume identity tests"},
    modify={f"{A}/train/loop.py": "checkpoint hooks and resume entry"},
    tests=["Train 2N vs train N + resume in a new process + N: identical params on CPU (torch.equal).", "Tampered manifest → IntegrityError.", "Config hash mismatch on resume → refused.", "No pickle in weights file (safetensors header check)."],
    verify=["uv run pytest models/alphalytica/tests/test_checkpoint_resume.py -q", "make check"],
    acceptance=["Bit-identical resume on CPU.", "MPS resume within 1e-6 relative (documented if MPS unavailable in CI)."],
    complexity="M",
    review=["security"],
)

prompt(
    70, "Metrics, profiling, budget watchdog and lab-governed runs", "O", 6,
    objective="Add step metrics (JSONL then Parquet), throughput and MFU, memory peaks, loss-spike detection, the budget watchdog, and the `alphalytica-train` entrypoint that runs only under an AUTHORIZED experiment via the lab executor.",
    context="Training must be governed: the executor launches it, the budget stops it, and the run record captures everything.",
    deps=[69, 41],
    inspect=[TR + " (metrics, authority boundaries)"],
    scope=["`train/metrics.py`: JSONL writer, Parquet conversion, tokens/s, MFU via grit_physics peaks, memory via callbacks.", "`train/watchdog.py`: wall clock and FLOP budget checks per step; graceful stop with checkpoint and `FAILED(budget_exhausted)` status file.", "`train/cli.py`: `alphalytica-train --job JOB.json` reading configs and dataset refs by hash, writing only under the run prefix, emitting a run record draft; refuses if the job file lacks an authorization token signature from the lab executor (HMAC with per-job secret passed via environment by the executor).", "Integration test: lab authorizes tiny experiment → executor runs alphalytica-train → artifacts and run record persisted."],
    out=["GPU workers (P098)."],
    create={f"{A}/train/metrics.py": "metrics", f"{A}/train/watchdog.py": "budget watchdog", f"{A}/train/cli.py": "training entrypoint", f"{AT}/test_watchdog.py": "tests", "tests/integration/test_authorized_training_run.py": "lab-governed training integration test"},
    modify={"models/alphalytica/pyproject.toml": "console script alphalytica-train", f"{A}/train/loop.py": "metrics and watchdog hooks"},
    tests=["Tiny budget triggers graceful stop with checkpoint.", "Unauthorized job file refused.", "Spike detector flags a synthetic spike.", "MFU null when peak unknown."],
    verify=["uv run pytest models/alphalytica tests/integration/test_authorized_training_run.py -q", "make check"],
    acceptance=["A training run can't start without an AUTHORIZED experiment.", "Run record complete for the integration run."],
    complexity="L",
    review=["security"],
)

# ---------------- P: inference ----------------
prompt(
    71, "Inference provider interface and local PyTorch backend", "P", 6,
    objective="Add the `InferenceProvider` interface, `TorchLocalProvider` (checkpoint and tokenizer validation, sampling, deterministic greedy), and register it as a `grit_verify.providers` entry point satisfying `TextModel`.",
    context="Specifications/inference.md. The evaluator resolves providers by entry point from an artifact hash only.",
    deps=[69, 58],
    inspect=[INF],
    scope=["`infer/provider.py`: `SamplingConfig`, `GenerationResult`, `TokenEvent`, `InferenceProvider` protocol, typed errors.", "`infer/torch_local.py`: load by artifact hash, verify manifest, load safetensors, verify tokenizer hash, sample with per-request `torch.Generator`, temperature/top-k/top-p, stop strings; `score()` returns per-token logprobs.", "Entry point `grit_verify.providers: alphalytica = alphalytica.infer.torch_local:from_artifact`."],
    out=["KV cache (P072).", "Batching (P073)."],
    create={f"{A}/infer/__init__.py": "inference subpackage", f"{A}/infer/provider.py": "provider interface", f"{A}/infer/torch_local.py": "local PyTorch provider", f"{AT}/test_inference.py": "tests", "tests/integration/test_textmodel_protocol.py": "provider satisfies grit_verify TextModel via entry point"},
    modify={"models/alphalytica/pyproject.toml": "entry point registration"},
    tests=["Same seed → same tokens; temperature 0 → greedy.", "Wrong tokenizer hash → refused.", "Tampered checkpoint → IntegrityError.", "Entry point resolution from hash works in grit-eval."],
    verify=["uv run pytest models/alphalytica/tests/test_inference.py tests/integration/test_textmodel_protocol.py -q", "make check"],
    acceptance=["Provider usable by grit-eval selftest suite.", "No `torch.load` at inference."],
    complexity="M",
    review=["security"],
)

prompt(
    72, "KV cache, streaming, cancellation and context management", "P", 6,
    objective="Add KV-cache incremental decoding, streaming token events with correct incremental UTF-8 decoding, cooperative cancellation, and context truncation policies.",
    context="KV cache makes decoding O(T) per token instead of O(T²) recompute.",
    deps=[71],
    inspect=[INF + " (generation details)"],
    scope=["KV cache in `arch/layers.py` attention (optional `past_kv` argument), preallocated to ctx.", "`infer/streaming.py`: incremental decoder, `stream()`.", "`CancelToken`; truncation policy left/error."],
    out=["Paged attention, speculative decoding."],
    create={f"{A}/infer/streaming.py": "streaming", f"{AT}/test_kv_cache.py": "tests", f"{AT}/test_streaming.py": "tests"},
    modify={f"{A}/arch/layers.py": "optional KV cache path", f"{A}/infer/torch_local.py": "use cache; stream; cancel"},
    tests=["Cached logits equal full recompute within 1e-5 fp32 at every step for 64 steps, all attention variants.", "Emoji/CJK streaming reassembles exactly.", "Cancel after 5 tokens → finish_reason cancelled."],
    verify=["uv run pytest models/alphalytica -q", "make check"],
    acceptance=["Decode speedup ≥ 3x at 512 tokens on CPU (bench in report)."],
    complexity="M",
)

prompt(
    73, "Batch inference, memory accounting and resource limits", "P", 6,
    objective="Add padded batch generation with attention masks, pre-load memory estimation (weights plus KV cache), and configurable limits on batch size, prompt length and new tokens.",
    context="Refuse before allocating, not after crashing.",
    deps=[72, 42],
    inspect=[INF + " (KV cache formula, resource limits)"],
    scope=["`generate_batch` with left padding; per-sequence stop.", "`infer/limits.py`: `InferenceLimits`, `estimate_memory(cfg, batch, ctx, dtype)` using grit_physics; `ResourceLimitError`.", "Device memory introspection hooks (CUDA, MPS) passed to grit_physics as callbacks."],
    out=["Continuous batching servers."],
    create={f"{A}/infer/limits.py": "limits and memory estimate", f"{AT}/test_batching_limits.py": "tests"},
    modify={f"{A}/infer/torch_local.py": "batch generation and limits"},
    tests=["Greedy batch outputs equal individual outputs.", "Estimate within 30% of measured peak on CPU.", "Over-limit request refused before allocation."],
    verify=["uv run pytest models/alphalytica -q", "make check"],
    acceptance=["Limits enforced in provider, not only in the API."],
    complexity="M",
)

prompt(
    74, "Inference benchmark suite", "P", 6,
    objective="Add the inference benchmark suite measuring time to first token, tokens per second, end-to-end latency, peak memory, batch throughput, output consistency, quantization effects and cost per workload, writing Parquet results with hardware profiles.",
    context="Measurement-driven choices about backends and hardware.",
    deps=[73],
    inspect=[INF + " (benchmark suite)"],
    scope=["`benchmarks/inference/run.py` (`alphalytica-bench`): workload matrix (prompt 64/256/1024 × output 64/256 × batch 1/4/16/64), warmups, ≥ 30 reps, median/p95 with CIs; cross-backend consistency (CPU vs MPS when available); cost via price table.", "Results to `benchmarks/inference/results/<date>-<hardware>.parquet` + Markdown summary."],
    out=["Quantization adapters themselves (P075)."],
    create={"benchmarks/inference/run.py": "benchmark runner", "benchmarks/inference/README.md": "how to run and read results", f"{AT}/test_bench_runner.py": "runner smoke test on tiny model"},
    modify={"models/alphalytica/pyproject.toml": "console script alphalytica-bench"},
    tests=["Runner produces all metric columns for a tiny model in < 60 s."],
    verify=["uv run pytest models/alphalytica/tests/test_bench_runner.py -q", "uv run alphalytica-bench --model tiny --quick", "make check"],
    acceptance=["Results include hardware profile, code commit and model hash."],
    complexity="M",
    resources="CPU/MPS, laptop",
)

prompt(
    75, "Quantization adapters and Hugging Face-compatible export", "P", 6,
    objective="Add int8 dynamic and fp16/bf16 adapters with measured effects, and export of architectures that map onto a standard Hugging Face config (Llama-like) so llama.cpp, vLLM and SGLang can serve them without custom code.",
    context="Use standard engines only when the architecture fits them; never `trust_remote_code`.",
    deps=[74],
    inspect=[INF + " (providers, quantization)"],
    scope=["`infer/quantize.py`: adapters returning a provider.", "`infer/hf_export.py`: `export_hf(cfg, checkpoint, out)` when `cfg` is RoPE + RMSNorm + SwiGLU + no bias (Llama mapping) or learned-pos + LayerNorm + GELU (GPT-2 mapping); otherwise `UnsupportedExport`.", "Optional extra `hf` with `transformers` for the round-trip test.", "Benchmark suite gains quantization rows (Δ bpb with CI)."],
    out=["GGUF conversion tooling (document the llama.cpp command; don't vendor it)."],
    create={f"{A}/infer/quantize.py": "quantization adapters", f"{A}/infer/hf_export.py": "HF export", f"{AT}/test_quantize_export.py": "tests"},
    modify={"models/alphalytica/pyproject.toml": "optional hf extra", "benchmarks/inference/run.py": "quantization rows"},
    tests=["Exported Llama-mapped tiny model logits match native within 1e-4 via transformers (extra installed).", "Unsupported architecture refused clearly."],
    verify=["uv run --extra hf pytest models/alphalytica/tests/test_quantize_export.py -q", "make check"],
    acceptance=["Quantization never labeled lossless; Δ reported."],
    complexity="M",
)

prompt(
    76, "Authorized external API provider", "P", 6,
    objective="Add `ExternalApiProvider` for authorized commercial model APIs used as baselines: allowlisted hosts, keys from the secret store, per-request cost accounting, and a hard refusal to send protected benchmark items.",
    context="External APIs give reference points but can leak holdouts. Using one in an evaluation protocol requires human approval (security.md).",
    deps=[71, 56],
    inspect=[INF, "grit-engineering/specifications/security.md (external APIs, secrets)"],
    scope=["`infer/external_api.py`: generic HTTPS JSON provider with adapters configured in `configs/providers/*.toml` (host, model, pricing per token, rate limit); key via `keyring` or env var name (never value) from config.", "Refuse any request whose metadata carries a protected benchmark id.", "Tests use a local mock server (httpx MockTransport); no real network calls in CI."],
    out=["Specific vendor SDKs (plain HTTPS keeps dependencies small)."],
    create={f"{A}/infer/external_api.py": "external API provider", "configs/providers/README.md": "provider config format", f"{AT}/test_external_api.py": "tests with mock transport"},
    modify={"models/alphalytica/pyproject.toml": "add httpx and keyring"},
    tests=["Protected item refused.", "Non-allowlisted host refused.", "Cost recorded per request.", "Key never appears in logs or exceptions (test captures logs)."],
    verify=["uv run pytest models/alphalytica/tests/test_external_api.py -q", "make check"],
    acceptance=["No real API call in CI.", "Security review recorded."],
    complexity="M",
    review=["security", "human-approval"],
)

# ---------------- Q: evaluation suites ----------------
prompt(
    77, "Language modeling evaluation suite", "Q", 6,
    objective="Add the language modeling suite to `grit_verify.model_eval`: held-out loss, bits per byte, perplexity within tokenizer, per-domain breakdown, and bootstrap CIs over documents.",
    context="Bits per byte is the primary cross-model metric (ADR-0013). This suite runs only inside grit-eval.",
    deps=[58, 16, 17],
    inspect=[EV + " (metrics and statistics)"],
    scope=["`model_eval/lm.py`: `suite.lm` registered with the runner; consumes `TextModel` + `TokenizerLike` from provider; documents from holdout store; per-document nll and byte counts; CIs.", "Unigram and 3-gram Kneser-Ney baselines (`model_eval/ngram_baselines.py`) computed on the same split for context."],
    out=["Capability tasks (P078)."],
    create={f"{V}/model_eval/__init__.py": "model evaluation suites", f"{V}/model_eval/lm.py": "LM suite", f"{V}/model_eval/ngram_baselines.py": "n-gram baselines", f"{VT}/test_lm_suite.py": "tests with a deterministic fake TextModel"},
    modify={f"{V}/suites.py": "register lm suite"},
    tests=["Uniform byte model → bpb exactly 8.", "Fake model with known logprobs → exact nll.", "KN 3-gram beats unigram on fixture text."],
    verify=["uv run pytest packages/grit_verify -q", "make check"],
    acceptance=["Suite deterministic given model and data.", "No torch import in grit_verify."],
    complexity="M",
    review=["scientific"],
)

prompt(
    78, "Capability task suite", "Q", 6,
    objective="Add the capability suite: scores committed procedural benchmarks (copy, recall, arithmetic, structure, multi-hop, length generalization) per dimension of the capability taxonomy, returning a multi-dimensional profile, never one aggregate.",
    context="Tasks come from committed benchmark data (P056), not from generator code, so the evaluator doesn't depend on grit_cognition.",
    deps=[77],
    inspect=[EV + " (capability taxonomy)", "docs/registry/capability-taxonomy.toml"],
    scope=["`model_eval/capability.py`: exact-match scoring by generation (greedy) and by logprob ranking where tasks are multiple choice; per-dimension scores with CIs; length-generalization ratios.", "Taxonomy read as data (TOML), no grit_cognition import."],
    out=["Natural-language reasoning benchmarks requiring licenses (add as separate benchmarks through grit_data)."],
    create={f"{V}/model_eval/capability.py": "capability suite", f"{VT}/test_capability_suite.py": "tests"},
    modify={f"{V}/suites.py": "register capability suite"},
    tests=["Perfect fake model scores 1.0 on every dimension; random fake model near chance.", "Commitment verified before scoring; mismatch refuses."],
    verify=["uv run pytest packages/grit_verify -q", "make check"],
    acceptance=["Output is a profile keyed by taxonomy dimension with CIs."],
    complexity="M",
    review=["scientific"],
)

prompt(
    79, "Calibration, robustness, generalization and contamination suites", "Q", 6,
    objective="Add calibration (ECE, MCE, Brier decomposition on multiple-choice logprobs), robustness (deterministic perturbations), generalization (in-distribution vs OOD and length) and the pre-evaluation contamination check against the training dataset manifest.",
    context="Accuracy alone doesn't distinguish knowing from guessing or memorizing.",
    deps=[78],
    inspect=[EV],
    scope=["`model_eval/calibration_suite.py`, `model_eval/robustness.py` (whitespace, case, typo, distractor insertion; seeded), `model_eval/generalization.py`.", "Runner calls `contamination_report` before any suite when the protocol requests it; failure blocks evaluation."],
    out=["Adversarial attacks."],
    create={f"{V}/model_eval/calibration_suite.py": "calibration suite", f"{V}/model_eval/robustness.py": "robustness suite", f"{V}/model_eval/generalization.py": "generalization suite", f"{VT}/test_quality_suites.py": "tests"},
    modify={f"{V}/suites.py": "register suites", f"{V}/runner.py": "contamination gate"},
    tests=["Perturbations deterministic and label-preserving (checker verified).", "Contaminated fixture blocks evaluation.", "Calibrated fake model → ECE ≈ 0."],
    verify=["uv run pytest packages/grit_verify -q", "make check"],
    acceptance=["Contamination gate on by default in protocols."],
    complexity="M",
    review=["scientific"],
)

prompt(
    80, "Resource-normalized comparison, regression detection and evaluation reports", "Q", 6,
    objective="Add matched-params and matched-compute comparison tables, regression detection against verified baselines on every dimension, and signed evaluation reports, plus the `eval-lm-v1` protocol used by G0 and G1.",
    context="A run that improves the primary metric but regresses elsewhere must be flagged.",
    deps=[79, 55],
    inspect=[EV, "grit-engineering/specifications/compute-cost.md"],
    scope=["`model_eval/comparison.py`: tables with params, FLOPs, tokens, wall time, energy; Pareto data.", "`model_eval/regression.py`: per-dimension regression flags vs baseline golden metrics.", "`model_eval/report.py`: Markdown + JSON, included in the signed result.", "`configs/evaluation/eval-lm-v1.toml` (suites: lm, capability, calibration, robustness, generalization; contamination on)."],
    out=["Model cards (P112)."],
    create={f"{V}/model_eval/comparison.py": "comparisons", f"{V}/model_eval/regression.py": "regression detection", f"{V}/model_eval/report.py": "evaluation reports", "configs/evaluation/eval-lm-v1.toml": "standard LM evaluation protocol", f"{VT}/test_comparison_regression.py": "tests", "docs/milestones/evaluation-suites.md": "suite documentation"},
    modify={f"{V}/suites.py": "register"},
    tests=["Regression on a secondary dimension flagged even when primary improves.", "Protocol hash golden test."],
    verify=["uv run pytest packages/grit_verify -q", "make check"],
    acceptance=["eval-lm-v1 committed and its hash recorded in the registry."],
    complexity="M",
    review=["scientific"],
)

prompt(
    81, "Generation 0 end-to-end run, profiling and model card (milestone M6)", "O", 6,
    objective="Run Generation 0 for real under governance: choose and license-verify the corpus, process it, train the ~4.2M model on the laptop, verify resume, evaluate independently with eval-lm-v1, profile MPS vs CPU, and publish the reviewed model card.",
    context="G0 exit gate (model-research-plan.md): bit-identical resume, beats unigram and 3-gram KN on bpb, signed independent evaluation, reviewed model card. The MPS throughput measured here decides where G1 runs.",
    deps=[70, 75, 80, 64],
    inspect=[MRP + " (Generation 0)", DATA + " (candidate corpora)", "grit-engineering/specifications/compute-cost.md", "grit-engineering/checklists/scientific-review.md"],
    scope=[
        "Owner chooses the corpus; agent prepares the manifest with license evidence; **owner verifies the license** (human gate).",
        "Process with grit-data; train bpe4k tokenizer; write `experiments/model_research/ALPHA-G0-base.toml` with hypothesis, baseline (n-gram), budget (≤ 3 h wall), protocol eval-lm-v1.",
        "Reviewer and approver steps by humans; executor runs training; resume test on a mid-run checkpoint.",
        "Profiling: tokens/s over a 2-hour run on MPS (throttled steady state) and CPU; MFU where peak known; energy estimated.",
        "grit-eval evaluation; human review to VERIFIED; model card and dataset card from templates; report.",
    ],
    out=["Any G1 study.", "Rented GPUs."],
    create={"experiments/model_research/ALPHA-G0-base.toml": "G0 experiment spec", "datasets/manifests/g0-corpus-v1.toml": "G0 corpus manifest (owner-verified license)", "docs/models/alphalytica-g0@v1.md": "G0 model card", "docs/datasets/g0-corpus@v1.md": "G0 dataset card", "docs/milestones/M6.md": "Phase 6 milestone report with profiling results"},
    tests=["The experiment's acceptance criteria evaluated by grit-eval (signed).", "Resume identity on the real run's checkpoint (CPU)."],
    verify=["uv run grit lab status ALPHA-G0-base", "uv run grit-verify signature verify <signed-result>", "make check"],
    acceptance=["Experiment ARCHIVED with VERIFIED result or an honest RESULT_REJECTED and explanation.", "Model card contains measured results only.", "M6 states MPS tokens/s and the recommendation for G1 hardware."],
    complexity="XL",
    resources="Laptop MPS/CPU, ~3 h training plus processing",
    review=["human-approval", "scientific", "budget"],
)
