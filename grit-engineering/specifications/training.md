# Training Infrastructure Specification

PyTorch reference stack. Training lives in `alphalytica.train`, separate from model definitions (`alphalytica.arch`), data (`grit_data`) and evaluation (`grit_verify.model_eval`). Prompts P062 to P070 and P081.

## Separation of concerns

```
grit_data            alphalytica.arch        alphalytica.train            grit_verify.model_eval
manifests            ModelConfig             TrainingConfig               EvaluationProtocol
ingest, clean        build_model(cfg)        train(run_spec) -> RunRecord evaluate(request)
dedup, split         param_count(cfg)        checkpoint save/load         (separate process)
tokenize, pack                               metrics, budget watchdog
batch iterator
```

- `alphalytica.arch` knows nothing about optimizers, data or devices beyond `nn.Module`.
- `alphalytica.train` receives a model, an iterator of batches and a config. It doesn't know how data was made.
- `grit_data` has no torch dependency except the optional `grit_data.torch_iter` adapter that yields tensors.
- Evaluation never runs inside the training process. The training loop computes validation loss for monitoring only; that number is not evidence.

## Immutable, versioned configs

Configs are TOML files under `configs/{architecture,training,tokenization,evaluation}/`, loaded into frozen dataclasses, validated, and hashed with canonical JSON. A run references configs by hash. Changing a config means a new file (or a new version suffix), never an edit to one already used by a run. CI enforces this: `scripts/check_config_immutability.py` fails if a config file referenced by any run record in `experiments/` has changed.

```toml
# configs/training/g0-base-v1.toml
[optimizer]
name = "adamw"
lr = 1.0e-3
betas = [0.9, 0.95]
eps = 1.0e-8
weight_decay = 0.1

[schedule]
name = "warmup_cosine"
warmup_steps = 200
min_lr_ratio = 0.1

[loop]
max_steps = 20000
micro_batch_size = 32
grad_accum_steps = 4
seq_len = 256
grad_clip_norm = 1.0
precision = "fp32"        # fp32 | bf16 | fp16 (fp16 requires grad scaler)
eval_interval = 500
checkpoint_interval_steps = 1000
checkpoint_interval_minutes = 30

[seeds]
model_init = 1234
data_order = 5678
dropout = 91011
```

## Training loop contract

```python
def train(
    model: nn.Module,
    batches: ResumableBatchIterator,
    cfg: TrainingConfig,
    run: RunContext,            # run_id, artifact store handle, budget ledger, clock
    hooks: TrainingHooks = TrainingHooks(),
) -> RunRecord: ...
```

Requirements, each with a test in P068 to P070:

| Concern | Requirement | Test |
|---|---|---|
| Loss | Cross entropy over next token, mean over non-pad tokens | Matches manual log-softmax computation |
| Optimizer | AdamW; no weight decay on biases, norms, embeddings | Param groups inspected |
| Schedule | Linear warmup, cosine decay to `min_lr_ratio · lr` | Values at step 0, warmup end, max_steps |
| Gradient accumulation | Loss scaled by `1/grad_accum_steps` | Accum 4 × batch 8 ≡ accum 1 × batch 32 within 1e-6 (fp32, CPU) |
| Gradient clipping | Global norm clipping; pre-clip norm logged | Norm ≤ threshold after clip |
| Mixed precision | bf16 autocast on CUDA; fp16 with `GradScaler` optional; MPS defaults fp32, bf16 behind a flag after P081 measures it | Loss within tolerance of fp32 over 100 steps |
| Determinism | `torch.use_deterministic_algorithms(True)` on CPU runs; documented as best effort on MPS and CUDA | Two CPU runs → identical final params |
| Device | `select_device(preference) -> torch.device`: cuda > mps > cpu unless pinned | Unit test with mocked availability |
| Budget | Watchdog checks wall clock and estimated FLOPs every step; on breach: checkpoint, mark `FAILED(budget_exhausted)`, exit cleanly | Tiny budget triggers graceful stop |
| Interrupts | SIGINT/SIGTERM → checkpoint at next step boundary, exit 130/143 | Subprocess test sends SIGTERM |
| Loss spikes | Rolling z-score of loss > 6 → extra checkpoint + metric event | Synthetic spike detected |

