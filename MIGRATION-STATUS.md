# Engine migration status

Tracks the TypeScript-on-Bun migration of the inference engine described in
`design/inference/typescript-migration.md`. Update this file at the end of every wave.

| Phase | Status | Notes |
|---|---|---|
| 1. Native slice (`packages/icn-native`) | Done | Loads GGUF, tokenizes, greedy decode, streams text; 16 tests; verified on CPU with a synthetic model |
| 2. Contracts and store | In progress | `icn-contracts` (37 tests) + `icn-models` store/catalog/discovery (46 tests); models still uses `_contracts-shim` pending import cutover; HF network paths mocked |
| 3. Engine | In progress | `packages/icn-engine` scheduler, sequence pool, KV reuse, sampling config, reasoning resolution (28 CPU tests); native FFI stubs for sampling, speculative, multimodal, worker isolation |
| 4. HTTP and lifecycle | In progress | `packages/icn-server` (bootstrap, Bun HTTP, auth, fake completions, worker/memory stubs, CLI) + `packages/icn-hardware` memory policy (6 CPU tests); catalog/instance/HF routes stubbed; ACN lifecycle integration pending |
| 5. Release cutover | Scaffolded | `packages/release/scripts/build/icn-typescript.ts` compiles TS ICN to `bin/magnitude-inference-ts`; default host build still uses Rust. Needs release runners + one stable TS ship before Rust removal |

## Test totals (this branch)

| Package | Tests |
|---|---|
| `@magnitudedev/icn-contracts` | 37 |
| `@magnitudedev/icn-models` | 46 |
| `@magnitudedev/icn-engine` | 28 |
| `@magnitudedev/icn-hardware` | 6 |
| `@magnitudedev/icn-server` | 12 |
| **Total new** | **129** |

## Open items requiring hardware

- Metal, CUDA, Vulkan backend loading from Bun; memory-domain accounting.
- Throughput parity on reference hardware.
- Production-model behavior: chat templates, grammars, speculative decoding, multimodal.
- Windows worker supervision; first Windows release build.
- Matrix build of Bun-compiled `magnitude-inference` + shim/backends on release runners.

## Open items (CPU-verifiable, unfinished)

- Wire `icn-models` to `@magnitudedev/icn-contracts` and delete `_contracts-shim`.
- Complete HF-backed catalog refresh, release catalog materialization, and `ManagedModelDownloads`.
- Connect engine sampling/chat-template paths to `@magnitudedev/icn-native` and add CPU token-for-token parity harness.
- Implement Bun Worker FFI owner (`spawnInferenceWorker`) with MessageChannel token streams.
- Port remaining OpenAPI management routes, real worker IPC, and ACN integration suite against the TS engine.
- Expand `packages/icn-hardware` calibration/capacity summary beyond memory thresholds.
- Switch `buildHostArtifacts` from Rust `buildIcnBinary` to `buildTypescriptIcnBinary` after one stable TS release; then remove the Rust workspace.

## Decisions pending

- Python benchmark adapters under `packages/inference-benchmark/engines` (MLX-LM, MLX-VLM, oMLX):
  owner: the inference migration integrator before phase 5. Keep them only if the 8 comparison
  experiments remain part of the documented benchmark evidence after the TypeScript parity harness
  lands; otherwise remove the adapters and those experiments together.
