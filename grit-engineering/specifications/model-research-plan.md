# Alphalytica Experimental Model Program: Research Plan

The program exists to answer questions about architecture, learning efficiency, generalization, representation and compute cost under controlled conditions. It's a ladder of four generations. Each rung has an exit gate, and nobody climbs to the next rung without passing it.

The ~500M parameter Generation 3 model is a target that the evidence may or may not justify. If Generation 2 shows that the questions worth asking can be answered at 150M, Generation 3 doesn't happen, and that's a fine outcome.

## Ground rules

1. **One change at a time.** Each architecture study varies one component against the standard baseline. No model combines several new components until each has been shown to help on its own, and then the combination is its own experiment with its own hypothesis.
2. **Every change gets a hypothesis, a baseline, an evaluation plan and documented results.** That's enforced by `grit_lab`: no `ExperimentSpec` without those fields reaches `AUTHORIZED`.
3. **Matched comparisons.** Every study reports both a parameter-matched comparison (same non-embedding parameter count within 2%) and a compute-matched comparison (same training FLOPs within 5%).
4. **Seeds.** At least 3 seeds per arm for Generation 1, at least 2 for Generation 2 where cost forces it. Report mean, per-seed values and a 95% bootstrap CI. A difference smaller than the seed-to-seed spread is reported as "no detectable difference," not as a win.
5. **Tokenizer-independent metrics.** Primary metric is validation bits per byte, which stays comparable across tokenizers. Perplexity only within one tokenizer.
6. **No capability assumptions.** A model's capabilities are whatever the independent evaluation measures. Nothing in model cards, reports or the UI asserts reasoning or intelligence beyond measured results on named suites.

## Generation 0: minimal baseline

Goal: a transparent, reproducible, end-to-end pipeline. The model is almost incidental.

| Item | Specification |
|---|---|
| Architecture | Decoder-only Transformer, pre-LayerNorm, learned absolute positions, multi-head attention via `F.scaled_dot_product_attention`, GELU MLP (4x), tied input/output embeddings |
| Size | `n_layer=4, d_model=256, n_head=4, d_ff=1024, vocab=4096, ctx=256` → 12·4·256² + 4096·256 ≈ 3.15M + 1.05M ≈ **4.2M** parameters (exact count asserted in tests) |
| Tokenizer | Byte-level reference tokenizer (vocab 256) for pipeline tests; byte-level BPE with 4,096 merges for the run |
| Data | ~50 to 200M tokens of a licensed English corpus (candidates and license gate in [data.md](data.md)) |
| Init | `N(0, 0.02)`; residual projections scaled by `1/√(2·n_layer)` (GPT-2) |
| Optimizer | AdamW β=(0.9, 0.95), wd=0.1 on matrices only, peak lr 1e-3, 200-step warmup, cosine to 10% |
| Hardware | MacBook Air M-series 16 GB, MPS or CPU |
| Budget | ≤ 3 hours wall clock per run; estimated 6 · 4.2e6 · 1e8 ≈ 2.5e15 FLOPs per 100M tokens |
| Exit gate | (a) Resume-from-checkpoint reproduces an uninterrupted CPU run bit for bit; (b) val bits per byte beats a unigram baseline and a 3-gram Kneser-Ney baseline on the same split; (c) independent evaluation signed; (d) model card reviewed |

## Generation 1: controlled architecture studies

Goal: learn which standard components matter at small scale, with honest error bars. Baseline is the Generation 0 architecture scaled up.

| Item | Specification |
|---|---|
| Baseline size | `n_layer=8, d_model=512, n_head=8, d_ff=2048, vocab=16384, ctx=512` → 25.2M + 8.4M ≈ **33.6M** |
| Range | 10 to 50M parameters (a small sweep at 3 sizes supports scaling-trend claims) |
| Data | 0.5 to 1B tokens (≈ 20 tokens per parameter at 33.6M is 0.67B) |
| Hardware | MPS if P081 profiling shows ≤ 12 h per run; otherwise a single rented GPU (Profile 3) |

Studies (each its own experiment, each against the same baseline, each with param-matched and compute-matched arms):

| Study | Arms | Hypothesis template | Primary metric |
|---|---|---|---|
| S1 Attention | MHA, GQA (n_kv=2), MQA | GQA matches MHA val bpb within seed noise while cutting KV-cache memory by n_head/n_kv | val bpb; KV memory at ctx 512 |
| S2 Position | learned absolute, RoPE, ALiBi, NoPE | RoPE or ALiBi improves length extrapolation to 2x ctx without hurting in-ctx bpb | val bpb at ctx and 2x ctx |
| S3 Normalization | LayerNorm vs RMSNorm; pre vs post | RMSNorm matches LayerNorm bpb at lower step time; post-LN shows more instability at lr 1e-3 | val bpb; divergence count; step time |
| S4 Feedforward | GELU MLP (4x) vs SwiGLU (hidden 8/3·d to match params) | SwiGLU improves bpb at matched params | val bpb |
| S5 Size trend | 3 sizes of the winning-or-baseline config | Loss follows a power law in N over this range | fitted exponent with CI |

Exit gate: every study's report is `VERIFIED`; a written synthesis states which components showed a detectable effect, at what size, with what confidence. A "Generation 2 baseline config" is chosen from that evidence, and the choice is reviewed.

## Generation 2: larger experimental baselines

Goal: check whether Generation 1 findings hold at 3x to 5x the size, and make training reliable at a scale where runs cost real money.