## Checkpointing and resume

A checkpoint is a directory in the artifact store:

```
ckpt-<run_id>-step-<step>/
  model.safetensors          # weights only, no pickle
  optimizer.pt               # torch.save of optimizer + scheduler state dicts; loaded with weights_only=True
  rng.json                   # python random, numpy bit generator state, torch CPU/CUDA/MPS RNG states (base64)
  data_state.json            # sampler epoch, shard index, offset, data_order seed
  meta.json                  # step, tokens_seen, config hashes, code commit, wall time
  MANIFEST.sha256            # sha256 of every file above
```

Resume validates `MANIFEST.sha256`, checks that config hashes match the run's configs, restores every RNG, and continues. The resume test (P069): train 2N steps uninterrupted vs train N, checkpoint, new process resume, train N more; final parameters must match bit for bit on CPU and within 1e-6 relative on MPS.

## Run record (every run, no exceptions)

| Field | Source |
|---|---|
| `run_id` | ULID |
| `experiment_id`, `experiment_state_at_start` | must be `AUTHORIZED` |
| `model_architecture` | full `ModelConfig` + hash |
| `parameter_count` | analytical and measured (must match) |
| `dataset_id`, `dataset_version`, `dataset_hash` | grit_data manifest |
| `tokenizer_id`, `tokenizer_version`, `tokenizer_hash` | tokenizer artifact |
| `code_commit`, `code_dirty` | git; dirty tree allowed only for `DRAFT` dry runs |
| `seeds` | all seeds in config |
| `hyperparameters` | full `TrainingConfig` + hash |
| `hardware` | `grit_physics.detect_hardware()` |
| `started_at`, `ended_at`, `duration_s` | wall clock, UTC |
| `estimated_flops` | 6·N·tokens_seen (+ attention term) |
| `energy_j`, `energy_method` | measured (NVML) or estimated (TDP × utilization), labeled |
| `validation_metrics` | per eval interval (monitoring only) |
| `evaluation_results` | filled later by reference to signed results, never by the trainer |
| `checkpoint_ids` | artifact refs |
| `known_limitations` | free text, required, may say "none known" only with reviewer sign-off |
| `exit_status` | completed / failed(reason) / cancelled |

## Metrics and tracking

- Step metrics (loss, lr, grad norm pre-clip, tokens/s, step time, memory) → append-only JSONL in the run's artifact prefix, flushed every N steps; converted to Parquet at run end.
- Run-level summary → SQLite `runs` table.
- No third-party tracking service by default. An adapter for one can be added later if a real need appears; the JSONL format is the contract.
- MFU = achieved FLOPs/s ÷ peak FLOPs/s from `grit_physics.hardware_profiles`. If peak is unknown, MFU is `null`, not a guess.

## Authority boundaries

The training process:

- reads its config, dataset shards and tokenizer by hash;
- writes only under `artifacts/runs/<run_id>/`;
- holds a job token scoped to that run, expiring at the budget deadline;
- can't read holdout data (not mounted, no credentials), can't write evaluation results, can't change budgets, can't change experiment state except through the executor's reported exit status.

The model being trained has no tools, no network and no file access. Its outputs during training are tensors.

## Hardware strategy for training

| Workload | Where | Why |
|---|---|---|
| Unit tests, tiny overfit tests (≤ 100k params) | CPU in CI | Deterministic, free |
| G0 runs (4M) | MacBook Air MPS or CPU | Fits in memory, hours not days |
| G1 runs (10 to 50M) | MPS if measured ≤ 12 h/run; else one rented 24 GB GPU | Measure first |
| G2 runs (50 to 150M) | One rented 24 to 80 GB GPU | Memory and time |
| G3 run (~500M) | One rented 80 GB GPU (or 2 to 8 only if > 72 h on one) | Single GPU keeps the code simple |

Distributed data parallel is not built until a run needs it. When it does, it's a separate prompt with its own ADR.
