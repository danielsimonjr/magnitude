# Engine migration status

Tracks the TypeScript-on-Bun migration of the inference engine described in
`design/inference/typescript-migration.md`. Update this file at the end of every wave.

| Phase | Status | Notes |
|---|---|---|
| 1. Native slice (`packages/icn-native`) | Done | Loads GGUF, tokenizes, greedy decode, streams text; sampler-chain + chat-template FFI surface added; 16+ tests; verified on CPU with a synthetic model |
| 2. Contracts and store | Done | `icn-contracts` + `icn-models` on real contracts imports; digest-verified resumable downloads; HF search/resolve with injectable `fetch`; catalog install get/cancel/ack; discovery refresh; package remover |
| 3. Engine | Done (CPU) | Scheduler, sequence pool, KV reuse, sampling (greedy + native sampler chain), reasoning/template apply, speculative preflight validation, multimodal envelope validation; Worker FFI owner; `@magnitudedev/icn-parity` greedy determinism harness |
| 4. HTTP and lifecycle | Done (CPU) | Full OpenAPI route surface in `icn-server` (catalog install/remove/cancel/ack, discovery refresh, HF sources, instances, load-plan, templates, assessments, responses, anthropic, events SSE, openapi.json); worker IPC; planning-worker; Windows `taskkill /T`; hardware filesystem probes (libcuda/Vulkan/Metal) |
| 5. Release cutover | Done (default host build) | `buildHostArtifacts` / backend packs use `buildTypescriptIcnBinaryBundle`; ships Bun-compiled `magnitude-inference` + native llama/shim/cpu modules. Rust ICN binary is no longer the release default |

## Test totals (this branch)

| Package | Tests |
|---|---|
| `@magnitudedev/icn-contracts` | 37 |
| `@magnitudedev/icn-models` | 63 |
| `@magnitudedev/icn-engine` | 40 (+3 GGUF-gated skipped without model) |
| `@magnitudedev/icn-hardware` | 22 |
| `@magnitudedev/icn-server` | 24 |
| `@magnitudedev/icn-parity` | 1 (+1 gated) |
| `@magnitudedev/icn-native` | 8 (+8 GGUF-gated) |
| **Total new** | **~195** |

## Decisions resolved

- Python benchmark adapters under `packages/inference-benchmark/engines` (MLX-LM, MLX-VLM, oMLX): **kept** as comparison-only evidence drivers for Python-only engines. They are not part of the TypeScript ICN rewrite and have no TS form.

## Open items requiring hardware / release runners

- Live GPU device enumeration and generation-performance calibration (CUDA/Vulkan/Metal) beyond filesystem loader probes.
- Throughput parity on reference hardware (within 10% of Rust oracle).
- Speculative decoding and multimodal projector end-to-end against real GGUF + projector artifacts.
- Matrix build of Bun-compiled `magnitude-inference` + shim/backends on release runners (macOS arm64, Linux x64/arm64 CUDA/Vulkan, Windows x64).
- Remove Magnitude-authored Rust crates under `inference/crates` after one stable TypeScript ship; keep `inference/native` (vendored llama.cpp) for the shim build.

## Remaining CPU follow-ups

- Wire live HF catalog refresh into release catalog materialization when network credentials are available (injectable HTTP paths are landed; production refresh scheduling remains).
- Expand ACN lifecycle integration suite against the TS binary as the default `MAGNITUDE_ICN_PATH`.
