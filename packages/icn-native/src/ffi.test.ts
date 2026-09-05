import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FFIType } from "bun:ffi";
import {
  LLAMA_SYMBOLS,
  SHIM_SYMBOLS,
  SHIM_ABI_VERSION,
  resolveNativeLibraryPaths,
  sharedLibraryName,
} from "./ffi";

// These tests run without any native library or model present.

describe("FFI signature tables", () => {
  test("every symbol has an args array and a return type", () => {
    for (const table of [LLAMA_SYMBOLS, SHIM_SYMBOLS]) {
      for (const [name, sig] of Object.entries(table)) {
        expect(Array.isArray(sig.args), name).toBe(true);
        expect(typeof sig.returns, name).toBe("number");
        for (const a of sig.args) expect(typeof a, name).toBe("number");
      }
    }
  });

  test("struct-by-value entry points are only reached through the shim", () => {
    const direct = Object.keys(LLAMA_SYMBOLS);
    for (const forbidden of [
      "llama_model_load_from_file",
      "llama_init_from_model",
      "llama_decode",
      "llama_batch_get_one",
      "llama_model_default_params",
      "llama_context_default_params",
    ]) {
      expect(direct).not.toContain(forbidden);
    }
    expect(Object.keys(SHIM_SYMBOLS)).toEqual(
      expect.arrayContaining([
        "icn_model_load",
        "icn_context_new",
        "icn_decode_tokens",
        "icn_logits",
        "icn_sampler_chain_init",
        "icn_sampler_chain_build",
        "icn_chat_apply_template",
        "icn_backend_dev_count",
      ])
    );
    for (const forbidden of ["llama_sampler_chain_init", "llama_chat_apply_template"]) {
      expect(direct).not.toContain(forbidden);
    }
  });

  test("signatures match llama.h for the core tokenizer/decoder calls", () => {
    expect(LLAMA_SYMBOLS.llama_tokenize.args).toEqual([
      FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.bool, FFIType.bool,
    ]);
    expect(LLAMA_SYMBOLS.llama_tokenize.returns).toBe(FFIType.i32);
    expect(LLAMA_SYMBOLS.llama_token_to_piece.args).toHaveLength(6);
    expect(LLAMA_SYMBOLS.llama_get_logits_ith.returns).toBe(FFIType.ptr);
    expect(LLAMA_SYMBOLS.llama_model_n_params.returns).toBe(FFIType.u64);
    expect(LLAMA_SYMBOLS.llama_sampler_sample.args).toEqual([FFIType.ptr, FFIType.ptr, FFIType.i32]);
    expect(SHIM_SYMBOLS.icn_decode_tokens.args).toEqual([
      FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.bool,
    ]);
    expect(SHIM_ABI_VERSION).toBe(2);
  });
});

describe("library path resolution", () => {
  test("platform-specific shared library names", () => {
    expect(sharedLibraryName("llama", "linux")).toBe("libllama.so");
    expect(sharedLibraryName("llama", "darwin")).toBe("libllama.dylib");
    expect(sharedLibraryName("llama", "win32")).toBe("llama.dll");
  });

  test("MAGNITUDE_LLAMA_LIB_DIR takes precedence over build.json", () => {
    const paths = resolveNativeLibraryPaths(
      { MAGNITUDE_LLAMA_LIB_DIR: "/opt/llama/lib", MAGNITUDE_ICN_SHIM_LIB: "/opt/llama/lib/custom_shim.so" },
      "/nonexistent/build.json"
    );
    expect(paths.source).toBe("env");
    expect(paths.llamaLib).toBe(join("/opt/llama/lib", sharedLibraryName("llama")));
    expect(paths.shimLib).toBe("/opt/llama/lib/custom_shim.so");
  });

  test("falls back to build.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "icn-native-test-"));
    const manifest = join(dir, "build.json");
    writeFileSync(
      manifest,
      JSON.stringify({ version: 1, llamaLibDir: "/x", llamaLib: "/x/libllama.so", shimLib: "/y/libicn_shim.so" })
    );
    const paths = resolveNativeLibraryPaths({}, manifest);
    expect(paths).toEqual({ llamaLib: "/x/libllama.so", shimLib: "/y/libicn_shim.so", source: "build.json" });
  });

  test("throws a helpful error when nothing is configured", () => {
    expect(() => resolveNativeLibraryPaths({}, "/nonexistent/build.json")).toThrow(/build:native|MAGNITUDE_LLAMA_LIB_DIR/);
  });

  test("rejects unknown manifest versions", () => {
    const dir = mkdtempSync(join(tmpdir(), "icn-native-test-"));
    const manifest = join(dir, "build.json");
    writeFileSync(manifest, JSON.stringify({ version: 99 }));
    expect(() => resolveNativeLibraryPaths({}, manifest)).toThrow(/version/);
  });
});
