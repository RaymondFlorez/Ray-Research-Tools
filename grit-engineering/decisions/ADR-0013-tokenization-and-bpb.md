# ADR-0013: Byte-level reference tokenizer, byte-level BPE, bits per byte

Status: proposed · Date: 2026-11-25

## Decision
`grit_data.tokenizers` provides a byte-level tokenizer (vocab 256 + specials) as the always-correct reference, and byte-level BPE trained with Hugging Face `tokenizers` for real runs. Tokenizers are trained on the train split only and versioned by hash. The primary cross-model metric is bits per byte, which is comparable across tokenizers; perplexity is reported only within one tokenizer.
