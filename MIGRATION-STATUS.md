# Engine migration status

Tracks the TypeScript-on-Bun migration of the inference engine described in
`design/inference/typescript-migration.md`. Update this file at the end of every wave.

| Phase | Status | Notes |
|---|---|---|
| 1. Native slice (`packages/icn-native`) | Done | Loads GGUF, tokenizes, greedy decode, streams text; 16 tests; verified on CPU with a synthetic model |
| 2. Contracts and store | In progress | `icn-contracts` (37 tests) + `icn-models` on real `@magnitudedev/icn-contracts` imports (51 tests, `ManagedModelDownloads` + digest-verified resumable downloads with mocked HTTP); HF network paths mocked |
| 3. Engine | In progress | `packages/icn-engine` scheduler, sequence pool, KV reuse, sampling config, reasoning resolution (33 CPU tests, 3 GGUF-gated); greedy native sampling + `createInProcessInferenceSession` / `spawnInferenceWorker` with MessageChannel token streams wired; speculative/multimodal remain stubbed |
| 4. HTTP and lifecycle | In progress | `packages/icn-server` (bootstrap, Bun HTTP, auth, fake completions, catalog/discovery/installations/instances routes via `icn-models`, worker IPC with `--fake`/`--local-engine`, memory supervisor, CLI) + `packages/icn-hardware` memory policy, CPU-side capacity summary, memory-domain snapshot building, calibration record validation, and typed GPU probe stubs (19 CPU tests); inference/chat/responses/HF/install routes still 501; ACN lifecycle integration pending |
| 5. Release cutover | Scaffolded | `packages/release/scripts/build/icn-typescript.ts` compiles TS ICN to `bin/magnitude-inference-ts`; default host build still uses Rust. Needs release runners + one stable TS ship before Rust removal |

## Test totals (this branch)

| Package | Tests |
|---|---|
| `@magnitudedev/icn-contracts` | 37 |
| `@magnitudedev/icn-models` | 51 |
| `@magnitudedev/icn-engine` | 33 (+3 GGUF-gated) |
| `@magnitudedev/icn-hardware` | 19 |
| `@magnitudedev/icn-server` | 20 |
| **Total new** | **160** |

## Open items requiring hardware

- Native llama.cpp device discovery, bounded synthetic calibration measurement, and generation-performance estimation.
- Metal, CUDA, Vulkan backend loading from Bun; live GPU memory probes beyond typed absent stubs.
- Throughput parity on reference hardware.
- Production-model behavior: chat templates, grammars, speculative decoding, multimodal.
- Windows worker supervision; first Windows release build.
- Matrix build of Bun-compiled `magnitude-inference` + shim/backends on release runners.

## Open items (CPU-verifiable, unfinished)

- Complete HF-backed catalog refresh and release catalog materialization.
- Connect engine sampling/chat-template paths to `@magnitudedev/icn-native` and add CPU token-for-token parity harness (greedy generation + worker protocol landed; full sampler chain and chat templates remain).
- Port remaining OpenAPI management routes (install/remove/HF/chat templates/responses), real GGUF worker subprocess, and ACN integration suite against the TS engine. TS server exposes length-prefixed JSON worker IPC (`--fake` / `--local-engine`) aligned with Rust framing.
- Wire `packages/icn-server` hardware routes to `packages/icn-hardware` snapshot/calibration helpers and native backend discovery when Bun backends land.
- Switch `buildHostArtifacts` from Rust `buildIcnBinary` to `buildTypescriptIcnBinary` after one stable TS release; then remove the Rust workspace.

## Decisions pending

- Python benchmark adapters under `packages/inference-benchmark/engines` (MLX-LM, MLX-VLM, oMLX):
  owner: the inference migration integrator before phase 5. Keep them only if the 8 comparison
  experiments remain part of the documented benchmark evidence after the TypeScript parity harness
  lands; otherwise remove the adapters and those experiments together.
