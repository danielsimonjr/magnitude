/**
 * Low-level bun:ffi binding for libllama plus the icn C shim.
 *
 * Two libraries are opened:
 *   - libllama: every llama.cpp entry point whose signature only uses
 *     pointers and scalars is bound directly here.
 *   - libicn_shim: wrappers for entry points that take/return structs by
 *     value (model/context params, llama_batch), which bun:ffi cannot express.
 *
 * Nothing in this module allocates native state; see model.ts / context.ts.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dlopen, FFIType, type Pointer } from "bun:ffi";

export type { Pointer } from "bun:ffi";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_JSON_PATH = join(PACKAGE_ROOT, "native", "build.json");

// ---------------------------------------------------------------------------
// Library path resolution
// ---------------------------------------------------------------------------

export interface NativeLibraryPaths {
  readonly llamaLib: string;
  readonly shimLib: string;
  readonly source: "env" | "build.json";
}

interface BuildManifest {
  readonly version: number;
  readonly llamaLibDir: string;
  readonly llamaLib: string;
  readonly shimLib: string;
}

export const sharedLibraryName = (
  base: string,
  platform: NodeJS.Platform = process.platform
): string => {
  switch (platform) {
    case "darwin":
      return `lib${base}.dylib`;
    case "win32":
      return `${base}.dll`;
    default:
      return `lib${base}.so`;
  }
};

/**
 * Resolve where libllama and libicn_shim live.
 *
 * Precedence:
 *   1. `MAGNITUDE_LLAMA_LIB_DIR` (libllama there; shim from
 *      `MAGNITUDE_ICN_SHIM_LIB` if set, else the same dir, else the
 *      package's native/ dir).
 *   2. native/build.json written by scripts/build-native.ts.
 */
export const resolveNativeLibraryPaths = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  buildJsonPath: string = BUILD_JSON_PATH
): NativeLibraryPaths => {
  const libDir = env.MAGNITUDE_LLAMA_LIB_DIR?.trim();
  if (libDir) {
    const llamaLib = join(libDir, sharedLibraryName("llama"));
    const shimName = sharedLibraryName("icn_shim");
    const explicitShim = env.MAGNITUDE_ICN_SHIM_LIB?.trim();
    const shimCandidates = [join(libDir, shimName), join(PACKAGE_ROOT, "native", shimName)];
    const shimLib = explicitShim || (shimCandidates.find((c) => existsSync(c)) ?? shimCandidates[0]!);
    return { llamaLib, shimLib, source: "env" };
  }
  if (!existsSync(buildJsonPath)) {
    throw new Error(
      `icn-native: no native build manifest at ${buildJsonPath}. ` +
        "Run `bun run build:native` in packages/icn-native or set MAGNITUDE_LLAMA_LIB_DIR."
    );
  }
  const manifest = JSON.parse(readFileSync(buildJsonPath, "utf8")) as BuildManifest;
  if (manifest.version !== 1) {
    throw new Error(`icn-native: unsupported build.json version ${manifest.version}`);
  }
  return { llamaLib: manifest.llamaLib, shimLib: manifest.shimLib, source: "build.json" };
};

// ---------------------------------------------------------------------------
// Symbol tables
// ---------------------------------------------------------------------------

/** llama.cpp entry points that are pointer/scalar-only and bound directly. */
export const LLAMA_SYMBOLS = {
  llama_backend_init: { args: [], returns: FFIType.void },
  llama_backend_free: { args: [], returns: FFIType.void },
  llama_model_free: { args: [FFIType.ptr], returns: FFIType.void },
  llama_model_get_vocab: { args: [FFIType.ptr], returns: FFIType.ptr },
  llama_model_desc: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  llama_model_n_params: { args: [FFIType.ptr], returns: FFIType.u64 },
  llama_model_size: { args: [FFIType.ptr], returns: FFIType.u64 },
  llama_model_n_ctx_train: { args: [FFIType.ptr], returns: FFIType.i32 },
  llama_model_n_embd: { args: [FFIType.ptr], returns: FFIType.i32 },
  llama_free: { args: [FFIType.ptr], returns: FFIType.void },
  llama_n_ctx: { args: [FFIType.ptr], returns: FFIType.u32 },
  llama_n_batch: { args: [FFIType.ptr], returns: FFIType.u32 },
  llama_get_logits_ith: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.ptr },
  llama_vocab_n_tokens: { args: [FFIType.ptr], returns: FFIType.i32 },
  llama_vocab_is_eog: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.bool },
  llama_vocab_bos: { args: [FFIType.ptr], returns: FFIType.i32 },
  llama_vocab_eos: { args: [FFIType.ptr], returns: FFIType.i32 },
  llama_vocab_get_add_bos: { args: [FFIType.ptr], returns: FFIType.bool },
  // (vocab, text, text_len, tokens*, n_tokens_max, add_special, parse_special)
  llama_tokenize: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.bool, FFIType.bool],
    returns: FFIType.i32,
  },
  // (vocab, token, buf*, length, lstrip, special)
  llama_token_to_piece: {
    args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.bool],
    returns: FFIType.i32,
  },
  // (vocab, tokens*, n_tokens, text*, text_len_max, remove_special, unparse_special)
  llama_detokenize: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.bool, FFIType.bool],
    returns: FFIType.i32,
  },
  llama_supports_gpu_offload: { args: [], returns: FFIType.bool },
  llama_print_system_info: { args: [], returns: FFIType.cstring },
} as const;

