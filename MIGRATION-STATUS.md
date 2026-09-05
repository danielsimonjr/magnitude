# Engine migration status

Tracks the TypeScript-on-Bun migration of the inference engine described in
`design/inference/typescript-migration.md`. Update this file at the end of every wave.

| Phase | Status | Notes |
|---|---|---|
| 1. Native slice (`packages/icn-native`) | Done | Loads GGUF, tokenizes, greedy decode, streams text; 16 tests; verified on CPU with a synthetic model |
| 2. Contracts and store | In progress | `icn-contracts` (37 tests) + `icn-models` on real `@magnitudedev/icn-contracts` imports (51 tests, `ManagedModelDownloads` + digest-verified resumable downloads with mocked HTTP); HF network paths mocked |
| 3. Engine | In progress | `packages/icn-engine` scheduler, sequence pool, KV reuse, sampling config, reasoning resolution (33 CPU tests, 3 GGUF-gated); greedy native sampling + `createInProcessInferenceSession` / `spawnInferenceWorker` with MessageChannel token streams wired; speculative/multimodal remain stubbed |
| 4. HTTP and lifecycle | In progress | `packages/icn-server` (bootstrap, Bun HTTP, auth, fake completions, catalog/discovery/installations/instances routes via `icn-models`, worker IPC with `--fake`/`--local-engine`, memory supervisor, CLI, minimal `planning-worker` via planner-bundle, Windows `taskkill /F /T /PID`); `packages/icn-hardware` memory policy, CPU-side capacity summary, memory-domain snapshot building, calibration record validation, and typed GPU probe stubs (19 CPU tests); inference/chat/responses/HF/install routes still 501; ACN lifecycle integration pending |
| 5. Release cutover | In progress | Host/backend release builds compile Bun `magnitude-inference` via `buildTypescriptIcnBinaryBundle` and package llama/shim/cpu backends from the icn-native cmake build. `inference/` is retained for native llama.cpp + shim sources (Rust crates superseded). Full runner matrix and one stable TS ship still required before deleting Rust crates. |

## Test totals (this branch)

| Package | Tests |
|---|---|
| `@magnitudedev/icn-contracts` | 37 |
| `@magnitudedev/icn-models` | 51 |
| `@magnitudedev/icn-engine` | 33 (+3 GGUF-gated) |
| `@magnitudedev/icn-hardware` | 19 |
| `@magnitudedev/icn-server` | 23 |
| **Total new** | **163** |

## Open items requiring hardware

- Native llama.cpp device discovery, bounded synthetic calibration measurement, and generation-performance estimation.
- Metal, CUDA, Vulkan backend loading from Bun; live GPU memory probes beyond typed absent stubs.
- Throughput parity on reference hardware.
- Production-model behavior: chat templates, grammars, speculative decoding, multimodal.
- First Windows release build on release runners.
- Matrix build of Bun-compiled `magnitude-inference` + shim/backends on release runners.

## Open items (CPU-verifiable, unfinished)

- Complete HF-backed catalog refresh and release catalog materialization.
- Connect engine sampling/chat-template paths to `@magnitudedev/icn-native` and add CPU token-for-token parity harness (greedy generation + worker protocol landed; full sampler chain and chat templates remain).
- Port remaining OpenAPI management routes (install/remove/HF/chat templates/responses), real GGUF worker subprocess, and ACN integration suite against the TS engine. TS server exposes length-prefixed JSON worker IPC (`--fake` / `--local-engine`) aligned with Rust framing; planning-worker speaks Initialize/Assess with stub calibration.
- Wire `packages/icn-server` hardware routes to `packages/icn-hardware` snapshot/calibration helpers and native backend discovery when Bun backends land.
- After one stable TypeScript ICN release on the runner matrix, remove the Rust `inference/crates` workspace (keep `inference/native` and cmake sources).

## Decisions

- Python benchmark adapters under `packages/inference-benchmark/engines` (MLX-LM, MLX-VLM, oMLX):
  **KEEP** for MLX comparison. They drive Python-only engines that have no TypeScript form and remain
  part of the documented benchmark evidence alongside the TypeScript parity harness.
