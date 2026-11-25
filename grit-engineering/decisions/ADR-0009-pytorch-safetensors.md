# ADR-0009: PyTorch as the reference framework; safetensors for weights

Status: proposed · Date: 2026-11-25

## Decision
PyTorch for model definition, training and reference inference, on CPU, MPS and CUDA. Weights are saved with safetensors. Optimizer state uses `torch.save` and is loaded only with `weights_only=True`. No `trust_remote_code`, ever. MLX is an optional backend behind a measured trigger (P117). JAX is not adopted.

## Why
Widest hardware support including Apple Silicon, largest ecosystem, readable reference code. safetensors removes code execution on load.

## Exit
Architectures are plain `nn.Module`s with no framework magic, so porting a reference implementation is mechanical.