| Item | Specification |
|---|---|
| Size | 50 to 150M. Reference config `n_layer=12, d_model=768, n_head=12, vocab=32768, ctx=1024` ≈ 85M + 25M ≈ **110M** |
| Data | 2 to 3B tokens, deduplicated, multi-source with per-source licenses |
| Hardware | Single rented GPU (24 to 80 GB). No multi-GPU until a run needs > 48 h on one GPU |
| Reliability | Checkpoint every 30 min wall clock; automatic resume; loss-spike detection (rolling z-score > 6 triggers checkpoint + alert, not automatic rollback) |
| Profiling | Tokens/s, MFU, peak memory, data loader stall fraction recorded per run |
| Studies | Re-run the 1 or 2 Generation 1 findings with the largest effect; optional alternative-architecture study (below) |
| Exit gate | (a) Gen 1 findings confirmed or refuted with CIs; (b) measured MFU and $/run on the chosen hardware; (c) scaling fit across Gen 0 to Gen 2 with CIs that predicts Gen 3 loss; (d) human go/no-go for Generation 3 |

## Generation 3: Alphalytica research model (~500M)

Goal: a documented, independently evaluated research model, if and only if Generation 2 shows the scale is worth it.

| Item | Specification |
|---|---|
| Reference size | `n_layer=24, d_model=1280, n_head=20 (head dim 64), d_ff=SwiGLU 3,413 (8/3·d) or MLP 5,120, vocab=32768, ctx=2048` → 12·24·1280² ≈ 472M + 41.9M ≈ **514M** with the MLP variant. Exact architecture chosen from Gen 1/2 evidence |
| Data | ~10B tokens (≈ 20 tokens per parameter); exact count from the Gen 2 scaling fit |
| Compute | 6 · 5.14e8 · 1e10 ≈ **3.1e19 FLOPs** |
| Single-GPU feasibility | Training state at mixed precision with AdamW ≈ 16 bytes/param ≈ 8.2 GB, plus activations; fits one 40 to 80 GB GPU with activation checkpointing as needed. At 312 TFLOP/s peak bf16 and 40% MFU (125 TFLOP/s), ≈ 2.5e5 s ≈ **69 GPU-hours**. MFU is an assumption to be replaced by the Gen 2 measurement |
| Cost | GPU-hours × configured price. At an illustrative $2/GPU-hour, ≈ $140 plus overhead for evaluation, failed runs and storage; budget 3x for safety. Real price comes from `prices.toml` at authorization time |
| Deliverables | Architecture specification, exact parameter count, resource and cost estimate, training report, signed independent evaluation across all capability dimensions, model card, dataset card, reproducibility bundle |
| What it is not | A frontier model. Expect fluent short text and measurable gains on small procedural tasks. Expect weak multi-step reasoning. The evaluation reports what it measures |

P103 produces the Generation 3 specification and go/no-go package without training anything. P104 (training) is conditional on a human approving that package.

## Alternative architecture research (separate, controlled)

Each is a separate experiment against the matched Transformer baseline at Generation 1 or 2 size. None enters the Generation 3 design without a verified win.

| Family | Variant to implement first | Hypothesis | Extra measurements |
|---|---|---|---|
| Mixture of experts | Top-2 routing over 8 expert MLPs, Switch-style load balancing loss | At matched active parameters, MoE lowers bpb; at matched total parameters it doesn't | Expert utilization entropy, routing collapse rate |
| State-space models | Diagonal linear recurrence (S4D-style) blocks replacing attention in all or alternating layers | Matches Transformer bpb at ctx 512 and degrades less on 4x length | Throughput vs sequence length |
| Recurrent | LSTM language model at matched params | Transformer wins on bpb at matched compute (expected; a sanity baseline) | Step time |
| Alternative attention | Sliding window (local) attention | Little bpb loss at ctx 512 with window 128 | Memory vs ctx |
| Hierarchical | Byte-level model with a patching layer (two-level) | Byte-level hierarchical models close the gap to BPE at matched compute | bpb only (tokenizer-free) |

These are listed in P102, gated on human review of a written proposal per family. The order of investigation is the owner's choice.

## Experiment specification template (model studies)

```toml
[experiment]
id = "ALPHA-G1-S2-position"
question = "Does the choice of positional representation change validation bits per byte or length extrapolation at 34M parameters?"
hypothesis = "RoPE improves bpb at 2x training context by at least 0.02 over learned absolute positions, with no in-context bpb loss larger than 0.005."
methodology = "4 arms x 3 seeds; identical data order per seed; param-matched within 2%; compute-matched within 5%."
baseline = "ALPHA-G1-baseline@verified"
evaluation_protocol = "eval-lm-v1"   # frozen, hashed at authorization

[budget]
gpu_hours = 0
wall_hours = 48
est_flops = 2.4e17
cost_usd = 0

[acceptance]
primary_metric = "val_bpb"
min_effect = 0.02
alpha = 0.05
correction = "holm"
```

## Risks and how the plan handles them

| Risk | Mitigation |
|---|---|
| MPS kernels slow or numerically different from CUDA | Measure in P081; CPU is the determinism reference; cross-backend consistency test in P074 |
| Seed noise swamps architecture effects at small scale | 3+ seeds, report "no detectable difference" honestly; power analysis before Gen 1 using Gen 0 seed variance |
| License problems in training data | License gate blocks; dataset card required; human verification per source |
| Benchmark contamination | Procedurally generated tasks committed before training; 13-gram overlap check on every eval set |
| Cost overrun on rented GPUs | Hard budget in the job bundle; self-terminating worker; ledger alerts at 50/80/100% |
| Overclaiming | Model cards list measured results only; reviewer checklist includes a claims audit |
