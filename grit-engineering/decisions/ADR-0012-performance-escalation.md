# ADR-0012: Profile before native code or kernels

Status: proposed · Date: 2026-11-25

## Decision
C++, Rust, Julia, custom CUDA or Triton kernels are admitted only when (1) a profile shows a hot spot taking > 50% of a workload that matters, (2) a vectorized NumPy/SciPy/PyTorch rewrite was tried and recorded, and (3) the expected speedup is > 5x. The readable reference implementation stays, and the optimized one is tested against it for numerical agreement with a documented tolerance.
