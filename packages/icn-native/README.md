# @magnitudedev/icn-native

First vertical slice of moving Magnitude's inference engine (`inference/`,
Rust) to TypeScript on Bun. This package binds llama.cpp's C API through
`bun:ffi`, loads a GGUF model, tokenizes, runs a decode loop with greedy
sampling, and detokenizes.

```ts
import { Model, Context } from "@magnitudedev/icn-native";

const model = Model.load("/path/to/model.gguf");
const ctx = new Context(model, { nCtx: 2048 });
for await (const { text } of ctx.generate("Hello", 64)) process.stdout.write(text);
ctx.free();
model.free();
```

## Building the native pieces

```sh
cd packages/icn-native
bun run build:native            # cmake libllama (10-20 min cold) + compile shim
bun run build:native -- --skip-llama   # recompile only the shim
```

`scripts/build-native.ts`:

1. Configures and builds the vendored llama.cpp at
   `inference/native/llama-cpp-rs/llama-cpp-sys-2/llama.cpp` as **shared**
   libraries, CPU-only (`-DBUILD_SHARED_LIBS=ON -DGGML_NATIVE=OFF`, tests,
   examples, tools, server and curl off) into `inference/target/llama-ffi`.
   Outputs (Linux): `bin/libllama.so`, `bin/libggml.so`, `bin/libggml-base.so`,
   `bin/libggml-cpu.so`. Override the build dir with `MAGNITUDE_LLAMA_BUILD_DIR`.
2. Compiles `native/shim.c` with `cc` into `native/libicn_shim.so`, linked
   against libllama with an rpath to the llama lib dir.
3. Writes `native/build.json` with the absolute paths. `src/ffi.ts` reads that
   at `dlopen` time; `MAGNITUDE_LLAMA_LIB_DIR` (and optionally
   `MAGNITUDE_ICN_SHIM_LIB`) override it for prebuilt/distributed libraries.

Only `cmake` and a C compiler are required; no Rust toolchain.

## Why a C shim

`bun:ffi` can pass pointers and scalars but **cannot pass or return structs by
value**. llama.cpp's most important entry points do exactly that:

- `llama_model_default_params()` / `llama_model_load_from_file(path, params)`
- `llama_context_default_params()` / `llama_init_from_model(model, params)`
- `llama_batch_get_one(...)` / `llama_batch_init(...)` / `llama_decode(ctx, batch)`

Re-creating those structs byte-for-byte in JS would tie us to one llama.cpp
commit's field layout and padding. Instead `native/shim.c` (about 150 lines)
exposes pointer/scalar wrappers (`icn_model_load`, `icn_context_new`,
`icn_decode_tokens`, `icn_logits`, `icn_sample_greedy`, ...) that call the
`*_default_params()` functions and set a handful of fields. Everything else
(tokenize, token_to_piece, detokenize, vocab queries, logits pointer, model
metadata, system info) is bound directly against libllama in `src/ffi.ts`.

The shim also puts the greedy argmax and the log-level filter in C, so the hot
loop does not copy `n_vocab` floats into JS per token and llama.cpp's info
logging does not flood stderr. `icn_shim_abi_version()` guards against a stale
shim binary.

## Layout

| File | Purpose |
| --- | --- |
| `native/shim.c` | struct-by-value wrappers, greedy argmax, logging |
| `scripts/build-native.ts` | cmake + cc driver, writes `native/build.json` |
| `src/ffi.ts` | `dlopen` symbol tables, path resolution, backend init |
| `src/model.ts` | `Model`: load/free, metadata, vocab, tokenize/detokenize |
| `src/context.ts` | `Context`: decode, logits, greedy sample, `generate()` |
| `src/system.ts` | `systemInfo()`, `supportsGpuOffload()` |

Memory: `Model` and `Context` own raw pointers; call `free()` (or use `using`
via `Symbol.dispose`). A `FinalizationRegistry` frees leaked handles on GC as a
safety net, but do not rely on it for multi-GB models. All native buffers
passed to C are JS typed arrays kept alive for the duration of the call; the
logits pointer is copied out immediately via `toArrayBuffer(...).slice()`.

## Tests

```sh
bun test                                            # unit tests, no model needed
MAGNITUDE_TEST_GGUF=/path/to/model.gguf bun test    # + integration
```

Tests use `bun test` rather than vitest because `bun:ffi` only exists in the
Bun runtime. The integration suite loads the model, tokenizes "Hello",
generates 8 tokens greedily, checks the streamed text against `detokenize()`
of the same ids, and verifies determinism after `reset()`.

## Covered

- CPU backend, shared-library build of the vendored llama.cpp
- Model load/free (`n_gpu_layers`, `load_mode`, `vocab_only`), metadata
- Vocab: n_tokens, BOS/EOS, EOG check, tokenize, token_to_piece, detokenize
- Context create/free, `n_ctx`/`n_batch`, KV clear, chunked prompt decode
- Logits access, greedy sampling, streaming UTF-8-safe `generate()`
- Sampler chain (temp / top-k / top-p / penalties + sample/accept)
- `llama_chat_apply_template` for built-in named templates
- Backend device enumeration (`ggml_backend_dev_*` via shim)

## Not yet covered

- Grammars / GBNF, DRY, mirostat, and reasoning-budget sampler stages
- KV cache / state save and restore, sequence copy/shift, multi-sequence batching
- Continuous batching and parallel requests
- Embeddings / pooling output
- Multimodal (mtmd), speculative decoding, full Jinja `CommonChatTemplates`
- GPU backends (CUDA, Metal, Vulkan) and `GGML_BACKEND_DL` dynamic backends;
  the shim calls `ggml_backend_load_all()` so dynamic backends will register
  once built
- Prebuilt native artifacts / packaging; macOS and Windows have untested paths
  in the build script
- Progress callbacks and abort callbacks (would need `JSCallback`)