/** icn shim entry points (see native/shim.c). */
export const SHIM_SYMBOLS = {
  icn_shim_abi_version: { args: [], returns: FFIType.u32 },
  icn_backend_init: { args: [], returns: FFIType.void },
  icn_backend_free: { args: [], returns: FFIType.void },
  icn_log_set_min_level: { args: [FFIType.i32], returns: FFIType.void },
  // (path, n_gpu_layers, load_mode, vocab_only)
  icn_model_load: { args: [FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.bool], returns: FFIType.ptr },
  // (model, n_ctx, n_batch, n_threads, n_threads_batch, embeddings)
  icn_context_new: {
    args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.i32, FFIType.i32, FFIType.bool],
    returns: FFIType.ptr,
  },
  // (ctx, tokens*, n_tokens, pos0, seq_id, logits_last_only)
  icn_decode_tokens: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.bool],
    returns: FFIType.i32,
  },
  icn_decode_simple: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  icn_logits: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.ptr },
  icn_memory_clear: { args: [FFIType.ptr, FFIType.bool], returns: FFIType.void },
  icn_memory_seq_rm: { args: [FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.bool },
  icn_sample_greedy: { args: [FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
} as const;

export const SHIM_ABI_VERSION = 1;

export type LlamaSymbols = ReturnType<typeof dlopen<typeof LLAMA_SYMBOLS>>["symbols"];
export type ShimSymbols = ReturnType<typeof dlopen<typeof SHIM_SYMBOLS>>["symbols"];

export interface NativeLibraries {
  readonly paths: NativeLibraryPaths;
  readonly llama: LlamaSymbols;
  readonly shim: ShimSymbols;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

let loaded: NativeLibraries | undefined;
let backendInitialized = false;

/**
 * dlopen both libraries once and return the symbol tables. Also initializes
 * the ggml/llama backend on first call. Idempotent.
 */
export const loadNative = (): NativeLibraries => {
  if (loaded) return loaded;
  const paths = resolveNativeLibraryPaths();
  for (const p of [paths.llamaLib, paths.shimLib]) {
    if (!existsSync(p)) {
      throw new Error(`icn-native: native library not found: ${p} (resolved from ${paths.source})`);
    }
  }
  // libllama first so its ggml dependencies are resolved before the shim,
  // which links against it.
  const llama = dlopen(paths.llamaLib, LLAMA_SYMBOLS).symbols;
  const shim = dlopen(paths.shimLib, SHIM_SYMBOLS).symbols;
  const abi = shim.icn_shim_abi_version();
  if (abi !== SHIM_ABI_VERSION) {
    throw new Error(`icn-native: shim ABI mismatch (have ${abi}, expected ${SHIM_ABI_VERSION}); rebuild native`);
  }
  if (!backendInitialized) {
    const level = Number(process.env.MAGNITUDE_LLAMA_LOG_LEVEL ?? "3");
    shim.icn_log_set_min_level(Number.isFinite(level) ? level : 3);
    shim.icn_backend_init();
    backendInitialized = true;
  }
  loaded = { paths, llama, shim };
  return loaded;
};

/** True when a pointer returned from native code is NULL. */
export const isNullPointer = (p: Pointer | null | undefined): p is null | undefined =>
  p === null || p === undefined || (p as unknown as number) === 0;

/** Encode a JS string as a NUL-terminated UTF-8 buffer for `const char *` args. */
export const cstr = (text: string): Uint8Array => {
  const bytes = Buffer.from(text, "utf8");
  const out = new Uint8Array(bytes.byteLength + 1);
  out.set(bytes);
  return out;
};
