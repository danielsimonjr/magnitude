# Engine migration status

Tracks the TypeScript-on-Bun migration of the inference engine described in
`design/inference/typescript-migration.md`. Update this file at the end of every wave.

| Phase | Status | Notes |
|---|---|---|
| 1. Native slice (`packages/icn-native`) | Done | Loads GGUF, tokenizes, greedy decode, streams text; 16 tests; verified on CPU with a synthetic model |
| 2. Contracts and store | Not started | Fully verifiable without GPU hardware |
| 3. Engine | In progress | `packages/icn-engine` scheduler, sequence pool, KV reuse types, sampling config, reasoning resolution (CPU-verifiable); native FFI stubs for sampling, speculative, multimodal, worker isolation |
| 4. HTTP and lifecycle | Not started | HTTP contract and ACN integration verifiable here |
| 5. Release cutover | Not started | Needs release runners |

## Open items requiring hardware

- Metal, CUDA, Vulkan backend loading from Bun; memory-domain accounting.
- Throughput parity on reference hardware.
- Production-model behavior: chat templates, grammars, speculative decoding, multimodal.
- Windows worker supervision; first Windows release build.

## Decisions pending

- Python benchmark adapters under `packages/inference-benchmark/engines` (MLX-LM, MLX-VLM, oMLX):
  owner: the inference migration integrator before phase 5. Keep them only if the 8 comparison
  experiments remain part of the documented benchmark evidence after the TypeScript parity harness
  lands; otherwise remove the adapters and those experiments together.
