# Engine migration status

Tracks the TypeScript-on-Bun migration of the inference engine described in
`design/inference/typescript-migration.md`. Update this file at the end of every wave.

| Phase | Status | Notes |
|---|---|---|
| 1. Native slice (`packages/icn-native`) | Done | Loads GGUF, tokenizes, greedy decode, streams text; 16 tests; verified on CPU with a synthetic model |
| 2. Contracts and store | In progress | `icn-contracts` (37 tests) + `icn-models` store/catalog/discovery (46 tests); models still uses `_contracts-shim` pending import cutover; HF network paths mocked |
| 3. Engine | In progress | `packages/icn-engine` scheduler, sequence pool, KV reuse, sampling config, reasoning resolution (28 CPU tests); native FFI stubs for sampling, speculative, multimodal, worker isolation |
| 4. HTTP and lifecycle | Not started | HTTP contract and ACN integration verifiable here |
| 5. Release cutover | Not started | Needs release runners |

## Open items requiring hardware

- Metal, CUDA, Vulkan backend loading from Bun; memory-domain accounting.
- Throughput parity on reference hardware.
- Production-model behavior: chat templates, grammars, speculative decoding, multimodal.
- Windows worker supervision; first Windows release build.

## Open items (CPU-verifiable, unfinished)

- Wire `icn-models` to `@magnitudedev/icn-contracts` and delete `_contracts-shim`.
- Complete HF-backed catalog refresh, release catalog materialization, and `ManagedModelDownloads`.
- Connect engine sampling/chat-template paths to `@magnitudedev/icn-native` and add CPU token-for-token parity harness.
- Implement Bun Worker FFI owner (`spawnInferenceWorker`) with MessageChannel token streams.
- Port `packages/icn-server` (OpenAPI HTTP, bootstrap, worker supervision, memory supervisor).
- Port `packages/icn-hardware` calibration/capacity summary (partially hardware-gated).
- Release scripts for Bun-compiled executable + shim (phase 5).

## Decisions pending

- Python benchmark adapters under `packages/inference-benchmark/engines` (MLX-LM, MLX-VLM, oMLX):
  owner: the inference migration integrator before phase 5. Keep them only if the 8 comparison
  experiments remain part of the documented benchmark evidence after the TypeScript parity harness
  lands; otherwise remove the adapters and those experiments together.
