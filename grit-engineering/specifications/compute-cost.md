# Compute and Cost Estimation Framework

Formulas first, prices as inputs. The tool is `grit-cost` (P042), built on `grit_physics`. Every estimate prints its assumptions and labels itself `estimated`.

## Parameter count

For a decoder-only Transformer with `L` layers, width `d`, vocabulary `V`, MLP hidden `d_ff`, tied embeddings, no biases:

```
attention per layer   = 4·d²                       (Q, K, V, O; MHA)
                      = 2·d² + 2·d·(n_kv·d_head)   (GQA/MQA)
mlp per layer         = 2·d·d_ff                   (GELU MLP)
                      = 3·d·d_ff                   (SwiGLU)
norms per layer       = 2·d (LayerNorm: ×2 with bias)
embeddings            = V·d (+ ctx·d for learned positions)
total ≈ L·(4d² + 2·d·d_ff) + V·d  =  12·L·d² + V·d  when d_ff = 4d
```

The analytical count must equal `sum(p.numel() for p in model.parameters())` exactly; P059 tests this for every config in `configs/architecture/`.

| Config | L | d | V | d_ff | Params |
|---|---|---|---|---|---|
| G0 | 4 | 256 | 4,096 | 1,024 | ≈ 4.2M |
| G1 baseline | 8 | 512 | 16,384 | 2,048 | ≈ 33.6M |
| G2 reference | 12 | 768 | 32,768 | 3,072 | ≈ 110M |
| G3 reference | 24 | 1,280 | 32,768 | 5,120 | ≈ 514M |

## FLOPs

```
training FLOPs  C ≈ 6·N·D            (N non-embedding params, D tokens; Kaplan et al. 2020)
  + attention term 6·L·T·d per token  (T = context; matters when T > ~d)
inference FLOPs per generated token ≈ 2·N + 2·L·T·d
```

| Run | N | D | C |
|---|---|---|---|
| G0 | 4.2e6 | 1e8 | 2.5e15 |
| G1 baseline (20 tok/param) | 3.4e7 | 6.7e8 | 1.4e17 |
| G2 reference | 1.1e8 | 2.2e9 | 1.5e18 |
| G3 reference | 5.1e8 | 1.0e10 | 3.1e19 |

## Time

```
time_s = C / (peak_flops(hardware, dtype) · MFU)
```

`peak_flops` comes from a reviewed table (`configs/hardware_peaks.toml`, each row citing the vendor datasheet). `MFU` is a measured input once available; until then, the tool requires `--assume-mfu` and prints it in the output.

Illustration only (assumed MFU, unverified peaks):

| Run | Hardware | Assumed effective FLOP/s | Time |
|---|---|---|---|
| G0 | M-series GPU via MPS, fp32 | 0.5 to 1 TFLOP/s | 0.7 to 1.4 h |
| G1 | same | 0.5 to 1 TFLOP/s | 39 to 78 h → rent a GPU |
| G1 | 1× 24 GB GPU, bf16 | ~40 TFLOP/s | ~1 h |
| G2 | 1× A100 80 GB, bf16 | ~125 TFLOP/s (40% of 312) | ~3.3 h |
| G3 | 1× A100 80 GB, bf16 | ~125 TFLOP/s | ~69 h |

The G1-on-MPS row is why P081 measures before the plan commits. If measured MPS throughput is higher than assumed, G1 may stay local.

## Memory

```
training_state_bytes ≈ N · (4 weights + 4 grads + 8 Adam moments)          fp32:      16 B/param
                     ≈ N · (2 weights + 4 master + 2 grads + 8 Adam)        mixed bf16: 16 B/param
activations ≈ L · B · T · d · (≈ 34 + 5·n_head·T/d) · bytes / (checkpointing factor)   (Korthikanti et al. 2022)
inference_bytes ≈ N · bytes_per_param + KV cache (2·L·n_kv·d_head·T·B·bytes)
```

## Cost

```
cost = gpu_hours · price_per_gpu_hour + storage_gb_month · price_storage + egress_gb · price_egress
gpu_hours = time_s / 3600 · n_gpus · (1 + overhead_fraction)       overhead default 0.25 (setup, eval, failures)
```

`configs/prices.toml` (user maintained, dated; the tool warns if older than 30 days):

```toml
as_of = "2026-11-25"
currency = "USD"

[gpu."a100-80gb"]
price_per_hour = 0.0     # fill in from your provider; the tool refuses to estimate with 0 unless --allow-zero
[gpu."rtx-4090-24gb"]
price_per_hour = 0.0
[storage]
price_per_gb_month = 0.0
[egress]
price_per_gb = 0.0
```

## Energy

```
energy_j ≈ time_s · n_gpus · avg_power_w        (measured via NVML when available)
         ≈ time_s · n_gpus · TDP_w · utilization (estimated; labeled)
```

## CLI

```bash
grit-cost params --config configs/architecture/g3-ref-v1.toml
grit-cost estimate --config configs/architecture/g3-ref-v1.toml --tokens 10e9 --hardware a100-80gb --assume-mfu 0.4 --prices configs/prices.toml
grit-cost sweep --configs configs/architecture/g1-*.toml --tokens-per-param 20 --hardware m2-mps --assume-mfu 0.2
```

Output is a table plus a JSON blob with every input, every assumption, and `method: "estimated"`, ready to paste into an `ExperimentSpec` budget justification.

## Using estimates in governance

An approver sees the estimate and its assumptions when authorizing. The authorized budget is the estimate × a safety factor the approver chooses (default 1.5). The budget watchdog enforces the authorized number, not the estimate. After the run, the report shows estimate vs actual, which calibrates the next estimate (and the MFU assumption).
