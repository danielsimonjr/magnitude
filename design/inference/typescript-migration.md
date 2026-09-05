---
applies_to:
  - packages/icn-native/**
  - inference/**
  - packages/icn/**
  - packages/icn-protocol/**
---

# Inference engine migration to TypeScript on Bun

Magnitude's inference engine (ICN) is a Rust workspace of thirteen crates over a vendored
llama.cpp fork. This document defines how it becomes a TypeScript program running on Bun while the
product keeps shipping, and what must stay native.

## Goal and non-goals

The goal is one language and one runtime for every Magnitude-authored component: the ICN's HTTP
protocols, model store, catalog, hardware calibration, assessment, scheduler, and process lifecycle
become TypeScript packages executed by Bun.

llama.cpp itself is not rewritten. It is a third-party C/C++ library that implements model
execution and GPU backends; Magnitude reaches it through a thin C shim and `bun:ffi`. The Python
benchmark adapters under `packages/inference-benchmark/engines` are likewise out of scope: they
exist only to drive Python-only engines (MLX) for comparison and have no TypeScript form.

## Boundary that does not move

The contract other components depend on is the generated wire boundary in
`@magnitudedev/icn-protocol` (bootstrap records and the OpenAPI HTTP API), consumed through the
lifecycle manager in `@magnitudedev/icn`. The TypeScript engine implements that same OpenAPI
document and bootstrap protocol. ACN, SDK, and clients do not change; the release system swaps the
`bin/magnitude-inference` executable for a Bun-compiled one when the TypeScript engine reaches
parity.

Design documents under `design/inference` and `design/icn` remain normative for the TypeScript
engine. Where this document is silent, they govern.

## Native surface

```text
TypeScript (Bun)
  packages/icn-native ── bun:ffi ──> libicn_shim (C)
                                        └── libllama / libggml* (vendored llama.cpp)
                                            └── ggml backends loaded at runtime (cpu, metal, cuda, vulkan)
```

- `packages/icn-native` owns every FFI declaration. No other package calls `bun:ffi`.
- The C shim exists because `bun:ffi` cannot pass or return structs by value; llama.cpp's params
  and batch types are passed by value. The shim exposes pointer-only wrappers that build the
  default param structs internally. It is authored under `packages/icn-native/native` and is the
  only Magnitude-authored non-TypeScript code that remains, together with the existing
  `wrapper_common_*` glue that exposes llama.cpp's C++ `common/` helpers (chat templates, grammar
  triggers, sampling chains, speculative helpers) as C functions.
- Native handles are wrapped in classes with explicit `free()`; a `FinalizationRegistry` is a
  safety net, never the primary release path. Handle use after free throws.
- Backend modules keep their current packaging (dynamic ggml backends per pack) and are loaded with
  `ggml_backend_load` from the installation's `backends/` directory, preserving the release
  artifact contract in `design/release/distribution.md`.

## Concurrency model

The Rust engine serializes all native access on one executor thread per resident model. Bun
provides the same shape with a dedicated `Worker` per inference worker process:

- The persistent ICN process (Bun) hosts the HTTP surface and model store, exactly as the Rust
  persistent ICN does today, and spawns one disposable inference worker process per resident
  model (`Bun.spawn` of the same executable in worker mode), keeping the crash-isolation and
  memory-reclamation guarantees of `design/inference/engine.md`.
- Inside the worker, one `Worker` thread owns all FFI calls; `llama_decode` blocks that thread
  only. Requests and results cross the thread boundary as structured messages; token streams flow
  through `MessageChannel`.
- Bounded command and result queues, cancellation before admission and sampling, and the executor
  iteration order from `design/inference/scheduler.md` are preserved verbatim.

## Package plan

| Rust crate | TypeScript home | Notes |
|---|---|---|
| llama-cpp-2, llama-cpp-sys-2 | `packages/icn-native` | FFI bindings and C shim |
| icn-contracts | `packages/icn-contracts` | Effect Schema mirrors of the wire and internal contracts; generated OpenAPI stays the source of truth |
| icn-engine, icn-speculative, icn-reasoning | `packages/icn-engine` | scheduler, sequence pool, KV reuse, sampling, speculative decoding, reasoning detection |
| icn-models, icn-catalog | `packages/icn-models` | store filesystem, downloads (digest-verified, resumable), catalog lock, discovery, assessment cache |
| icn-hardware | `packages/icn-hardware` | calibration, capacity summary, memory domains |
| icn-api | `packages/icn-server` | Bun HTTP server implementing the OpenAPI routes, bearer auth, SSE and WebSocket protocols |
| icn-server | `packages/icn-server` | process lifecycle, worker supervision, memory supervisor, backend eligibility, CUDA driver probe |
| icn-parity, icn-parity-probe, benchmark-runner | `packages/icn-parity` | parity harness reused to prove the TypeScript engine against the Rust engine |

## Phases and exit criteria

1. **Native slice.** `packages/icn-native` loads a GGUF model, tokenizes, decodes greedily, and
   detokenizes through the shim, with tests. Exit: integration test generates text from a real
   model on CPU.
2. **Contracts and store.** Schemas, model store, downloads, catalog, discovery. Exit: the
   TypeScript store passes the Rust store's behavioral tests translated to vitest against the same
   fixtures.
3. **Engine.** Scheduler, batching, sampling chains, KV reuse, grammars, speculative decoding,
   multimodal projector. Exit: token-for-token parity with the Rust engine under greedy sampling
   on the parity corpus, and throughput within 10% on the reference hardware.
4. **HTTP and lifecycle.** Full OpenAPI implementation, bootstrap records, worker processes,
   memory supervisor. Exit: `@magnitudedev/icn` lifecycle tests and the ACN integration suite pass
   against the TypeScript engine with no client changes.
5. **Release cutover.** `packages/release` builds the Bun-compiled executable and the shim library
   for every host and backend pack; the Rust workspace is removed once the released TypeScript
   engine has shipped one stable version.

Until phase 5, the Rust engine remains the shipped engine and the TypeScript engine is selected only
through `MAGNITUDE_ICN_PATH` for development and parity runs.

## Risks

- **FFI call overhead** is per call, not per token in the hot path: one `llama_decode` per batch
  and one logits read per sequence. Sampling chains run inside llama.cpp, not in TypeScript.
- **Struct layouts** are hidden behind the shim, so llama.cpp upgrades change only C code.
- **GPU backends** depend on dynamic loading working identically from a Bun process; the shim
  initializes ggml before any model load, mirroring the Rust worker.
- **Windows** worker supervision uses the existing process-group tooling in
  `@magnitudedev/acn-protocol/coordination` (job-object semantics via taskkill /T) rather than
  reimplementing Win32 job objects.
