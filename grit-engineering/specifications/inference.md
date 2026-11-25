# Inference Infrastructure Specification

A small provider interface with one local implementation first. Prompts P071 to P076, P117.

## Interfaces

Two layers of protocol:

1. `grit_verify.protocols.TextModel`: the minimum the independent evaluator needs. Owned by the evaluator.
2. `alphalytica.infer.InferenceProvider`: the richer interface applications use. Every provider also satisfies `TextModel`.

```python
@dataclass(frozen=True, slots=True)
class SamplingConfig:
    max_new_tokens: int = 256
    temperature: float = 1.0        # 0.0 means greedy
    top_k: int | None = None
    top_p: float | None = None
    seed: int | None = None
    stop: tuple[str, ...] = ()

@dataclass(frozen=True, slots=True)
class GenerationResult:
    text: str
    tokens: tuple[int, ...]
    finish_reason: Literal["stop", "length", "cancelled", "error"]
    timings: Timings              # ttft_s, total_s, tokens_per_s
    model: ModelMetadata          # model_id, version, artifact_hash, tokenizer_hash

class InferenceProvider(Protocol):
    def metadata(self) -> ModelMetadata: ...
    def generate(self, prompt: str, cfg: SamplingConfig, cancel: CancelToken | None = None) -> GenerationResult: ...
    def stream(self, prompt: str, cfg: SamplingConfig, cancel: CancelToken | None = None) -> Iterator[TokenEvent]: ...
    def score(self, texts: Sequence[str]) -> Sequence[TokenLogprobs]: ...
    def generate_batch(self, prompts: Sequence[str], cfg: SamplingConfig) -> Sequence[GenerationResult]: ...
```

## Providers

| Provider | When | Prompt | Notes |
|---|---|---|---|
| `TorchLocalProvider` | Default for Alphalytica checkpoints on CPU/MPS/CUDA | P071 to P073 | Reference implementation. KV cache, streaming, cancellation, batching |
| `HfExportedProvider` | When an Alphalytica architecture maps onto a standard HF config (e.g. RoPE + RMSNorm + SwiGLU ≈ Llama) | P075 | Enables llama.cpp (GGUF conversion), vLLM and SGLang without custom kernels |
| `ExternalApiProvider` | Authorized commercial APIs for baselines and comparisons | P076 | Allowlisted hosts; key from secret store; per-request cost accounting; never sends protected holdout items (enforced) |
| `MlxProvider` | Only if profiling shows MPS far below MLX | P117 (conditional) | |
| vLLM / SGLang servers | Only for a deployed multi-user inference service with measured load | not scheduled | Profile 4+ |

Simplest backend per workload: a 4M or 34M model on a laptop needs nothing beyond `TorchLocalProvider`. Distributed inference engines aren't part of the plan for any size in this program.

## Loading and validation

1. Resolve model by `model_id@version` in the registry → artifact hash.
2. Verify the checkpoint `MANIFEST.sha256`; refuse on mismatch.
3. Load weights from safetensors only. `torch.load` is used only for optimizer state, never at inference, and always with `weights_only=True`.
4. Load tokenizer by hash; assert it matches the checkpoint's recorded tokenizer hash.
5. Estimate memory before allocation: `params × bytes_per_param + kv_cache_bytes(batch, ctx)`; refuse with `ResourceLimitError` if it exceeds the configured limit.

## Generation details

| Concern | Requirement | Test |
|---|---|---|
| Sampling | Temperature, top-k, top-p, seeded `torch.Generator` per request | Same seed → same tokens; temperature 0 → greedy |
| KV cache | Per-layer K/V tensors preallocated to `ctx`; incremental decode | Logits with cache equal full recompute within 1e-5 (fp32) |
| Context management | Prompt longer than `ctx − max_new_tokens` → truncate from the left by default, configurable to error | Both policies tested |
| Streaming | `stream()` yields `TokenEvent(token_id, text_delta, index)`; text deltas assembled with incremental UTF-8 decoding so multi-byte chars aren't split | Emoji and CJK round trip |
| Cancellation | `CancelToken` checked every decode step; returns `finish_reason="cancelled"` with partial output | Cancel after 5 tokens |
| Batching | Left padding + attention mask; per-sequence stop handling | Batch outputs equal individual outputs (greedy) |
| Errors | Typed: `ModelNotFound`, `IntegrityError`, `ResourceLimitError`, `InvalidSamplingConfig` | One test each |
| Resource limits | max batch, max new tokens, max prompt tokens, max concurrent requests (API layer) | Limits enforced |

KV cache size: `2 · n_layer · n_kv_head · head_dim · ctx · batch · bytes`. For Generation 3 (24 layers, 20 heads × 64, ctx 2048, fp16): 2·24·1280·2048·2 B ≈ 252 MB per sequence with MHA. GQA with 4 KV heads cuts that 5x. This formula lives in `grit_physics.compute_accounting` and is reused by the memory check.

## Quantization

Adapters, measured, never assumed lossless:

- `int8` dynamic quantization of linear layers (`torch.ao.quantization.quantize_dynamic`) for CPU.
- `fp16` / `bf16` weight casting.
- GGUF quantization levels via llama.cpp, only for HF-exportable architectures.

Each adapter's effect is reported by the benchmark suite as Δ val bpb and Δ task accuracy vs the fp32 reference, with CIs.

## Inference benchmark suite (P074)

| Metric | Method |
|---|---|
| Time to first token | Wall time from request to first token event; median and p95 over ≥ 30 runs after 3 warmups |
| Tokens per second | Decode tokens ÷ decode time (excludes prefill) |
| End-to-end latency | Request to final token, by prompt length (64, 256, 1024) and output length (64, 256) |
| Peak memory | CUDA `max_memory_allocated`; MPS `driver_allocated_memory`; CPU RSS delta |
| Batch throughput | Total tokens/s at batch 1, 4, 16, 64 (until memory limit) |
| Output consistency | Greedy outputs identical across 10 repeats; cross-backend (CPU vs MPS) token agreement rate |
| Quantization effects | Δ bpb and Δ task accuracy per adapter |
| Cost per workload | (measured time × configured $/hour) ÷ requests, or API price × tokens for external providers |

Results go to Parquet under `benchmarks/inference/<date>-<hardware>/` with the hardware profile and code commit, and feed the Inference Benchmarking workspace.

## Observability and authentication

- Library calls emit no logs; they return `Timings`. The API layer logs request id, model id, token counts, timings and finish reason. It never logs prompt or output text by default (configurable per workspace, off in production).
- API inference endpoints require an authenticated principal with `model:infer` on that model. Experimental (unverified) models are invisible to users without `model:experimental` permission.
- Model outputs are untrusted data: rendered as text, never as HTML, never executed, never used as file paths or commands.
